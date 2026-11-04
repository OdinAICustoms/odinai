/**
 * Business Partner rules — pure functions, no database. Carried over from ODIN LINK
 * (src/partner-validation.js), with the same messages so users recognise them.
 */
export interface Finding { lvl: 'err' | 'warn'; rule: string; msg: string }

export const ROLES: Record<string, { no: string; en: string; box: string | null }> = {
  IMP: { no: 'Importør', en: 'Importer', box: '8' },
  CON: { no: 'Mottaker', en: 'Consignee', box: '8' },
  EXP: { no: 'Eksportør', en: 'Exporter', box: '2' },
  CNR: { no: 'Avsender', en: 'Consignor', box: '2' },
  DEC: { no: 'Deklarant', en: 'Declarant', box: '14' },
  REP: { no: 'Representant', en: 'Representative', box: '14' },
  DEB: { no: 'Tollskyldner', en: 'Customs debtor', box: null },
  PTH: { no: 'Tillatelsesinnehaver', en: 'Permit holder', box: null },
  WHL: { no: 'Lagerholder', en: 'Warehouse keeper', box: null },
  CAR: { no: 'Transportør', en: 'Carrier', box: null },
  SUP: { no: 'Leverandør', en: 'Supplier', box: null }
};
/** The roles a partner needs to stand in a declaration box. */
export const BOX_ROLES: Record<string, string[]> = { f2: ['EXP', 'CNR'], f8: ['IMP', 'CON'], f14: ['DEC', 'REP'] };

export const ADDRESS_TYPES: Record<string, string> = {
  REGISTERED: 'Forretningsadresse', POSTAL: 'Postadresse', DELIVERY: 'Leveringsadresse', WAREHOUSE: 'Lager',
  GOODS_LOCATION: 'Varens plassering', CORRESPONDENCE: 'Korrespondanse', INVOICE: 'Fakturaadresse'
};
export const IDENTIFIER_TYPES: Record<string, string> = {
  ORG_NO: 'Organisasjonsnummer', PERSON_NO: 'Fødselsnummer', VAT_NO: 'MVA-nummer', EORI: 'EORI',
  NODI_ID: 'Nodi ID', PROTERIA_NO: 'Proteria kundenr.', EXTERNAL_ID: 'Ekstern ID'
};
export const CONTACT_TYPES: Record<string, string> = { CUSTOMS: 'Toll', GENERAL: 'Generell', FINANCE: 'Økonomi' };
export const RELATIONSHIP_TYPES: Record<string, string> = {
  PARENT_OF: 'Morselskap for', SUBSIDIARY_OF: 'Datterselskap av', GOODS_STORED_BY: 'Varer lagres hos', BROKER_FOR: 'Speditør for', OTHER: 'Annet'
};
export const CATEGORIES: Record<string, string> = { ORGANIZATION: 'Organisasjon', PERSON: 'Person' };

const blank = (v: unknown) => v === undefined || v === null || String(v).trim() === '';
export const digits = (v: unknown) => String(v ?? '').replace(/\D/g, '');

/** Brønnøysund organisation number: 9 digits, modulus 11 with weights 3 2 7 6 5 4 3 2. */
export function validOrgNo(v: unknown): boolean {
  const d = String(v ?? '').replace(/\s/g, '');
  if (!/^\d{9}$/.test(d)) return false;
  const w = [3, 2, 7, 6, 5, 4, 3, 2];
  let c = 11 - (w.reduce((s, x, i) => s + x * Number(d[i]), 0) % 11);
  if (c === 11) c = 0;
  return c !== 10 && c === Number(d[8]);
}
/** Fødselsnummer / D-number: 11 digits, two modulus-11 check digits. */
export function validPersonNo(v: unknown): boolean {
  const d = String(v ?? '').replace(/\s/g, '');
  if (!/^\d{11}$/.test(d)) return false;
  const n = [...d].map(Number);
  const k = (w: number[]) => { const c = 11 - (w.reduce((s, x, i) => s + x * n[i], 0) % 11); return c === 11 ? 0 : c; };
  const k1 = k([3, 7, 6, 1, 8, 9, 4, 5, 2]), k2 = k([5, 4, 3, 2, 7, 6, 5, 4, 3, 2]);
  return k1 !== 10 && k2 !== 10 && k1 === n[9] && k2 === n[10];
}
export const maskPersonNo = (v: string | null) => (v ? v.slice(0, 6) + '*****' : v);
export const searchName = (name: unknown) => String(name || '').toUpperCase().replace(/[^A-Z0-9ÆØÅÄÖÜ]+/g, ' ').trim();
export const formatOrgNo = (v: unknown) => { const d = digits(v); return d.length === 9 ? `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}` : String(v ?? ''); };

const day = (d: unknown) => (d ? String(d).slice(0, 10) : null);
/** Two date ranges overlap (open ends allowed). */
export function overlaps(a: { valid_from?: unknown; valid_to?: unknown }, b: { valid_from?: unknown; valid_to?: unknown }) {
  const aF = day(a.valid_from) || '0000-01-01', aT = day(a.valid_to) || '9999-12-31';
  const bF = day(b.valid_from) || '0000-01-01', bT = day(b.valid_to) || '9999-12-31';
  return aF <= bT && bF <= aT;
}
/** Is a dated row in force on a date? */
export function inForce(r: { status?: string; valid_from?: unknown; valid_to?: unknown }, date: string) {
  if (r.status && r.status !== 'ACTIVE') return false;
  const f = day(r.valid_from), t = day(r.valid_to);
  return !(f && f > date) && !(t && t < date);
}
const dates = (r: { valid_from?: unknown; valid_to?: unknown }, out: Finding[], rule: string) => {
  const f = day(r.valid_from), t = day(r.valid_to);
  if (f && t && t < f) out.push({ lvl: 'err', rule, msg: 'Gyldig til er før gyldig fra.' });
};

export function checkPartner(p: { legal_name?: string; category?: string; registration_country?: string }): Finding[] {
  const out: Finding[] = [];
  if (blank(p.legal_name)) out.push({ lvl: 'err', rule: 'NAME_REQUIRED', msg: 'Juridisk navn er påkrevd.' });
  if (!CATEGORIES[p.category ?? '']) out.push({ lvl: 'err', rule: 'CATEGORY', msg: 'Kategori må være Organisasjon eller Person.' });
  if (!/^[A-Z]{2}$/.test(String(p.registration_country || ''))) out.push({ lvl: 'err', rule: 'COUNTRY', msg: 'Land må være en ISO-kode med to bokstaver.' });
  return out;
}

export function checkIdentifier(i: { identifier_type?: string; identifier_value?: string; issuing_country?: string | null }): Finding[] {
  const out: Finding[] = [];
  if (!IDENTIFIER_TYPES[i.identifier_type ?? '']) out.push({ lvl: 'err', rule: 'IDENTIFIER_TYPE', msg: 'Ukjent identifikatortype.' });
  if (blank(i.identifier_value)) { out.push({ lvl: 'err', rule: 'IDENTIFIER_VALUE', msg: 'Identifikatorens verdi er påkrevd.' }); return out; }
  const v = String(i.identifier_value).replace(/\s/g, '');
  if (i.identifier_type === 'ORG_NO' && (i.issuing_country || 'NO') === 'NO') {
    if (!/^\d{9}$/.test(v)) out.push({ lvl: 'err', rule: 'ORG_NO_FORMAT', msg: 'Et norsk organisasjonsnummer har 9 siffer.' });
    else if (!validOrgNo(v)) out.push({ lvl: 'warn', rule: 'ORG_NO_CHECKSUM', msg: `Organisasjonsnummer ${v} feiler Brønnøysunds kontrollsiffer — kontroller for skrivefeil.` });
  }
  if (i.identifier_type === 'PERSON_NO') {
    if (!/^\d{11}$/.test(v)) out.push({ lvl: 'err', rule: 'PERSON_NO_FORMAT', msg: 'Et fødselsnummer har 11 siffer.' });
    else if (!validPersonNo(v)) out.push({ lvl: 'warn', rule: 'PERSON_NO_CHECKSUM', msg: 'Fødselsnummeret feiler kontrollsifrene — kontroller for skrivefeil.' });
  }
  if (i.identifier_type === 'EORI' && !/^[A-Z]{2}[A-Z0-9]{1,15}$/.test(v.toUpperCase()))
    out.push({ lvl: 'err', rule: 'EORI_FORMAT', msg: 'Et EORI-nummer begynner med landkode på to bokstaver fulgt av inntil 15 tegn.' });
  return out;
}

/** Only one standard address may be in force at any moment. */
export function checkAddress(a: any, others: any[]): Finding[] {
  const out: Finding[] = [];
  if (!ADDRESS_TYPES[a.address_type]) out.push({ lvl: 'err', rule: 'ADDRESS_TYPE', msg: 'Ukjent adressetype.' });
  if (!/^[A-Z]{2}$/.test(String(a.country_code || ''))) out.push({ lvl: 'err', rule: 'ADDRESS_COUNTRY', msg: 'Land må være en ISO-kode med to bokstaver.' });
  if (blank(a.street) && blank(a.city)) out.push({ lvl: 'err', rule: 'ADDRESS_EMPTY', msg: 'Oppgi minst gate eller poststed.' });
  dates(a, out, 'ADDRESS_DATES');
  if (a.is_standard && (a.status || 'ACTIVE') === 'ACTIVE' && others.some(o => o.id !== a.id && o.is_standard && o.status === 'ACTIVE' && overlaps(o, a)))
    out.push({ lvl: 'err', rule: 'STANDARD_OVERLAP', msg: 'En annen standardadresse er gyldig i samme periode. Avslutt den først, eller sett en senere fra-dato.' });
  return out;
}

export function checkRole(r: any): Finding[] {
  const out: Finding[] = [];
  if (!ROLES[r.role_code]) out.push({ lvl: 'err', rule: 'ROLE_CODE', msg: 'Ukjent rollekode.' });
  dates(r, out, 'ROLE_DATES');
  return out;
}

export function checkContact(c: any): Finding[] {
  const out: Finding[] = [];
  if (!CONTACT_TYPES[c.contact_type]) out.push({ lvl: 'err', rule: 'CONTACT_TYPE', msg: 'Ukjent kontakttype.' });
  if (blank(c.contact_name) && blank(c.email) && blank(c.telephone)) out.push({ lvl: 'err', rule: 'CONTACT_EMPTY', msg: 'Oppgi navn, e-post eller telefon.' });
  if (!blank(c.email) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(c.email))) out.push({ lvl: 'err', rule: 'CONTACT_EMAIL', msg: 'E-postadressen er ikke gyldig.' });
  if (c.clearance_mail && blank(c.email)) out.push({ lvl: 'err', rule: 'CONTACT_MAIL_NO_EMAIL', msg: 'Kontakten må ha e-post for å få fortollingen tilsendt.' });
  return out;
}

export function checkFullmakt(f: any): Finding[] {
  const out: Finding[] = [];
  if (!f.representative_id) out.push({ lvl: 'err', rule: 'FULLMAKT_REP', msg: 'Velg representant.' });
  if (f.representative_id && f.representative_id === f.partner_id) out.push({ lvl: 'err', rule: 'FULLMAKT_SELF', msg: 'En partner kan ikke gi fullmakt til seg selv.' });
  if (!f.valid_from) out.push({ lvl: 'err', rule: 'FULLMAKT_FROM', msg: 'Gyldig fra er påkrevd.' });
  dates(f, out, 'FULLMAKT_DATES');
  if (!['DIRECT', 'INDIRECT'].includes(f.representation)) out.push({ lvl: 'err', rule: 'FULLMAKT_TYPE', msg: 'Representasjon må være direkte eller indirekte.' });
  return out;
}

export function checkCredit(c: any): Finding[] {
  const out: Finding[] = [];
  if (!/^\d{4,}$/.test(String(c.account || '').trim())) out.push({ lvl: 'err', rule: 'CREDIT_ACCOUNT', msg: 'Kontonummeret for tollkreditt/dagsoppgjør består av minst 4 siffer.' });
  if (!['TOLLKREDITT', 'DAGSOPPGJOR'].includes(c.payment_type)) out.push({ lvl: 'err', rule: 'CREDIT_TYPE', msg: 'Velg tollkreditt eller dagsoppgjør.' });
  return out;
}

export function checkRelationship(r: any): Finding[] {
  const out: Finding[] = [];
  if (!RELATIONSHIP_TYPES[r.relationship_type]) out.push({ lvl: 'err', rule: 'REL_TYPE', msg: 'Ukjent koblingstype.' });
  if (!r.target_partner_id) out.push({ lvl: 'err', rule: 'REL_TARGET', msg: 'Velg partneren det kobles til.' });
  if (r.target_partner_id && r.target_partner_id === r.source_partner_id) out.push({ lvl: 'err', rule: 'REL_SELF', msg: 'En partner kan ikke kobles til seg selv.' });
  dates(r, out, 'REL_DATES');
  return out;
}
