/**
 * EDIFACT CUSDEC for TVINN — SKELETON, carried over from ODIN LINK 2.37 (src/tvinn/edifact.js).
 * Not certified and not connected: the message is built and stored with every sent version (so it can be
 * read and checked), but nothing is transmitted.
 *
 * Real here: the UN/EDIFACT segment structure, escaping of the reserved characters + : ' ?, decimal points,
 * the declaration ID Tolletaten documents (<declarant org. no.>-<ddmmyyyy>-<sequence ≤ 6>-<version ≤ 2>),
 * and RT100 as a specific duty next to A00.
 *
 * Needed before it can transmit (phase 5): the CUSDEC/CUSRES implementation guide for Odin's permit
 * (NorStella), the Nodi number, a Tietoevry network client in send(), CUSRES parsing for every answer type,
 * Tolletaten's test period, and then TVINN_ADAPTER=edifact with TVINN_ALLOW_LIVE=true set deliberately.
 */
const esc = (s: unknown) => String(s ?? '').replace(/([+:'?])/g, '?$1');
const seg = (...p: (string | string[])[]) => p.map(x => (Array.isArray(x) ? x.map(esc).join(':') : esc(x))).join('+') + "'";
const ymd = (d: unknown) => String(d ?? '').replace(/-/g, '');
const dec = (v: unknown) => { const n = Number(String(v ?? '').replace(/\s/g, '').replace(',', '.')); return Number.isFinite(n) ? String(n) : '0'; };

/** TVINN's declaration ID. The sequence is the declaration's own number; the version counts submits. */
export function declarationId(orgNo: string, declDate: string | null, sequence: number, version: number) {
  const d = ymd(declDate);
  const ddmmyyyy = d.length === 8 ? d.slice(6, 8) + d.slice(4, 6) + d.slice(0, 4) : '';
  return `${orgNo}-${ddmmyyyy}-${String(sequence).slice(-6)}-${String(version).slice(0, 2)}`;
}

export function buildCusdec(s: any, opts: { declarantOrgNo: string; tvinnId: string; sender?: string; receiver?: string }) {
  if (!/^\d{9}$/.test(opts.declarantOrgNo)) throw new Error('Deklarantens organisasjonsnummer (innstillingen «declarant») har ikke 9 siffer.');
  const h = s.header, calc = s.calc ?? {}, p = s.parties ?? {};
  const ref = String(h.own_ref || h.decl_no || '').slice(0, 15);
  const now = new Date();
  const out: string[] = [];
  out.push(seg('UNB', ['UNOC', '3'], [opts.sender || process.env.NODI_SENDER || 'NO000000', 'ZZ'], [opts.receiver || process.env.NODI_RECEIVER || 'NO888888', 'ZZ'],
    [now.toISOString().slice(2, 10).replace(/-/g, ''), now.toISOString().slice(11, 16).replace(':', '')], ref));
  out.push(seg('UNH', ref, ['CUSDEC', 'D', '96B', 'UN']));
  out.push(seg('BGM', ['929'], opts.tvinnId, '9'));
  out.push(seg('DTM', ['137', ymd(h.decl_date), '102']));
  out.push(seg('LOC', ['116', String(h.office ?? '')]));
  out.push(seg('NAD', 'CN', [p.importer?.identifier ?? '', '', '91']));
  out.push(seg('NAD', 'CZ', [p.exporter?.identifier ?? '', '', '91']));
  out.push(seg('NAD', 'DT', [p.declarant?.identifier ?? opts.declarantOrgNo, '', '91']));
  out.push(seg('TDT', '20', '', String(h.transport_mode ?? '')));
  out.push(seg('CUX', ['2', h.currency || 'NOK', '4'], dec(calc.fx)));
  out.push(seg('MOA', ['39', dec(h.invoice_total)]));
  if (/^\d{6}$/.test(String(h.payment_account ?? '').replace(/\D/g, ''))) out.push(seg('RFF', ['AGA', String(h.payment_account).replace(/\D/g, '')]));
  for (const it of s.items ?? []) {
    const l = (calc.lines ?? []).find((x: any) => x.line_no === it.line_no) ?? {};
    out.push(seg('CST', String(it.line_no), String(it.code ?? '')));
    out.push(seg('FTX', 'AAA', '', '', String(it.description ?? '').slice(0, 70)));
    out.push(seg('LOC', ['27', String(it.origin ?? '')]));
    out.push(seg('MEA', 'WT', 'AAB', ['KGM', dec(it.net_kg)]));
    if (it.supp_qty) out.push(seg('MEA', 'AAE', 'AAB', ['', dec(it.supp_qty)]));
    out.push(seg('MOA', ['203', dec(it.price)]));
    out.push(seg('TAX', '7', 'A00', '', '', ['', '', '', dec(l.tl1?.rate ?? 0)]));
    if (l.rt && l.rt.amount > 0) {
      out.push(seg('TAX', '7', 'RT100', '', '', ['', '', '', dec(l.rt.rate)], '', 'S'));
      out.push(seg('MOA', ['124', dec(l.rt.amount)]));
      if (l.rt.skriv) out.push(seg('RFF', ['AIF', String(l.rt.skriv)]));
    }
    if (it.preference && it.preference !== 'N') out.push(seg('GEI', '3', 'Y'));
  }
  out.push(seg('UNT', String(out.length - 1), ref));
  out.push(seg('UNZ', '1', ref));
  return out.join('\n');
}

/** The real transmission. Deliberately refuses: a timeout is no proof TVINN did not receive it, so never retry blindly. */
export async function submit(): Promise<never> {
  const e = new Error(process.env.TVINN_ALLOW_LIVE === 'true'
    ? 'Ingen klient for nettverksleverandøren (Tietoevry) er satt opp ennå. Deklarasjonen er ikke sendt.'
    : 'EDIFACT-adapteren er et skjelett og er ikke sertifisert. Bruk TVINN_ADAPTER=simulator til TVINN-tillatelse, Nodi-nummer, Tietoevry-tilkobling og Tolletatens testperiode er på plass.');
  throw Object.assign(e, { permanent: true });
}
