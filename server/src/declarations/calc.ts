/**
 * Duty and tax calculation for an import declaration (phase 2b). Pure: the rates, country groups and
 * permits arrive in the context, which repo.ts loads for the declaration date.
 * Carried over from ODIN LINK 2.37 (src/duty-calc.js, landgruppe.js, rt.js, taxes.js, saeravgift.js,
 * tilleggstoll.js, box12.js, rounding.js) and checked against two declarations accepted by Tolletaten
 * (Proteria 446040 2600 234081 and 441002 2600 548405) to the krone.
 *
 *  * Box 46 and every box 47 amount are WHOLE KRONER, rounded half up per goods item. The VAT base is the
 *    rounded box 46 value plus the rounded duties of the same item.
 *  * TL1: the ordinary rate (TALL) unless box 36 claims a preference (A/B/C/G/P) AND the origin really has
 *    a preferential rate: G looks only at the GSP groups (TGS…), A/B/C/P only at the agreement groups.
 *  * RT100: the product's permit (TALL or TOES column by origin; the higher one when unsure) when it is
 *    valid on the date and held by the importer; otherwise the published rate for the same group as TL1.
 *  * Tolletaten publishes 999 999,99 as a placeholder: never a real rate, never multiplied.
 *  * Procedures 5xxx and 7xxx (temporary import, processing, warehouse): calculated, but nothing charged.
 */
import { PREF_CLAIM_CODES, SUSPENSIVE } from './codes.js';

export interface RateRow { landgruppe: string; duty_code: 'TL1' | 'RT100'; rate_value: string | number | null; rate_unit: 'PERCENT' | 'SPECIFIC'; unit_code: string | null; unit_text: string | null }
export interface LevyRow { levy_type: string; levy_type_text: string | null; levy_group: number | null; levy_group_text: string | null; rate: string | number | null; unit: string | null; unit_text: string | null }
export interface AddDutyRow { landgruppe: string; rate: string | number; unit: string | null; unit_text: string | null }
export interface Permit { id: string; permit_no: string; product_name: string; holder_org_no: string | null; rate_tall: string | number | null; skriv_tall: string | null;
  rate_toes: string | number | null; skriv_toes: string | null; valid_from: string; valid_to: string }
export interface Box12Line { kind: 'ADD' | 'DED'; type: string; amount: number | string; currency?: 'INV' | 'NOK'; basis?: 'GROSS' | 'NET' | 'VALUE'; text?: string }

export interface CalcContext {
  date: string;
  currency: string | null;
  fx: number | null;                                   // NOK per unit of box 22a; 1 for NOK
  declType: string | null;
  groupsOf: Record<string, string[]>;                  // country -> country groups on the date (TALL added here)
  rates: Record<string, RateRow[]>;                    // code -> rate lines in force
  levies: Record<string, LevyRow[]>;                   // code -> levy lines in force
  levyDataLoaded: boolean;
  additional: Record<string, AddDutyRow[]>;
  permits: Record<string, Permit[]>;                   // product id -> permits (active), newest first
  importerOrg: string | null;
  box12: Box12Line[];
  warnDays?: number;
}

export const ORDINARY = 'TALL';
const SENTINEL = 999999;
const WARN_DAYS = Number(process.env.RT_WARN_DAYS || 60);
const num = (v: unknown) => { if (typeof v === 'number') return Number.isFinite(v) ? v : 0; const n = Number(String(v ?? '').replace(/\s/g, '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };
const nul = (v: unknown) => (v === null || v === undefined || v === '' ? null : num(v));
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
/** Half up on the real decimal value (2.5499999 is 2.55, never 1.498 -> 1.50). */
export const krone = (n: number) => { const c = Math.round(n * 1e6) / 1e6; return c < 0 ? -Math.round(-c) : Math.round(c); };
const isSentinel = (v: unknown) => v != null && num(v) >= SENTINEL;
const isGsp = (g: string) => /^TGS/i.test(g);
const perKg = (r: { unit_code?: string | null; unit_text?: string | null }) => r.unit_code === 'K' || /\bkg\b/i.test(String(r.unit_text ?? ''));
const addDays = (iso: string, n: number) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const orgDigits = (v: unknown) => String(v ?? '').replace(/\D/g, '').slice(-9);

/* ------------------------------ box 12 ------------------------------ */
export const B12_TYPES: Record<'ADD' | 'DED', Record<string, string>> = {
  ADD: { FRAKT: 'Frakt til norsk grense', FORSIKRING: 'Forsikring', ANDRE: 'Andre kostnader (tillegg)' },
  DED: { RABATT: 'Rabatt', FRAKT_INNLAND: 'Frakt i Norge inkludert i prisen', ANDRE: 'Annet fradrag' }
};
export const B12_BASES = { GROSS: 'Bruttovekt', NET: 'Nettovekt', VALUE: 'Verdi' } as const;
const basisOf = (l: Box12Line) => (l.basis && l.basis in B12_BASES ? l.basis : 'VALUE');

/** Split a whole-krone total over weights; the remainder goes to the largest item so the parts add up exactly. */
export function split(total: number, weights: number[]) {
  if (!weights.length) return [];
  const sum = weights.reduce((s, w) => s + w, 0);
  const parts = weights.map(w => krone(sum > 0 ? total * w / sum : total / weights.length));
  const diff = round2(total - parts.reduce((s, p) => s + p, 0));
  if (diff !== 0) { let big = 0; weights.forEach((w, i) => { if (w > weights[big]) big = i; }); parts[big] = round2(parts[big] + diff); }
  return parts;
}

export function allocateBox12(lines: Box12Line[], items: { price?: unknown; gross_kg?: unknown; net_kg?: unknown }[], fx: number, currency: string | null) {
  const used = (lines ?? []).filter(l => (l.kind === 'ADD' || l.kind === 'DED') && num(l.amount) !== 0);
  const nok = (l: Box12Line) => ((l.currency ?? 'INV') === 'NOK' || currency === 'NOK' ? num(l.amount) : num(l.amount) * fx);
  const W: Record<string, number[]> = {
    VALUE: items.map(it => Math.max(0, num(it.price) * fx)), GROSS: items.map(it => Math.max(0, num(it.gross_kg))), NET: items.map(it => Math.max(0, num(it.net_kg)))
  };
  const add = items.map(() => 0), ded = items.map(() => 0), bases: string[] = [];
  for (const b of Object.keys(B12_BASES)) {
    const a = round2(used.filter(l => l.kind === 'ADD' && basisOf(l) === b).reduce((s, l) => s + nok(l), 0));
    const d = round2(used.filter(l => l.kind === 'DED' && basisOf(l) === b).reduce((s, l) => s + nok(l), 0));
    if (!a && !d) continue;
    bases.push(b);
    split(a, W[b]).forEach((v, i) => { add[i] = round2(add[i] + v); });
    split(d, W[b]).forEach((v, i) => { ded[i] = round2(ded[i] + v); });
  }
  const total = (b: string) => round2(W[b].reduce((s, w) => s + w, 0));
  return { active: used.length > 0, add, ded, bases, addTotal: round2(add.reduce((s, x) => s + x, 0)), dedTotal: round2(ded.reduce((s, x) => s + x, 0)),
    valueTotal: total('VALUE'), grossTotal: total('GROSS'), netTotal: total('NET') };
}

/* ------------------------------ rates ------------------------------ */
const groups = (cx: CalcContext, country: string | null) => (country ? [...new Set([ORDINARY, ...(cx.groupsOf[country] ?? [])])] : [ORDINARY]);
const published = (cx: CalcContext, code: string, group: string, duty: 'TL1' | 'RT100') => cx.rates[code]?.find(r => r.landgruppe === group && r.duty_code === duty) ?? null;

/** The preferential rate the origin qualifies for under the box 36 claim (lowest of the eligible groups), or null. */
export function preferentialRate(cx: CalcContext, code: string, origin: string | null, duty: 'TL1' | 'RT100', pref: string) {
  let gs = groups(cx, origin).filter(g => g !== ORDINARY);
  if (pref === 'G') gs = gs.filter(isGsp); else gs = gs.filter(g => !isGsp(g));
  let best: (RateRow & { landgruppe: string }) | null = null;
  for (const g of gs) {
    const r = published(cx, code, g, duty);
    if (r && r.rate_value != null && !isSentinel(r.rate_value) && (best === null || num(r.rate_value) < num(best.rate_value))) best = r;
  }
  return best;
}

export type PermitStatus = 'VALID' | 'EXPIRING' | 'EXPIRED' | 'NOT_YET_VALID';
const permitStatus = (p: Permit, on: string, warn: number): PermitStatus =>
  on < p.valid_from ? 'NOT_YET_VALID' : on > p.valid_to ? 'EXPIRED' : p.valid_to <= addDays(on, warn) ? 'EXPIRING' : 'VALID';

/* ------------------------------ one goods item ------------------------------ */
export interface ItemInput {
  line_no: number; code?: string | null; origin?: string | null; preference?: string | null; procedure?: string | null; product_id?: string | null;
  price?: unknown; gross_kg?: unknown; net_kg?: unknown; freight?: unknown; add_amount?: unknown; ded_amount?: unknown; levies?: any[]; docs?: any[];
}

export function calcItem(it: ItemInput, cx: CalcContext, b12?: { add: number; ded: number }) {
  const code = it.code ?? '', origin = it.origin ? String(it.origin).toUpperCase() : null;
  const pref = String(it.preference ?? '').toUpperCase(), claimed = PREF_CLAIM_CODES.includes(pref);
  const fx = cx.fx ?? 0, net = num(it.net_kg);
  const proc = String(it.procedure ?? '');
  const suspended = SUSPENSIVE.includes(proc ? proc.charAt(0) : String(cx.declType ?? ''));

  // Box 45 and 46.
  const add45 = b12 ? b12.add : num(it.freight) + num(it.add_amount);
  const ded45 = b12 ? b12.ded : num(it.ded_amount);
  const customsValue = krone(num(it.price) * fx + add45 - ded45);

  // TL1 (A00).
  const ordinary = published(cx, code, ORDINARY, 'TL1');
  const ord = ordinary && ordinary.rate_value != null && !isSentinel(ordinary.rate_value) ? ordinary : null;
  const prefRow = claimed && code ? preferentialRate(cx, code, origin, 'TL1', pref) : null;
  const chosen = prefRow ?? ord;
  const tl1 = { landgruppe: chosen?.landgruppe ?? null, rate: nul(chosen?.rate_value), unit: chosen?.rate_unit ?? null, unitText: chosen?.unit_text ?? null,
    source: !chosen ? 'NO_RATE' : prefRow ? 'PREFERENCE' : claimed ? 'ORDINARY_NO_PREFERENCE_RATE' : 'ORDINARY', amount: null as number | null, manual: false };
  if (chosen) {
    if (chosen.rate_unit === 'PERCENT') tl1.amount = krone(customsValue * num(chosen.rate_value) / 100);
    else if (perKg(chosen)) tl1.amount = krone(net * num(chosen.rate_value));
    else tl1.manual = true;
  }
  // For the rules: a lower preferential rate the line does not claim.
  const unclaimedPref = !claimed && code ? (['A', 'G'].map(p => preferentialRate(cx, code, origin, 'TL1', p)).filter(Boolean)
    .sort((a, b) => num(a!.rate_value) - num(b!.rate_value))[0] ?? null) : null;

  // RT100.
  const rtRequired = !!cx.rates[code]?.some(r => r.duty_code === 'RT100');
  let rt: any = null;
  if (rtRequired) {
    const group = prefRow?.landgruppe ?? ORDINARY;
    const pub = published(cx, code, group, 'RT100');
    const list = it.product_id ? cx.permits[it.product_id] ?? [] : [];
    const permit = list.find(p => p.valid_from <= cx.date && cx.date <= p.valid_to) ?? list[0] ?? null;
    const status = permit ? permitStatus(permit, cx.date, cx.warnDays ?? WARN_DAYS) : null;
    const permitOrg = orgDigits(permit?.holder_org_no);
    const holder = !permit ? null : !permitOrg ? 'UNRECORDED' : !cx.importerOrg ? 'NO_IMPORTER_ORG' : permitOrg === orgDigits(cx.importerOrg) ? 'OK' : 'MISMATCH';
    const usable = permit && (status === 'VALID' || status === 'EXPIRING') && holder !== 'MISMATCH';
    if (usable) {
      const isToes = origin ? groups(cx, origin).includes('TOES') : false;
      const tall = { variant: 'TALL', rate: nul(permit!.rate_tall), skriv: permit!.skriv_tall };
      const toes = { variant: 'TOES', rate: nul(permit!.rate_toes), skriv: permit!.skriv_toes };
      let v = origin && isToes && toes.rate != null ? toes : origin && tall.rate != null ? tall : null;
      const confident = !!v;
      if (!v) v = [tall, toes].filter(x => x.rate != null).sort((a, b) => (b.rate ?? 0) - (a.rate ?? 0))[0] ?? null;
      const sentinel = v ? isSentinel(v.rate) : false;
      rt = { status, permit: { id: permit!.id, permit_no: permit!.permit_no, product_name: permit!.product_name, valid_from: permit!.valid_from, valid_to: permit!.valid_to },
        holder, variant: v?.variant ?? null, rate: v?.rate ?? null, skriv: v?.skriv ?? null, confident, sentinel, group,
        amount: v && !sentinel ? krone(net * (v.rate ?? 0)) : 0 };
    } else if (pub && pub.rate_value != null && !isSentinel(pub.rate_value)) {
      rt = { status: 'PUBLISHED_RATE', permitStatus: status, permit: permit ? { id: permit.id, permit_no: permit.permit_no, product_name: permit.product_name, valid_from: permit.valid_from, valid_to: permit.valid_to } : null,
        holder, variant: null, rate: num(pub.rate_value), skriv: null, confident: true, sentinel: false, group, amount: krone(net * num(pub.rate_value)) };
    } else {
      rt = { status: permit ? status : 'MISSING', permitStatus: status, permit: permit ? { id: permit.id, permit_no: permit.permit_no, product_name: permit.product_name, valid_from: permit.valid_from, valid_to: permit.valid_to } : null,
        holder, variant: null, rate: null, skriv: null, confident: false, sentinel: !!pub && isSentinel(pub.rate_value), group, amount: 0 };
    }
  }
  const rtAmount = rt?.amount ?? 0;

  // Research levy (FA): Tolletaten's levy data is the authority, including "no FA on this code".
  const levyRows = cx.levies[code] ?? [];
  const faRow = levyRows.find(r => r.levy_type === 'FA') ?? null;
  const fa = faRow ? { group: faRow.levy_group, rate: nul(faRow.rate), unit: faRow.unit,
    amount: faRow.unit === 'P' ? krone(customsValue * num(faRow.rate) / 100) : null } : null;
  const faAmount = fa?.amount ?? 0;

  // Excise duties chosen on the line (everything except MV and FA).
  const types = levyTypes(levyRows);
  const saer = (Array.isArray(it.levies) ? it.levies : []).flatMap((c: any) => {
    if (!c?.type || c.group == null || c.group === '' || c.group === 'NA') return [];
    const t = types.find(x => x.type === c.type), g = t?.groups.find(x => String(x.group) === String(c.group));
    if (!g) return [];
    const pct = g.unit === 'P', qty = pct ? null : num(c.qty);
    return [{ type: t!.type, typeText: t!.text, group: g.group, groupText: g.text, rate: g.rate, unit: g.unit, unitText: g.unitText, qty,
      amount: krone(pct ? customsValue * num(g.rate) / 100 : (qty ?? 0) * num(g.rate)) }];
  });
  const saerAmount = saer.reduce((s, l) => s + l.amount, 0);

  // Additional customs duty: the origin is in the rate's country group.
  const addRow = origin ? (cx.additional[code] ?? []).find(r => groups(cx, origin).includes(r.landgruppe)) ?? null : null;
  const tillegg = addRow ? { landgruppe: addRow.landgruppe, rate: num(addRow.rate), unit: addRow.unit,
    amount: krone(addRow.unit === 'P' ? customsValue * num(addRow.rate) / 100 : net * num(addRow.rate)) } : null;
  const tilleggAmount = tillegg?.amount ?? 0;

  // VAT: group 1 = 25 %, group 2 = 15 % (foodstuffs, chapters 01–24 only). Without levy data: 25 %, flagged.
  const mv = levyRows.filter(r => r.levy_type === 'MV');
  const low = mv.find(r => r.levy_group === 2), std = mv.find(r => r.levy_group === 1);
  const ch = Number(code.slice(0, 2));
  const useLow = !!low && ch >= 1 && ch <= 24;
  const vatRow = useLow ? low : std ?? low ?? null;
  const vatRate = vatRow ? num(vatRow.rate) : cx.levyDataLoaded ? null : 25;
  const dutySum = num(tl1.amount) + rtAmount + faAmount + saerAmount + tilleggAmount;
  const vatBase = customsValue + dutySum;
  const vat = { rate: vatRate, low: useLow, base: vatBase, source: vatRow ? 'TOLLETATEN' : vatRate != null ? 'DEFAULT' : 'NONE',
    amount: vatRate != null ? krone(vatBase * vatRate / 100) : null };

  const charged = (x: number | null | undefined) => (suspended ? 0 : num(x));
  return {
    line_no: it.line_no, code, suspended, customsValue, add45: round2(add45), ded45: round2(ded45), fromBox12: !!b12,
    tl1, unclaimedPref: unclaimedPref ? { landgruppe: unclaimedPref.landgruppe, rate: num(unclaimedPref.rate_value) } : null,
    rtRequired, rt, fa, saer, levyTypes: types, tillegg, vat,
    duty: charged(tl1.amount), rtAmount: charged(rtAmount), faAmount: charged(faAmount), saerAmount: charged(saerAmount),
    tilleggAmount: charged(tilleggAmount), vatAmount: charged(vat.amount),
    payable: charged(dutySum), total: charged(dutySum + num(vat.amount)),
    incomplete: !code || cx.fx == null || tl1.amount === null || tl1.manual || vat.amount === null
  };
}
export type ItemCalc = ReturnType<typeof calcItem>;

/** Levy types on a code that need a choice on the line (not MV or FA), each with its groups. */
export function levyTypes(rows: LevyRow[]) {
  const out: { type: string; text: string | null; groups: { group: string; text: string | null; rate: number; unit: string | null; unitText: string | null }[] }[] = [];
  for (const r of rows) {
    if (r.levy_type === 'MV' || r.levy_type === 'FA') continue;
    let t = out.find(x => x.type === r.levy_type);
    if (!t) out.push(t = { type: r.levy_type, text: r.levy_type_text, groups: [] });
    const g = String(r.levy_group ?? '');
    if (!t.groups.some(x => x.group === g)) t.groups.push({ group: g, text: r.levy_group_text, rate: num(r.rate), unit: r.unit, unitText: r.unit_text });
  }
  return out;
}

/* ------------------------------ the declaration ------------------------------ */
export function calculate(items: ItemInput[], cx: CalcContext) {
  const b12 = allocateBox12(cx.box12, items, cx.fx ?? 0, cx.currency);
  const lines = items.map((it, i) => calcItem(it, cx, b12.active ? { add: b12.add[i], ded: b12.ded[i] } : undefined));
  const sum = (k: keyof ItemCalc) => lines.reduce((s, l) => s + num(l[k] as unknown), 0);
  return {
    currency: cx.currency, fx: cx.fx, date: cx.date, box12: b12, lines,
    statValue: sum('customsValue'), duty: sum('duty'), rt: sum('rtAmount'), fa: sum('faAmount'), saer: sum('saerAmount'), tillegg: sum('tilleggAmount'),
    vatBase: lines.reduce((s, l) => s + (l.suspended ? 0 : l.vat.base), 0), vat: sum('vatAmount'),
    payable: sum('payable'), total: sum('total'),
    incomplete: lines.some(l => l.incomplete), suspended: lines.length > 0 && lines.every(l => l.suspended), levyDataLoaded: cx.levyDataLoaded
  };
}
export type DeclCalc = ReturnType<typeof calculate>;
