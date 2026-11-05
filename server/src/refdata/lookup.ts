import { one, query } from '../db.js';
import { normCode, displayCode } from './parse.js';

/**
 * Reading the reference data. Every date-dependent answer takes the declaration date, because
 * rates, group membership and restrictions all change over time.
 */
const day = (d?: string) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : new Date().toISOString().slice(0, 10));
const inForce = `valid_from <= $2::date AND (valid_to IS NULL OR valid_to >= $2::date)`;

/** Search by code (any form: "2103 90", "21.03.9099") or by words in the tariff text. */
export async function searchTariff(q: string, limit = 25) {
  const s = String(q || '').trim();
  if (!s) return [];
  const digits = normCode(s);
  if (digits && digits.length >= 2 && /^[\d\s.\-]+$/.test(s))
    return query(`SELECT code, display, level, text, path_text, supp_unit FROM tariff WHERE code LIKE $1 ORDER BY length(code), code LIMIT $2`, [digits + '%', limit]);
  return query(`SELECT code, display, level, text, path_text, supp_unit FROM tariff
      WHERE level = 'Code' AND to_tsvector('norwegian', coalesce(path_text, text, '')) @@ plainto_tsquery('norwegian', $1)
      ORDER BY code LIMIT $2`, [s, limit]);
}

/** One code with its ancestors, rates by country group, and restrictions, on the given date. */
export async function tariffCode(code: string, date?: string) {
  const c = normCode(code).padStart(8, '0');
  const d = day(date);
  const t = await one('SELECT * FROM tariff WHERE code = $1', [c]);
  if (!t) return null;
  const ancestors = await query('SELECT code, display, level, text FROM tariff WHERE code = ANY($1) ORDER BY length(code)', [[c.slice(0, 2), c.slice(0, 4), c.slice(0, 6)]]);
  const rates = await query(`SELECT r.landgruppe, g.name landgruppe_name, r.duty_code, r.rate_value, r.rate_unit, r.unit_text, r.valid_from, r.valid_to
      FROM tariff_rate r LEFT JOIN landgruppe g ON g.code = r.landgruppe
      WHERE r.code = $1 AND r.valid_from <= $2::date AND (r.valid_to IS NULL OR r.valid_to >= $2::date)
      ORDER BY r.duty_code, r.landgruppe`, [c, d]);
  const restrictions = await query(`SELECT * FROM restriction WHERE code = $1 AND (valid_from IS NULL OR valid_from <= $2::date) AND (valid_to IS NULL OR valid_to >= $2::date)
      ORDER BY restriction_group, restriction_code`, [c, d]);
  return { ...t, ancestors, rates, restrictions, date: d, rtRequired: rates.some(r => r.duty_code === 'RT100') };
}

/** The country groups a country belongs to on the date (exact codes; TAL is not TALL). */
export async function groupsOf(country: string, date?: string) {
  return (await query(`SELECT landgruppe FROM landgruppe_country WHERE country_code = $1 AND ${inForce} ORDER BY landgruppe`,
    [String(country || '').toUpperCase(), day(date)])).map(r => r.landgruppe as string);
}

/** NOK per one unit of the currency on the date, from Tolletaten's customs rates. */
export async function fxRate(currency: string, date?: string) {
  const cur = String(currency || '').toUpperCase();
  if (cur === 'NOK') return { currency: 'NOK', rate: '1', validFrom: null, validTo: null };
  const r = await one(`SELECT currency, rate, quoted, per_unit, valid_from, valid_to FROM fx_rate WHERE currency = $1 AND ${inForce}
      ORDER BY valid_from DESC LIMIT 1`, [cur, day(date)]);
  return r ? { currency: r.currency, rate: r.rate, quoted: r.quoted, perUnit: r.per_unit, validFrom: r.valid_from, validTo: r.valid_to } : null;
}

export const countries = () => query('SELECT code, name FROM country ORDER BY name');
export const currencies = () => query('SELECT code, name FROM currency ORDER BY code');
export const errorText = (number: string) => one('SELECT * FROM tvinn_error_code WHERE number = $1', [String(number)]);

export async function postalSearch(q: string, limit = 20) {
  const s = String(q || '').trim();
  if (!s) return [];
  return /^\d+$/.test(s)
    ? query('SELECT * FROM postnummer WHERE postnr LIKE $1 ORDER BY postnr, poststed LIMIT $2', [s + '%', limit])
    : query('SELECT * FROM postnummer WHERE poststed LIKE $1 ORDER BY poststed, postnr LIMIT $2', [s.toUpperCase() + '%', limit]);
}

/* ---------------- declaration code lists ---------------- */
const openOn = `(valid_from IS NULL OR valid_from <= $1::date) AND (valid_to IS NULL OR valid_to >= $1::date)`;

/** Customs offices in force on the date; `direction` IMPORT leaves out the export-only ones. */
export const offices = (direction?: 'IMPORT' | 'EXPORT', date?: string) =>
  query(`SELECT code, name, area, direction FROM ref_office WHERE ${openOn}
      ${direction === 'IMPORT' ? "AND coalesce(direction, '') <> 'Utførsel'" : direction === 'EXPORT' ? "AND coalesce(direction, '') <> 'Innførsel'" : ''}
      ORDER BY code`, [day(date)]);
export const office = (code: string) => one('SELECT * FROM ref_office WHERE code = $1', [String(code ?? '').replace(/\D/g, '').slice(0, 6)]);
export const procedures = (date?: string) => query(`SELECT code, text FROM ref_procedure WHERE ${openOn} ORDER BY code`, [day(date)]);
export const procedure = (code: string) => one('SELECT * FROM ref_procedure WHERE code = $1', [String(code ?? '').trim()]);
export const importRefs = (date?: string) => query(`SELECT code, text FROM ref_import_ref WHERE ${openOn} ORDER BY code`, [day(date)]);
export const quota = (doc: string) => one('SELECT * FROM ref_quota WHERE doc = $1', [String(doc ?? '').trim()]);
export const codeValidity = (code: string) => query('SELECT valid_from, valid_to FROM ref_code_validity WHERE code = $1', [normCode(code).padStart(8, '0')]);
/** Is a reference list loaded at all? Rules that need it stay quiet until it is. */
export const loaded = async (table: 'ref_office' | 'ref_procedure' | 'ref_quota' | 'tariff') =>
  (await one<{ n: number }>(`SELECT COUNT(*) n FROM ${table}`))!.n > 0;

export { displayCode };
