/**
 * What an accepted declaration costs the client, as pure functions (phase 4a). The service loads the
 * context (prices on the declaration date, who paid the duty, the accepted calculation) and stores the
 * result; nothing here touches the database. Rules carried over from ODIN LINK 2.37 (src/invoicing.js).
 *
 *  * Fees from the price list: the client's agreed price on the partner card wins over the list price.
 *    PER_DECL once per declaration; PER_LINE for goods items beyond the free ones; PERCENT_DUTY (credit
 *    commission) only when Odin paid the duty, as a percentage of the duty and levies.
 *  * Outlays: duty and levies are recharged only when Odin paid them (box 48). Import VAT is never
 *    recharged: a VAT-registered importer accounts for it in its own VAT return.
 *  * A fee with no price (neither agreement nor list price) is left out with a warning, never invented.
 */
export type VatCode = 'HIGH' | 'ZERO' | 'EXEMPT' | 'OUTLAY';
export const VAT_RATE: Record<VatCode, number> = { HIGH: 25, ZERO: 0, EXEMPT: 0, OUTLAY: 0 };
export const UNIT_TEXT: Record<string, string> = { PER_DECL: 'stk', PER_LINE: 'stk', PER_HOUR: 'timer', FIXED: 'stk', PERCENT_DUTY: 'stk' };

export interface PriceItem { code: string; name_no: string; unit: string; applies_to: string; mva_code: string; price: number | string; free_lines: number | null }
export interface Price { price: number; freeLines: number | null; source: 'AGREEMENT' | 'LIST' }
/** Who paid duty and levies to Tolletaten for this declaration (box 48). */
export type Payer = 'ODIN' | 'CLIENT' | 'UNKNOWN' | 'NONE';
export interface DeclForInvoice {
  id: string; decl_no: string; direction: 'IMPORT' | 'EXPORT'; mrn: string | null; decl_date: string | null;
  itemCount: number; calc: { duty?: number; rt?: number; fa?: number; saer?: number; tillegg?: number; levy?: number; vat?: number };
  payer: Payer; account: string | null;
}
export interface LineDraft {
  line_type: 'FEE' | 'OUTLAY' | 'SERVICE' | 'OTHER'; item_code: string | null; description: string;
  quantity: number; unit: string; unit_price: number; vat_code: VatCode; declaration_id: string | null;
  price_source: 'AGREEMENT' | 'LIST' | 'CALCULATION' | 'MANUAL';
}
export interface Warning { rule: string; msg: string; declarationId?: string }

export const r2 = (n: number) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const pct = (n: number) => String(n).replace('.', ',');
const kr = (n: number) => r2(n).toLocaleString('nb-NO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const OUTLAYS: [string, string, keyof DeclForInvoice['calc']][] = [
  ['TOLL', 'Toll', 'duty'], ['RT', 'Råvaretollavgift (RT100)', 'rt'], ['FA', 'Forskningsavgift', 'fa'],
  ['SAER', 'Særavgifter', 'saer'], ['TILLEGG', 'Tilleggstoll', 'tillegg']
];

/** Proposed lines for one accepted declaration. */
export function propose(d: DeclForInvoice, items: PriceItem[], priceOf: (code: string) => Price | null, client: { vatRegistered: boolean | null }) {
  const lines: LineDraft[] = [], warnings: Warning[] = [];
  const ref = d.decl_no + (d.mrn ? ` (MRN ${d.mrn})` : '');
  const warn = (rule: string, msg: string) => warnings.push({ rule, msg, declarationId: d.id });
  const applies = (it: PriceItem) => it.applies_to === 'ALL' || it.applies_to === d.direction;
  const odinPaid = d.payer === 'ODIN';
  const dutyBase = d.direction === 'EXPORT' ? num(d.calc.levy) : OUTLAYS.reduce((s, [, , k]) => s + num(d.calc[k]), 0);

  for (const it of items.filter(applies)) {
    const p = priceOf(it.code);
    const price = num(p?.price), source = p?.source ?? 'LIST';
    const vat = (it.mva_code as VatCode) in VAT_RATE ? it.mva_code as VatCode : 'HIGH';
    if (it.unit === 'PER_DECL') {
      if (price > 0) lines.push({ line_type: 'FEE', item_code: it.code, description: `${it.name_no} · ${ref}`, quantity: 1, unit: 'stk', unit_price: price, vat_code: vat, declaration_id: d.id, price_source: source });
      else warn('NO_PRICE', `${d.decl_no}: ingen pris for «${it.name_no}» — verken avtalt pris på partnerkortet eller listepris. Linjen er utelatt.`);
    } else if (it.unit === 'PER_LINE') {
      const free = p?.freeLines ?? it.free_lines ?? 0;
      const extra = Math.max(0, d.itemCount - free);
      if (extra > 0 && price > 0)
        lines.push({ line_type: 'FEE', item_code: it.code, description: `${it.name_no} (${d.itemCount} vareposter, ${free} inkludert) · ${d.decl_no}`, quantity: extra, unit: 'stk', unit_price: price, vat_code: vat, declaration_id: d.id, price_source: source });
    } else if (it.unit === 'PERCENT_DUTY') {
      if (odinPaid && price > 0 && dutyBase > 0)
        lines.push({ line_type: 'FEE', item_code: it.code, description: `${it.name_no} ${pct(price)} % av ${kr(dutyBase)} kr · ${d.decl_no}`, quantity: 1, unit: 'stk', unit_price: r2(dutyBase * price / 100), vat_code: vat, declaration_id: d.id, price_source: source });
    }
  }

  if (d.payer === 'UNKNOWN' && dutyBase > 0)
    warn('PAYER_UNKNOWN', `${d.decl_no}: konto ${d.account ?? '—'} i rubrikk 48 er ikke registrert på Odin eller klienten. Toll og avgifter (${kr(dutyBase)} kr) er ikke tatt med som utlegg — kontroller hvem som betalte.`);
  if (odinPaid) {
    if (d.direction === 'EXPORT') {
      if (num(d.calc.levy) > 0) lines.push({ line_type: 'OUTLAY', item_code: 'UTFORSEL', description: `Utførselsavgift · ${d.decl_no} (utlegg)`, quantity: 1, unit: 'stk', unit_price: r2(num(d.calc.levy)), vat_code: 'OUTLAY', declaration_id: d.id, price_source: 'CALCULATION' });
    } else {
      for (const [code, label, k] of OUTLAYS) if (num(d.calc[k]) > 0)
        lines.push({ line_type: 'OUTLAY', item_code: code, description: `${label} · ${d.decl_no} (utlegg)`, quantity: 1, unit: 'stk', unit_price: r2(num(d.calc[k])), vat_code: 'OUTLAY', declaration_id: d.id, price_source: 'CALCULATION' });
      if (client.vatRegistered === false && num(d.calc.vat) > 0)
        warn('CLIENT_NOT_VAT_REGISTERED', `${d.decl_no}: klienten er ikke registrert i Merverdiavgiftsregisteret, så Tolletaten kan ha belastet importmerverdiavgift (${kr(num(d.calc.vat))} kr) på Odins konto. Den er ikke tatt med — legg den til som utlegg hvis den er betalt.`);
    }
  }
  return { lines, warnings };
}

/** Amount and VAT for a line. Without VAT registration Odin charges no VAT at all. */
export function priceLine(l: { quantity: number | string; unit_price: number | string; vat_code: string }, vatRegistered: boolean) {
  const amount = r2(num(l.quantity) * num(l.unit_price));
  const code = (l.vat_code as VatCode) in VAT_RATE ? l.vat_code as VatCode : 'HIGH';
  const rate = vatRegistered ? VAT_RATE[code] : 0;
  return { amount, vat_code: code, vat_rate: rate, vat_amount: r2(amount * rate / 100) };
}

/** Invoice totals from its live lines; the deposit is set off against the amount to pay. */
export function totals(lines: { amount: number | string; vat_amount: number | string; vat_code: string }[], depositApplied = 0) {
  const net = r2(lines.filter(l => l.vat_code !== 'OUTLAY').reduce((s, l) => s + num(l.amount), 0));
  const outlay = r2(lines.filter(l => l.vat_code === 'OUTLAY').reduce((s, l) => s + num(l.amount), 0));
  const vat = r2(lines.reduce((s, l) => s + num(l.vat_amount), 0));
  return { net_total: net, vat_total: vat, outlay_total: outlay, deposit_applied: r2(depositApplied), total: r2(net + vat + outlay - depositApplied) };
}

/** VAT summary for the printed invoice: per rate, the base and the VAT. */
export function vatSummary(lines: { amount: number | string; vat_amount: number | string; vat_code: string; vat_rate: number | string }[]) {
  const out = new Map<string, { code: string; rate: number; base: number; vat: number }>();
  for (const l of lines) {
    const k = `${l.vat_code}:${num(l.vat_rate)}`;
    const e = out.get(k) ?? { code: l.vat_code, rate: num(l.vat_rate), base: 0, vat: 0 };
    e.base = r2(e.base + num(l.amount)); e.vat = r2(e.vat + num(l.vat_amount));
    out.set(k, e);
  }
  return [...out.values()].sort((a, b) => b.rate - a.rate || a.code.localeCompare(b.code));
}

/** KID: client number (6) + invoice number (7) + a MOD10 (Luhn) check digit. */
export function kid(partnerNo: string, invoiceNo: number | string) {
  const base = `${String(partnerNo ?? '').replace(/\D/g, '').slice(-6).padStart(6, '0')}${String(invoiceNo).replace(/\D/g, '').slice(-7).padStart(7, '0')}`;
  return base + mod10(base);
}
export function mod10(digits: string) {
  let sum = 0;
  [...digits].reverse().forEach((ch, k) => { let d = Number(ch) * (k % 2 === 0 ? 2 : 1); if (d > 9) d -= 9; sum += d; });
  return String((10 - (sum % 10)) % 10);
}
export const validKid = (k: string) => /^\d{2,25}$/.test(k) && mod10(k.slice(0, -1)) === k.slice(-1);

/** A Norwegian bank account number: 11 digits, MOD11 check digit. */
export function validAccount(a: string) {
  const d = String(a ?? '').replace(/[\s.]/g, '');
  if (!/^\d{11}$/.test(d)) return false;
  const w = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const s = w.reduce((t, x, i) => t + x * Number(d[i]), 0);
  const c = 11 - (s % 11);
  return (c === 11 ? 0 : c) === Number(d[10]) && c !== 10;
}
export const formatAccount = (a: string) => { const d = String(a ?? '').replace(/\D/g, ''); return d.length === 11 ? `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6)}` : a; };

export const addDays = (d: string, n: number) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
/** Last day of the month before d (monthly invoicing covers whole months). */
export const endOfPreviousMonth = (d: string) => { const x = new Date(d.slice(0, 8) + '01T00:00:00Z'); x.setUTCDate(0); return x.toISOString().slice(0, 10); };
