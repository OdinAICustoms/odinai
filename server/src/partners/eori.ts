/**
 * EORI check against the European Commission's EOS validation service (SOAP, open).
 * Covers EU member states and XI. Norwegian EORIs (NO + org. no.) are checked through Brønnøysund;
 * GB EORIs are held by HMRC. At most 10 numbers per request.
 */
import { HttpError } from '../errors.js';

const URL_ = () => process.env.EORI_BASE || 'https://ec.europa.eu/taxation_customs/dds2/eos/validation/services/validation';
const TIMEOUT = Number(process.env.EORI_TIMEOUT_MS || 20000);
export const EU = ['AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU',
  'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK', 'XI'];
const clean = (e: unknown) => String(e || '').replace(/\s/g, '').toUpperCase();

/** Can the EU service check this EORI? */
export function applicability(eori: string): { ok: boolean; reason?: string } {
  const e = clean(eori), cc = e.slice(0, 2);
  if (!/^[A-Z]{2}[A-Z0-9]{1,15}$/.test(e)) return { ok: false, reason: 'Ugyldig EORI-format (2 bokstaver + inntil 15 tegn).' };
  if (cc === 'NO') return { ok: false, reason: 'Norsk EORI: kontrolleres via Brønnøysund (organisasjonsnummer).' };
  if (cc === 'GB') return { ok: false, reason: 'GB-EORI: registrert hos HMRC (UK), ikke i EUs register.' };
  if (!EU.includes(cc)) return { ok: false, reason: `${cc}-EORI finnes ikke i EUs register.` };
  return { ok: true };
}

const esc = (s: string) => s.replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]!));
const tag = (xml: string, name: string) => xml.match(new RegExp(`<(?:\\w+:)?${name}>([\\s\\S]*?)</(?:\\w+:)?${name}>`))?.[1]?.trim() ?? null;
const unxml = (s: string | null) => s == null ? null : s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

export interface EoriResult { eori: string; valid: boolean; statusDescr: string; name: string | null; address: string | null }

export async function validate(list: string[]): Promise<EoriResult[]> {
  const eoris = [...new Set(list.map(clean))].slice(0, 10);
  const body = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>` +
    `<ev:validateEORI xmlns:ev="http://eori.ws.eos.dds.s/">${eoris.map(e => `<ev:eori>${esc(e)}</ev:eori>`).join('')}</ev:validateEORI></soap:Body></soap:Envelope>`;
  let r: Response;
  try {
    r = await fetch(URL_(), { method: 'POST', headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '' }, body, signal: AbortSignal.timeout(TIMEOUT) });
  } catch (e: any) { throw new HttpError(502, `EUs EORI-tjeneste kunne ikke nås (${e?.cause?.code || e?.name}).`, 'EORI'); }
  const xml = await r.text();
  if (!r.ok) throw new HttpError(502, `EUs EORI-tjeneste svarte ${r.status}${tag(xml, 'faultstring') ? ': ' + tag(xml, 'faultstring') : ''}.`, 'EORI');
  const out = [...xml.matchAll(/<(?:\w+:)?result>([\s\S]*?)<\/(?:\w+:)?result>/g)].map(m => {
    const x = m[1], status = tag(x, 'status'), descr = unxml(tag(x, 'statusDescr')) || '';
    const address = [tag(x, 'street') || tag(x, 'address'), [tag(x, 'postalCode'), tag(x, 'city')].filter(Boolean).join(' '), tag(x, 'country')]
      .filter(Boolean).map(unxml).join(', ');
    return { eori: clean(tag(x, 'eori')), valid: status === '0' || (/valid/i.test(descr) && !/not\s*valid|invalid/i.test(descr)), statusDescr: descr,
      name: unxml(tag(x, 'name')), address: address || null };
  });
  if (!out.length) throw new HttpError(502, 'EUs EORI-tjeneste ga ikke noe svar.', 'EORI');
  return out;
}
