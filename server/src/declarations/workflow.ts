import type { Request } from 'express';
import { one, query, tx } from '../db.js';
import { audit } from '../audit.js';
import { fail } from '../errors.js';
import * as D from './repo.js';
import { buildCusdec, declarationId } from '../tvinn/edifact.js';
import * as Q from '../tvinn/queue.js';

/**
 * Submit → approve (queued and sent) or return, with four eyes (phase 2d).
 * A version freezes exactly what was submitted; the declaration cannot change until it comes back
 * (returned, recalled or rejected by TVINN).
 */
const str = (v: unknown) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim());
const fourEyes = async () => (await one<{ value: any }>("SELECT value FROM app_settings WHERE key = 'four_eyes'"))?.value !== false;
const declarantOrgNo = async () => String((await one<{ value: any }>("SELECT value FROM app_settings WHERE key = 'declarant'"))?.value?.orgNo ?? '').replace(/\D/g, '');
const sequenceOf = (declNo: string) => Number(String(declNo).replace(/^.*-/, '')) || 1;

async function requireDecl(id: string) {
  const d = await one('SELECT * FROM declaration WHERE id = $1', [id]);
  if (!d) fail(404, 'Fant ikke deklarasjonen.');
  return d!;
}
const latestVersion = (id: string) => one('SELECT * FROM declaration_version WHERE declaration_id = $1 ORDER BY version_no DESC LIMIT 1', [id]);

/** Submit for approval: no errors, every AI review point cleared; the snapshot is what the approver and TVINN get. */
export async function submit(req: Request, id: string, version?: unknown) {
  const d = await requireDecl(id);
  if (!['DRAFT', 'RETURNED', 'REJECTED'].includes(d.status)) fail(409, `Deklarasjonen har status ${d.status} og kan ikke sendes til godkjenning.`, 'NOT_EDITABLE');
  if (version != null && Number(version) !== d.version) fail(409, 'Deklarasjonen er endret av en annen bruker. Last inn på nytt.', 'VERSION');
  const card = await D.card(id);
  if (!card.check.ok) fail(409, `Deklarasjonen har ${card.check.errors} feil som må rettes før innsending.`, 'HAS_ERRORS');
  const open = card.reviews.filter((r: any) => r.status === 'OPEN').length;
  if (open) fail(409, `${open} kontrollpunkt${open === 1 ? '' : 'er'} fra AI-lesingen må avklares før innsending.`, 'REVIEWS_OPEN');
  const { calc, issues, items, parties, documents } = card;
  const header = Object.fromEntries(Object.entries(card).filter(([k]) => !['calc', 'issues', 'items', 'parties', 'documents', 'reviews', 'intakes', 'ai', 'check',
    'versions', 'comments', 'queue', 'editable', 'workflow', 'digitoll', 'invoice'].includes(k)));
  const versionNo = d.current_version + 1;
  await tx(async c => {
    await c.query(`INSERT INTO declaration_version (declaration_id, version_no, snapshot, submitted_by) VALUES ($1, $2, $3, $4)`,
      [id, versionNo, JSON.stringify({ header, items, calc, issues, parties, documents: documents.map((x: any) => ({ id: x.id, doc_code: x.doc_code, filename: x.filename })) }), req.user!.id]);
    await c.query(`UPDATE declaration SET status = 'SUBMITTED', current_version = $3, version = version + 1, updated_at = now(), updated_by = $2 WHERE id = $1`, [id, req.user!.id, versionNo]);
    await audit(req, { action: 'DECLARATION_SUBMITTED', objectType: 'DECLARATION', objectId: id, before: { status: d.status }, after: { status: 'SUBMITTED' },
      detail: { version: versionNo, payable: calc?.payable, warnings: card.check.warnings } }, c);
  });
  return D.card(id);
}

/** Approve: four eyes, a fresh check (dates age), build the CUSDEC, queue it. */
export async function approve(req: Request, id: string) {
  const d = await requireDecl(id);
  if (d.status !== 'SUBMITTED') fail(409, 'Bare en deklarasjon som er sendt til godkjenning, kan godkjennes.', 'NOT_SUBMITTED');
  const v = (await latestVersion(id))!;
  if (await fourEyes() && v.submitted_by === req.user!.id)
    fail(403, 'Fire øyne: du kan ikke godkjenne en deklarasjon du selv har sendt til godkjenning.', 'FOUR_EYES');
  const now = await D.validate(id);
  if (!now.ok) fail(409, `Deklarasjonen har fått ${now.errors} feil siden innsendingen (f.eks. datoen). Returner den til rettelse.`, 'HAS_ERRORS');
  const orgNo = await declarantOrgNo();
  const tvinnId = declarationId(orgNo, v.snapshot.header.decl_date, sequenceOf(d.decl_no), v.version_no);
  let message: string | null = null;
  try { message = buildCusdec(v.snapshot, { declarantOrgNo: orgNo, tvinnId }); } catch { message = null; }
  await tx(async c => {
    await c.query(`UPDATE declaration_version SET decision = 'APPROVED', decided_by = $2, decided_at = now(), tvinn_id = $3, message = $4 WHERE id = $1`, [v.id, req.user!.id, tvinnId, message]);
    await c.query(`UPDATE declaration SET status = 'APPROVED', version = version + 1, updated_at = now(), updated_by = $2 WHERE id = $1`, [id, req.user!.id]);
    await Q.enqueue(c, id, v.id, req.user!.id);
    await audit(req, { action: 'DECLARATION_APPROVED', objectType: 'DECLARATION', objectId: id, before: { status: 'SUBMITTED' }, after: { status: 'APPROVED' },
      detail: { version: v.version_no, tvinnId, submittedBy: v.submitted_by, fourEyes: await fourEyes() } }, c);
  });
  Q.kick();
  return D.card(id);
}

/** Return to the specialist with a reason (kept on the version and as a comment). */
export async function giveBack(req: Request, id: string, reason: unknown, recall = false) {
  const d = await requireDecl(id);
  if (d.status !== 'SUBMITTED') fail(409, 'Bare en deklarasjon som venter på godkjenning, kan returneres.', 'NOT_SUBMITTED');
  const v = (await latestVersion(id))!;
  const why = recall ? (str(reason) ?? 'Trukket tilbake av innsenderen') : str(reason);
  if (!why) fail(400, 'Oppgi hvorfor deklarasjonen returneres.', 'REASON_REQUIRED');
  if (recall && v.submitted_by !== req.user!.id && !req.user!.perms.includes('declaration.approve'))
    fail(403, 'Bare den som sendte deklarasjonen til godkjenning, kan trekke den tilbake.', 'NOT_SUBMITTER');
  await tx(async c => {
    await c.query(`UPDATE declaration_version SET decision = 'RETURNED', decided_by = $2, decided_at = now(), decision_reason = $3 WHERE id = $1`, [v.id, req.user!.id, why]);
    await c.query(`UPDATE declaration SET status = 'RETURNED', version = version + 1, updated_at = now(), updated_by = $2 WHERE id = $1`, [id, req.user!.id]);
    await c.query('INSERT INTO declaration_comment (declaration_id, user_id, text) VALUES ($1, $2, $3)', [id, req.user!.id, `${recall ? 'Trukket tilbake' : 'Returnert'}: ${why}`]);
    await audit(req, { action: recall ? 'DECLARATION_RECALLED' : 'DECLARATION_RETURNED', objectType: 'DECLARATION', objectId: id,
      before: { status: 'SUBMITTED' }, after: { status: 'RETURNED' }, detail: { version: v.version_no, reason: why } }, c);
  });
  return D.card(id);
}

export async function comment(req: Request, id: string, text: unknown) {
  await requireDecl(id);
  const t = str(text);
  if (!t) fail(400, 'Skriv en kommentar.');
  await query('INSERT INTO declaration_comment (declaration_id, user_id, text) VALUES ($1, $2, $3)', [id, req.user!.id, t!.slice(0, 4000)]);
  await audit(req, { action: 'DECLARATION_COMMENT', objectType: 'DECLARATION', objectId: id, detail: { text: t!.slice(0, 300) } });
  return D.card(id);
}

export async function message(id: string, versionNo: number) {
  const v = await one('SELECT message, tvinn_id FROM declaration_version WHERE declaration_id = $1 AND version_no = $2', [id, versionNo]);
  if (!v?.message) fail(404, 'Ingen EDIFACT-melding for denne versjonen.');
  return v!;
}
