import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.js';

/**
 * Digitoll rules (phase 3b), carried over from ODIN LINK src/digitoll/rules.js. Tolletaten's procedure table
 * (variants.json) and code lists (codes.json) are their own published files, kept in server/reference/digitoll.
 *
 *  'err'        = Tolletaten rejects the message
 *  'incomplete' = accepted but INCOMPLETE until completed (at the latest at the border), with Tolletaten's reason
 *  'warn'       = advice
 */
export type Kind = 'TRANSPORT' | 'MASTER' | 'HOUSE';
export interface DtIssue { lvl: 'err' | 'incomplete' | 'warn'; path: string; rule: string; msg: string; reason?: string }

const DIR = path.join(ROOT, 'server', 'reference', 'digitoll');
let cache: { variants: Record<string, any>; codes: Record<string, any> } | null = null;
export function reference() {
  if (!cache) cache = { variants: JSON.parse(fs.readFileSync(path.join(DIR, 'variants.json'), 'utf8')), codes: JSON.parse(fs.readFileSync(path.join(DIR, 'codes.json'), 'utf8')) };
  return cache;
}

const blank = (v: unknown) => v === undefined || v === null || String(v).trim() === '';
export const get = (o: any, p: string) => p.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
const asList = (v: unknown) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const ROAD_IDENT: Record<string, string> = { '2': '21', '3': '30', '4': '41' };

/** Fields that cannot change after an MRN (Tolletaten). */
export const IMMUTABLE: Record<Kind, string[]> = {
  TRANSPORT: ['activeBorderTransportMeans.identificationNumber', 'activeBorderTransportMeans.typeOfIdentification', 'activeBorderTransportMeans.conveyanceReferenceNumber', 'scheduledDateAndTimeOfArrival'],
  MASTER: ['consignmentMasterLevel.transportDocumentMasterLevel.documentNumber', 'consignmentMasterLevel.transportDocumentMasterLevel.type', 'consignmentMasterLevel.carrier.identificationNumber'],
  HOUSE: ['consignmentHouseLevel.transportDocumentHouseLevel.documentNumber', 'consignmentHouseLevel.transportDocumentHouseLevel.type']
};
export const changedKeys = (kind: Kind, before: any, after: any) => IMMUTABLE[kind].filter(p => String(get(before, p) ?? '') !== String(get(after, p) ?? ''));

/** What every message must have before it is worth sending. */
const REQUIRED: Record<Kind, [string, string][]> = {
  TRANSPORT: [['activeBorderTransportMeans.identificationNumber', 'Registreringsnummer'], ['activeBorderTransportMeans.countryCode', 'Kjøretøyets nasjonalitet'],
    ['scheduledDateAndTimeOfArrival', 'Planlagt ankomst'], ['customsOfficeOfFirstEntry.referenceNumber', 'Tollsted ved første ankomst'], ['carrier.name', 'Transportør']],
  MASTER: [['consignmentMasterLevel.transportDocumentMasterLevel.documentNumber', 'Transportdokumentnummer'], ['consignmentMasterLevel.transportDocumentMasterLevel.type', 'Dokumenttype'],
    ['consignmentMasterLevel.grossMass', 'Bruttovekt'], ['consignmentMasterLevel.consignor.name', 'Avsender'], ['consignmentMasterLevel.consignee.name', 'Mottaker']],
  HOUSE: [['consignmentHouseLevel.transportDocumentHouseLevel.documentNumber', 'Transportdokumentnummer'], ['consignmentHouseLevel.transportDocumentHouseLevel.type', 'Dokumenttype'],
    ['consignmentHouseLevel.goodsDescription', 'Varebeskrivelse'], ['consignmentHouseLevel.numberOfPackages', 'Antall kolli'], ['consignmentHouseLevel.totalGrossMass', 'Bruttovekt'],
    ['consignmentHouseLevel.consignor.name', 'Avsender'], ['consignmentHouseLevel.consignee.name', 'Mottaker']]
};

function checkParty(party: any, label: string, p: string, add: (i: DtIssue) => void) {
  if (!party) return;
  const a = party.address || {};
  if (blank(a.streetLine) && blank(a.poBox)) add({ lvl: 'err', path: `${p}.address`, rule: 'ADDRESS_LINE', msg: `${label}: gateadresse eller postboks må fylles ut.` });
  if (blank(a.country)) add({ lvl: 'err', path: `${p}.address.country`, rule: 'ADDRESS_COUNTRY', msg: `${label}: land må fylles ut.` });
}

function candidates(ip: string, op: string) {
  return Object.entries(reference().variants).filter(([, v]: [string, any]) => v.values.importProcedure === ip && v.values.outgoingProcedure === op).map(([no, v]: [string, any]) => ({ no: Number(no), ...v }));
}

function checkProcedure(h: any, add: (i: DtIssue) => void): number | null {
  const proc = h.importProcedure || {}, ip = proc.importProcedure;
  const docs: any[] = h.previousDocuments || [], exports: any[] = h.exportFromEU || [], goods: any[] = h.goodsItem || [];
  if (blank(ip)) {
    if (docs.length) add({ lvl: 'err', path: 'consignmentHouseLevel.importProcedure', rule: 'PROC_REQUIRED', msg: 'Tollprosedyre er påkrevd når det er oppgitt dokumentreferanser.' });
    else add({ lvl: 'incomplete', path: 'consignmentHouseLevel.importProcedure', rule: 'PROC_MISSING', msg: 'Tollprosedyre er ikke valgt.', reason: 'INCOMPLETE_DOCUMENTATION' });
    return null;
  }
  const op = blank(proc.outgoingProcedure) ? '-' : proc.outgoingProcedure;
  if (op === '-' && proc.hasOutgoingProcedure !== false && ip !== 'IMMEDIATE_RELEASE_VOEC')
    add({ lvl: 'err', path: 'consignmentHouseLevel.importProcedure.hasOutgoingProcedure', rule: 'OUTGOING_FLAG', msg: 'Uten prosedyre fram til grensen må «har prosedyre fram til grensen» være Nei.' });
  if (op !== '-' && proc.hasOutgoingProcedure === false)
    add({ lvl: 'err', path: 'consignmentHouseLevel.importProcedure.hasOutgoingProcedure', rule: 'OUTGOING_FLAG', msg: '«Har prosedyre fram til grensen» er Nei, men en prosedyre er oppgitt.' });
  const cands = candidates(ip, op);
  if (!cands.length) { add({ lvl: 'err', path: 'consignmentHouseLevel.importProcedure', rule: 'PROC_COMBINATION', msg: `Kombinasjonen ${ip} / ${op} finnes ikke i Tolletatens prosedyretabell.` }); return null; }
  const types = new Set(docs.map(d => d.typeOfReference));
  const missing = (v: any) => {
    const docsMiss = asList(v.values.typeOfReference).filter(Boolean).filter((t: string) => !types.has(t));
    const exp = v.values.exportId === true && !exports.length, voec = v.values.value === true && !goods.length;
    return { docs: docsMiss as string[], exp, voec, count: docsMiss.length + (exp ? 1 : 0) + (voec ? 1 : 0) };
  };
  const best = cands.map(v => ({ v, m: missing(v) })).sort((a, b) => a.m.count - b.m.count)[0];
  const reasons: string[] = best.v.values.incompleteDocumentationReason || [];
  const reasonFor = (t: string) => (t === 'CUDE' ? 'INCOMPLETE_CUDE_DOCUMENTATION' : t === 'N820' || t === 'RETR' ? 'INCOMPLETE_TRA_DOCUMENTATION' : t === 'GONU' ? 'INCOMPLETE_GONU_DOCUMENTATION' : 'INCOMPLETE_DOCUMENTATION');
  for (const t of best.m.docs) add({ lvl: 'incomplete', path: 'consignmentHouseLevel.previousDocuments', rule: 'PREVDOC_MISSING',
    msg: `Variant ${best.v.no}: dokumentreferanse av type ${t} mangler. Må være på plass senest ved grensepassering.`, reason: reasons.includes(reasonFor(t)) ? reasonFor(t) : 'INCOMPLETE_DOCUMENTATION' });
  if (best.m.exp) add({ lvl: 'incomplete', path: 'consignmentHouseLevel.exportFromEU', rule: 'EXPORT_MISSING', msg: `Variant ${best.v.no}: eksportreferanse fra EU mangler.`, reason: 'INCOMPLETE_EXP_DOCUMENTATION' });
  if (best.m.voec) add({ lvl: 'incomplete', path: 'consignmentHouseLevel.goodsItem', rule: 'VOEC_MISSING', msg: `Variant ${best.v.no}: VOEC-varelinjer mangler.`, reason: 'INCOMPLETE_VOEC_DOCUMENTATION' });
  const allowed: string[] = asList(best.v.values.typeOfExport).filter(Boolean);
  exports.forEach((e, i) => { if (allowed.length && e.typeOfExport && !allowed.includes(e.typeOfExport))
    add({ lvl: 'err', path: `consignmentHouseLevel.exportFromEU[${i}].typeOfExport`, rule: 'EXPORT_TYPE', msg: `Eksporttypen må være en av ${allowed.join(', ')}.` }); });
  return best.v.no;
}

function checkHouse(body: any, add: (i: DtIssue) => void) {
  const h = body?.consignmentHouseLevel || {}, proc = h.importProcedure || {};
  const docs: any[] = h.previousDocuments || [], exports: any[] = h.exportFromEU || [], goods: any[] = h.goodsItem || [];
  if (docs.filter(d => d.typeOfReference === 'CUDE').length > 1) add({ lvl: 'err', path: 'consignmentHouseLevel.previousDocuments', rule: 'CUDE_ONE', msg: 'Bare én tolldeklarasjon (CUDE) per forsendelse.' });
  const seen = new Set<string>();
  docs.forEach((d, i) => {
    const p = `consignmentHouseLevel.previousDocuments[${i}]`;
    if (d.typeOfReference === 'CUDE') {
      for (const k of ['declarantNumber', 'declarationDate', 'sequenceNumber']) if (blank(d[k])) add({ lvl: 'err', path: `${p}.${k}`, rule: 'CUDE_FIELD', msg: `CUDE-referansen mangler ${k === 'declarantNumber' ? 'deklarantnummer' : k === 'declarationDate' ? 'deklarasjonsdato' : 'sekvensnummer'}.` });
      if (!blank(d.referenceNumber)) add({ lvl: 'err', path: `${p}.referenceNumber`, rule: 'CUDE_EITHER', msg: 'En CUDE-referanse oppgis med deklarantnummer, dato og sekvensnummer — ikke referansenummer.' });
      if (!blank(d.sequenceNumber) && !/^\d+$/.test(String(d.sequenceNumber))) add({ lvl: 'err', path: `${p}.sequenceNumber`, rule: 'SEQ_DIGITS', msg: 'Sekvensnummeret kan bare inneholde siffer.' });
    } else if (d.typeOfReference) {
      if (blank(d.referenceNumber)) add({ lvl: 'err', path: `${p}.referenceNumber`, rule: 'REF_REQUIRED', msg: `Referansenummer er påkrevd for ${d.typeOfReference}.` });
      else { if (seen.has(d.referenceNumber)) add({ lvl: 'err', path: `${p}.referenceNumber`, rule: 'REF_DUPLICATE', msg: `Referansen ${d.referenceNumber} er oppgitt to ganger.` }); seen.add(d.referenceNumber); }
      if (d.typeOfReference === 'N820' && proc.outgoingProcedure === 'EXP') add({ lvl: 'err', path: `${p}.typeOfReference`, rule: 'N820_WITH_EXP', msg: 'Transitt (N820) kan ikke oppgis når prosedyren fram til grensen er eksport.' });
    }
  });
  if (exports.length && proc.outgoingProcedure === 'TRA') add({ lvl: 'err', path: 'consignmentHouseLevel.exportFromEU', rule: 'EXPORT_WITH_TRA', msg: 'Eksportreferanse kan ikke oppgis når prosedyren fram til grensen er transitt.' });
  exports.forEach((e, i) => {
    const id = String(e.exportId || ''), p = `consignmentHouseLevel.exportFromEU[${i}].exportId`;
    if (e.typeOfExport === 'AES_EXPORT' && id.length !== 18) add({ lvl: 'err', path: p, rule: 'EXPORT_FORMAT', msg: 'AES-eksport-ID skal ha 18 tegn.' });
  });
  if (goods.length && proc.importProcedure !== 'IMMEDIATE_RELEASE_VOEC') add({ lvl: 'err', path: 'consignmentHouseLevel.goodsItem', rule: 'GOODS_NOT_VOEC', msg: 'VOEC-varelinjer kan bare oppgis med prosedyren IMMEDIATE_RELEASE_VOEC.' });
  goods.forEach((g, i) => { if ((g.itemAmountInvoicedVOEC?.value ?? 0) > 3000) add({ lvl: 'err', path: `consignmentHouseLevel.goodsItem[${i}]`, rule: 'VOEC_LIMIT', msg: 'VOEC-vare over 3 000 kr — bruk ordinær innførselsdeklarasjon.' }); });
  if (proc.importProcedure === 'WAREHOUSE_RELEASE' && docs.some(d => d.typeOfReference === 'CUDE'))
    add({ lvl: 'warn', path: 'consignmentHouseLevel.importProcedure', rule: 'WAREHOUSE_CUDE', msg: 'Innlegg på tollager med CUDE: kontroller den første mot dagens Digitoll-system (Tolletatens dokumentasjon er ikke entydig her).' });
  checkParty(h.consignor, 'Avsender', 'consignmentHouseLevel.consignor', add);
  checkParty(h.consignee, 'Mottaker', 'consignmentHouseLevel.consignee', add);
  return checkProcedure(h, add);
}

function checkMaster(body: any, add: (i: DtIssue) => void) {
  const m = body?.consignmentMasterLevel || {};
  if (Number(m.containerIndicator) === 1 && !(m.transportEquipment || []).length)
    add({ lvl: 'err', path: 'consignmentMasterLevel.transportEquipment', rule: 'EQUIPMENT_REQUIRED', msg: 'Container er Ja — transportutstyr (containernummer) må oppgis.' });
  checkParty(m.consignor, 'Avsender', 'consignmentMasterLevel.consignor', add);
  checkParty(m.consignee, 'Mottaker', 'consignmentMasterLevel.consignee', add);
}

function checkTransport(mode: string, body: any, children: number, add: (i: DtIssue) => void) {
  const a = body?.activeBorderTransportMeans || {};
  if (mode === 'ROAD' && a.modeOfTransportCode && a.typeOfIdentification && ROAD_IDENT[a.modeOfTransportCode] && ROAD_IDENT[a.modeOfTransportCode] !== String(a.typeOfIdentification))
    add({ lvl: 'err', path: 'activeBorderTransportMeans.typeOfIdentification', rule: 'IDENT_MODE', msg: `Transportmåte ${a.modeOfTransportCode} skal ha identifikasjonstype ${ROAD_IDENT[a.modeOfTransportCode]}.` });
  if (a.identificationNumber && /[^A-Za-z0-9]/.test(a.identificationNumber))
    add({ lvl: 'warn', path: 'activeBorderTransportMeans.identificationNumber', rule: 'IDENT_CHARS', msg: 'Bruk bare bokstaver og tall i registreringsnummeret (ingen mellomrom), og bare trekkvognens nummer.' });
  if (body?.scheduledDateAndTimeOfArrival && body?.estimatedDateAndTimeOfArrival
    && Math.abs(Date.parse(body.estimatedDateAndTimeOfArrival) - Date.parse(body.scheduledDateAndTimeOfArrival)) > 72 * 3600e3)
    add({ lvl: 'warn', path: 'estimatedDateAndTimeOfArrival', rule: 'ARRIVAL_GAP', msg: 'Forventet ankomst avviker mer enn 72 timer fra planlagt. Tolletaten kansellerer transporter 72 timer etter forventet ankomst uten registrert ankomst.' });
  if (!children) add({ lvl: 'incomplete', path: 'consignmentMasterLevel', rule: 'NO_CONSIGNMENTS', msg: 'Transporten har ingen hovedforsendelser eller forsendelser. Listen må være komplett ved grensepassering.', reason: 'INCOMPLETE_DOCUMENTATION' });
}

/** All rules for one message. `children` = linked masters/houses (transport only). */
export function check(kind: Kind, mode: string, body: any, children = 0) {
  const issues: DtIssue[] = [];
  const add = (i: DtIssue) => issues.push(i);
  for (const [p, label] of REQUIRED[kind]) {
    const v = get(body, p);
    if (blank(v) || (typeof v === 'number' && v <= 0)) add({ lvl: 'err', path: p, rule: 'REQUIRED', msg: `${label} må fylles ut.` });
  }
  let variant: number | null = null;
  if (kind === 'HOUSE') variant = checkHouse(body, add);
  if (kind === 'MASTER') checkMaster(body, add);
  if (kind === 'TRANSPORT') checkTransport(mode, body, children, add);
  return { issues, variant, ok: !issues.some(i => i.lvl === 'err') };
}
