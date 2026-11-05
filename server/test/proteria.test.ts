import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { calculate, type CalcContext, type ItemInput } from '../src/declarations/calc.js';

/**
 * The calculation against two declarations accepted by Tolletaten (made in Proteria), to the krone.
 * The declarations are real client data, so they live outside the code folder (C:\OdinAI-testdata\proteria,
 * or PROTERIA_DIR) together with the rates for their commodity codes as loaded from data.toll.no. Without
 * that folder the test is skipped.
 */
const DIR = process.env.PROTERIA_DIR || 'C:\\OdinAI-testdata\\proteria';
const has = fs.existsSync(path.join(DIR, 'rates.json'));
const read = (f: string) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));

function context(date: string, fx: number, extra: Partial<CalcContext> = {}): CalcContext {
  const R = read('rates.json');
  const on = (r: any) => (!r.valid_from || r.valid_from <= date) && (!r.valid_to || r.valid_to >= date);
  const rates: CalcContext['rates'] = {}, levies: CalcContext['levies'] = {}, groupsOf: CalcContext['groupsOf'] = {};
  for (const r of R.tariff_rate.filter(on).sort((a: any, b: any) => (b.valid_from > a.valid_from ? 1 : -1))) {
    const l = (rates[r.code] ??= []);
    if (!l.some(x => x.landgruppe === r.landgruppe && x.duty_code === r.duty_code)) l.push(r);
  }
  for (const r of R.innforsel_avgift.filter(on))
    (levies[r.code] ??= []).push({ levy_type: r.avgiftstype, levy_type_text: r.avgiftstype_text, levy_group: r.avgiftsgruppe, levy_group_text: r.avgiftsgruppe_text, rate: r.sats, unit: r.enhet, unit_text: r.enhet_text });
  for (const r of R.landgruppe_country.filter(on)) (groupsOf[r.country_code] ??= []).push(r.landgruppe);
  return { date, currency: 'EUR', fx, declType: '4', groupsOf, rates, levies, levyDataLoaded: true, additional: {}, permits: {}, importerOrg: null, box12: [], ...extra };
}

describe.skipIf(!has)('calculation against declarations accepted by Tolletaten', () => {
  it('Proteria 446040 2600 234081: 77 items, freight 10 000 NOK by gross mass, sugar levy, a USK permit', () => {
    const fx = read('proteria-4460402600234081.json');
    const items: ItemInput[] = fx.items.map((i: any) => ({
      line_no: i.no, code: i.hs, origin: i.orig, preference: i.pref, procedure: i.proc, gross_kg: i.gross, net_kg: i.net, price: i.price,
      product_id: i.no === 52 ? 'maggi' : null,
      levies: i.hs === '17011490' ? [{ type: 'SU', group: '100', qty: i.net }] : [],
      docs: i.no === 52 ? [{ code: 'USK', ref: '26/R595399' }] : []
    }));
    // The importer's USK decision for item 52 (Maggi noodles), as declared in box 44.
    const permits = { maggi: [{ id: 'p', permit_no: 'RT-T', product_name: 'MAGGI NOODLES', holder_org_no: null, rate_tall: 1.9, skriv_tall: '26/R595399',
      rate_toes: 0, skriv_toes: '26/R595398', valid_from: '2026-01-01', valid_to: '2029-01-01' }] };
    const c = calculate(items, context(fx.header.date, fx.header.rate, { permits, box12: [{ kind: 'ADD', type: 'FRAKT', amount: 10000, currency: 'NOK', basis: 'GROSS' }] }));
    let stat = 0, mv = 0, adj = 0;
    fx.items.forEach((p: any, k: number) => {
      const l = c.lines[k];
      // The krone remainder goes to the heaviest item so box 12 adds up to exactly 10 000; Proteria's shares added up to 9 998.
      if (Math.abs(l.add45 - p.adj) > (p.no === 52 ? 2 : 1)) adj++;
      if (l.customsValue !== p.stat) stat++;
      if (l.vatAmount !== p.mv) mv++;
    });
    expect(adj).toBe(0);
    expect(stat).toBeLessThanOrEqual(3);
    expect(mv).toBeLessThanOrEqual(3);
    const T = fx.header.totals;
    expect(c.duty).toBe(T.TL);
    expect(c.rt).toBe(T.RT);
    expect(Math.abs(c.fa - T.FA)).toBeLessThanOrEqual(1);
    expect(c.saer).toBe(T.SU);
    expect(Math.abs(c.vat - T.MV)).toBeLessThanOrEqual(2);
    expect(Math.abs(c.statValue - T.statValue)).toBeLessThanOrEqual(2);
    expect(Math.abs(c.payable - T.payableExclMva)).toBeLessThanOrEqual(1);
    expect(c.box12.addTotal).toBe(10000);
    // Without the permit, item 52 is charged the full published rate (the 5 158 NOK difference ODIN LINK once had).
    const without = calculate(items, context(fx.header.date, fx.header.rate, { box12: [{ kind: 'ADD', type: 'FRAKT', amount: 10000, currency: 'NOK', basis: 'GROSS' }] }));
    expect(without.lines[51].rt!.status).toBe('PUBLISHED_RATE');
    expect(without.rt - c.rt).toBeGreaterThan(5000);
  });

  it('Proteria 441002 2600 548405: 26 items from India, box 36 = G uses the GSP group (TGS3), not the EFTA–India group', () => {
    const fx = read('proteria-4410022600548405.json');
    const items: ItemInput[] = fx.items.map((i: any) => ({ line_no: i.no, code: i.hs, origin: i.orig, preference: i.pref, procedure: i.proc,
      gross_kg: i.gross, net_kg: i.net, price: i.price, docs: i.pref === 'G' ? [{ code: 'SER', ref: 'INREX0307015203EC003' }] : [] }));
    const c = calculate(items, context(fx.header.date, fx.header.rate));
    fx.items.forEach((p: any, k: number) => {
      expect(c.lines[k].customsValue, `item ${p.no} box 46`).toBe(p.stat);
      expect(c.lines[k].vatAmount, `item ${p.no} VAT`).toBe(p.mv);
    });
    expect(c.lines[22].duty).toBe(79);
    expect(c.lines[22].tl1.landgruppe).toBe('TGS3');
    const T = fx.header.totals;
    expect([c.duty, c.fa, c.vat, c.payable]).toEqual([T.TL, T.FA, T.MV, T.payableExclMva]);
  });
});
