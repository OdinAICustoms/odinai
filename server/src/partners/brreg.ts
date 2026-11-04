/**
 * Brønnøysundregistrene — Enhetsregisteret open API (no key).  https://data.brreg.no/enhetsregisteret/api
 * Only public company data is used; from the roles, only the NAMES are kept, never birth dates.
 */
import { HttpError } from '../errors.js';

const BASE = () => (process.env.BRREG_BASE || 'https://data.brreg.no/enhetsregisteret/api').replace(/\/$/, '');
const TIMEOUT = Number(process.env.BRREG_TIMEOUT_MS || 15000);

async function getJson(path: string): Promise<{ status: number; body: any }> {
  let r: Response;
  try {
    r = await fetch(BASE() + path, { headers: { Accept: 'application/json', 'User-Agent': 'OdinAi/0.1 (ODIN CUSTOMS AS)' }, signal: AbortSignal.timeout(TIMEOUT) });
  } catch (e: any) {
    const code = e?.cause?.code || e?.name;
    if (/CERT|SELF_SIGNED|ISSUER/.test(String(code || e?.message)))
      throw new HttpError(502, 'Brønnøysund kunne ikke nås: nettverket avskjærer HTTPS. Sett NODE_EXTRA_CA_CERTS til bedriftens rotsertifikat.', 'BRREG');
    throw new HttpError(502, `Brønnøysund kunne ikke nås (${code}). Kontroller internettforbindelsen.`, 'BRREG');
  }
  if (r.status === 404) return { status: 404, body: null };
  if (r.status === 410) return { status: 410, body: await r.json().catch(() => ({})) };
  if (!r.ok) throw new HttpError(502, `Brønnøysund svarte ${r.status}.`, 'BRREG');
  return { status: r.status, body: await r.json() };
}

export interface BrregAddress { lines: string[]; postalCode: string | null; city: string | null; countryCode: string | null; municipality: string | null }
export interface BrregUnit {
  orgNo: string; name: string; orgForm: { code: string | null; text: string | null } | null;
  businessAddress: BrregAddress | null; postalAddress: BrregAddress | null;
  vatRegistered: boolean; bankrupt: boolean; windingUp: boolean; forcedDissolution: boolean; deleted: boolean; deletedDate: string | null;
  industry: { code: string | null; text: string | null } | null; employees: number | null;
  website: string | null; email: string | null; phone: string | null; registeredDate: string | null; link: string;
}

const addr = (a: any): BrregAddress | null => a ? {
  lines: (a.adresse || []).filter(Boolean), postalCode: a.postnummer || null, city: a.poststed || null,
  countryCode: a.landkode || null, municipality: a.kommune || null
} : null;
const code = (c: any) => (c ? { code: c.kode || null, text: c.beskrivelse || null } : null);

export function normalise(e: any): BrregUnit {
  return {
    orgNo: e.organisasjonsnummer, name: e.navn, orgForm: code(e.organisasjonsform),
    businessAddress: addr(e.forretningsadresse), postalAddress: addr(e.postadresse),
    vatRegistered: e.registrertIMvaregisteret === true, bankrupt: e.konkurs === true, windingUp: e.underAvvikling === true,
    forcedDissolution: e.underTvangsavviklingEllerTvangsopplosning === true, deleted: !!e.slettedato, deletedDate: e.slettedato || null,
    industry: code(e.naeringskode1), employees: e.harRegistrertAntallAnsatte === false ? null : (e.antallAnsatte ?? null),
    website: e.hjemmeside || null, email: e.epostadresse || null, phone: e.telefon || e.mobil || null,
    registeredDate: e.registreringsdatoEnhetsregisteret || null,
    link: `https://virksomhet.brreg.no/nb/oppslag/enheter/${e.organisasjonsnummer}`
  };
}

/** Company by organisation number; null if unknown. A deleted unit is returned flagged. */
export async function getUnit(orgNo: string): Promise<BrregUnit | null> {
  const o = String(orgNo || '').replace(/\s/g, '');
  if (!/^\d{9}$/.test(o)) throw new HttpError(400, 'Et organisasjonsnummer har 9 siffer.');
  const r = await getJson(`/enheter/${o}`);
  if (r.status === 404) return null;
  if (r.status === 410) return normalise({ organisasjonsnummer: o, navn: r.body?.navn || '', slettedato: r.body?.slettedato || 'ukjent' });
  return normalise(r.body);
}

/** Search by name, or a direct lookup when the query is an organisation number. */
export async function search(q: string): Promise<BrregUnit[]> {
  const s = String(q || '').trim();
  if (/^\d{3}\s?\d{3}\s?\d{3}$/.test(s)) { const u = await getUnit(s); return u ? [u] : []; }
  if (s.length < 2) throw new HttpError(400, 'Skriv minst to bokstaver, eller et organisasjonsnummer med 9 siffer.');
  const r = await getJson(`/enheter?navn=${encodeURIComponent(s)}&size=25`);
  return (r.body?._embedded?.enheter ?? []).map(normalise);
}

/** Names per role: daglig leder, styreleder, nestleder, board, auditor, accountant, contact. */
export async function getRoles(orgNo: string) {
  const r = await getJson(`/enheter/${String(orgNo).replace(/\s/g, '')}/roller`);
  if (r.status !== 200 || !r.body) return null;
  const nameOf = (x: any) => x.person?.navn ? [x.person.navn.fornavn, x.person.navn.mellomnavn, x.person.navn.etternavn].filter(Boolean).join(' ')
    : x.enhet ? [].concat(x.enhet.navn || []).join(' ') + (x.enhet.organisasjonsnummer ? ` (${x.enhet.organisasjonsnummer})` : '') : null;
  const out: Record<string, string[]> = { dailyManager: [], chair: [], deputyChair: [], board: [], auditor: [], accountant: [], contact: [] };
  const map: Record<string, string> = { DAGL: 'dailyManager', LEDE: 'chair', NEST: 'deputyChair', MEDL: 'board', REVI: 'auditor', REGN: 'accountant', KONT: 'contact' };
  for (const g of r.body.rollegrupper || []) for (const x of g.roller || []) {
    const k = map[x.type?.kode];
    if (!k || x.fratraadt) continue;
    const n = nameOf(x);
    if (n && !out[k].includes(n)) out[k].push(n);
  }
  return out;
}
