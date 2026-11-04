/**
 * Value parsing for Tolletaten's open data. Each rule here was learned from the live payloads
 * (ODIN LINK, September 2026) and has a test in test/refdata.test.ts.
 */

/** Digits only, at most 8: "2103 90 99", "21.03.9099" and "21039099" become one key. */
export function normCode(v: unknown): string {
  const d = String(v ?? '').replace(/\D/g, '');
  return d.length > 8 ? d.slice(0, 8) : d;
}

/** Declarable codes are published zero-padded to 8 ("00000011"); shorter keys are hierarchy levels. */
export function padCode(v: unknown): string {
  const d = normCode(v);
  return d && d.length < 8 ? d.padStart(8, '0') : d;
}

/** "21039099" -> "2103 90 99", "210390" -> "2103 90". */
export function displayCode(v: unknown): string {
  const d = normCode(v);
  if (d.length === 8) return `${d.slice(0, 4)} ${d.slice(4, 6)} ${d.slice(6)}`;
  if (d.length === 6) return `${d.slice(0, 4)} ${d.slice(4)}`;
  return d;
}

/**
 * Number from a Norwegian-formatted string, kept as an exact decimal string for numeric columns.
 * "24,67" -> "24.67", "1 234,50" -> "1234.50", "" -> null (absent is not zero).
 */
export function decimal(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : null;
  const s = String(v).replace(/[\s ]/g, '').replace(',', '.');
  return /^-?\d+(\.\d+)?$/.test(s) ? s : null;
}

/** ISO date or null. Tolletaten publish an open-ended validity as "", which must become null. */
export function dateOrNull(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  const m = String(v).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/** Group and country codes: trimmed, upper case, compared by exact equality only (TAL is not TALL). */
export const upperCode = (v: unknown) => String(v ?? '').trim().toUpperCase();

/** First present, non-empty value among candidate field names. */
export function pick(rec: Record<string, unknown> | null | undefined, names: string[]): any {
  if (!rec) return undefined;
  for (const n of names) {
    const v = rec[n];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

/**
 * Check that a field mapping finds the required fields in real records before anything is written.
 * A loader that silently wrote nulls would leave the tables looking full and the calculation wrong.
 */
export function validateMapping(rows: unknown[], mapping: Record<string, string[]>, required: string[]) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('Fant ingen poster i svaret fra kilden.');
  const sample = rows.slice(0, 25) as Record<string, unknown>[];
  const resolved: Record<string, string> = {}, missing: string[] = [];
  for (const [logical, names] of Object.entries(mapping)) {
    const hit = names.find(n => sample.some(r => r && r[n] !== undefined && r[n] !== null && r[n] !== ''));
    if (hit) resolved[logical] = hit;
    else if (required.includes(logical)) missing.push(logical);
  }
  if (missing.length) {
    const present = [...new Set(sample.flatMap(r => Object.keys(r || {})))].sort();
    throw new Error(`Feltkoblingen feilet: fant ikke ${missing.map(m => `${m} (${mapping[m].join(' | ')})`).join(', ')}. Felter i kilden: ${present.join(', ')}`);
  }
  return resolved;
}

/** The record array at a path like "$.varer", or the first array of objects in the payload. */
export function recordsAt(data: unknown, path?: string): { rows: any[]; path: string } {
  if (path) {
    const v = path.split('.').reduce<any>((o, k) => (k === '$' ? o : o?.[k]), data);
    if (Array.isArray(v)) return { rows: v, path };
  }
  const find = (v: unknown, p: string): { rows: any[]; path: string } | null => {
    if (Array.isArray(v) && v.length && typeof v[0] === 'object') return { rows: v, path: p };
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { const hit = find(x, `${p}.${k}`); if (hit) return hit; }
    return null;
  };
  const hit = find(data, '$');
  if (!hit) throw new Error('Fant ingen liste med poster i svaret fra kilden.');
  return hit;
}
