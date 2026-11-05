import crypto from 'node:crypto';

/**
 * TVINN simulator — reproduces the answers TVINN gives, transmits nothing (ODIN LINK src/tvinn/simulator.js).
 *
 *  * Errors in the check at send time (e.g. a declaration date that has aged past 90 days) → rejected, with
 *    TVINN's error number where the rule mirrors one.
 *  * A reference (box 7) containing "SIM-AVVIS" rehearses a rejection (9110, unknown credit agreement).
 *  * An even sequence number and a statistical value over 250 000 NOK rehearse statistical control
 *    (SIM_STAT_CHECK=off switches it off). A CHED consignment is accepted but held for the border control post.
 *  * Everything else is accepted and released, with an MRN and an expedition number.
 */
export interface Answer {
  result: 'ACCEPTED' | 'STAT_CHECK' | 'REJECTED';
  mrn: string | null; tvinnNo: string | null;
  decision: string; text: string;
  errors: { seq: number; number: string | null; rule: string; box: string; msg: string }[];
  simulator: true;
}

const RULE_NUMBER: Record<string, string> = { DATE_OLDER_365: '9017', DATE_OLDER_90: '9018', CREDIT_UNKNOWN: '9110', CREDIT_INACTIVE: '9111' };
const year2 = () => new Date().getFullYear().toString().slice(2);
const office6 = (o: unknown) => String(o ?? '').replace(/\D/g, '').padEnd(6, '0').slice(0, 6);
export const buildMrn = (office: unknown) => `${year2()}NO${office6(office)}${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
/** Ekspedisjons- og løpenummer: office (6) + year and 00 (4) + running number (6). */
export const buildTvinnNo = (office: unknown) => `${office6(office)} ${year2()}00 ${String(crypto.randomInt(0, 1e6)).padStart(6, '0')}`;
const kr = (n: number) => Math.round(n).toLocaleString('nb-NO');

export async function submit(s: any, current: { issues: any[] }, sequence: number, errorText: (n: string) => Promise<string | null>): Promise<Answer> {
  await new Promise(r => setTimeout(r, 50));
  const h = s.header, calc = s.calc ?? {};
  const errs = current.issues.filter(i => i.lvl === 'err').map((e, i) => ({ seq: i + 1, number: RULE_NUMBER[e.rule] ?? null, rule: e.rule, box: e.box, msg: e.msg }));
  if (/SIM-AVVIS/i.test(String(h.own_ref ?? '')))
    errs.push({ seq: errs.length + 1, number: '9110', rule: 'SIMULATED', box: '48', msg: (await errorText('9110')) ?? 'Deklaranten har ikke den oppgitte kredittavtalen.' });
  if (errs.length)
    return { result: 'REJECTED', mrn: null, tvinnNo: null, decision: 'Avvist i inndatakontrollen', simulator: true, errors: errs,
      text: 'SIMULATOR — TVINN avviste deklarasjonen i inndatakontrollen. Rett feilene og send inn deklarasjonen på nytt i sin helhet.' };

  // Export: an accepted declaration is cleared for exit at the exit office (box 29).
  if (h.direction === 'EXPORT')
    return { result: 'ACCEPTED', mrn: buildMrn(h.exit_office ?? h.office), tvinnNo: buildTvinnNo(h.exit_office ?? h.office ?? '443091'), errors: [], simulator: true,
      decision: 'Klarert for utførsel',
      text: `SIMULATOR — utførselsdeklarasjonen er godkjent. Statistisk verdi ${kr(calc.statValue ?? 0)} kr.` +
        (calc.levy > 0 ? ` Utførselsavgift ${kr(calc.levy)} kr belastes konto ${h.payment_account ?? '—'}.` : '') +
        (h.exit_office ? ` Varene skal passere utpasseringstollsted ${h.exit_office}.` : '') };

  const ched = (s.items ?? []).some((it: any) => (Array.isArray(it.docs) ? it.docs : []).some((d: any) => String(d.code).toUpperCase() === 'VT' && /CHED/i.test(String(d.ref ?? ''))));
  const stat = String(process.env.SIM_STAT_CHECK ?? 'on').toLowerCase() !== 'off' && sequence % 2 === 0 && Number(calc.statValue) > 250000 && !ched;
  const mrn = buildMrn(h.office), tvinnNo = buildTvinnNo(h.office);
  if (stat)
    return { result: 'STAT_CHECK', mrn, tvinnNo, errors: [], simulator: true, decision: 'Tatt ut til statistisk kontroll',
      text: 'SIMULATOR (øvelse) — deklarasjonen er tatt ut til statistisk kontroll. Kontroller de deklarerte opplysningene; dette er ikke en avvisning. ' +
        'Simulatoren tar ut deklarasjoner med partall løpenummer og statistisk verdi over 250 000 kr.' };
  return { result: 'ACCEPTED', mrn, tvinnNo, errors: [], simulator: true,
    decision: ched ? 'Holdt tilbake i påvente av veterinærkontroll' : 'Frigitt',
    text: `SIMULATOR — deklarasjonen er godkjent. Statistisk verdi ${kr(calc.statValue ?? 0)} kr; toll og avgifter ${kr(calc.payable ?? 0)} kr` +
      `${h.payment_account ? ` belastes konto ${h.payment_account}` : ''}; merverdiavgift ${kr(calc.vat ?? 0)} kr.` +
      (ched ? ' Sendingen krever CHED — frigivelse forutsetter vedtak fra grensekontrollstasjonen.' : ' Varene er frigitt for den deklarerte prosedyren.') };
}
