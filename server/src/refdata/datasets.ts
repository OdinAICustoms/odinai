import type pg from 'pg';
import { bulkInsert } from './bulk.js';
import type { Fetchers } from './fetch.js';
import { dateOrNull, decimal, displayCode, normCode, padCode, pick, recordsAt, upperCode, validateMapping } from './parse.js';
import { flatten, levelOf } from './tariffstruct.js';

export interface LoadResult { rowsSeen: number; rowsWritten: number; url: string }
export interface Dataset {
  id: string;
  label: string;                         // Norwegian; the screen translates
  source: string;                        // shown on the status page
  /** Rows currently held, for the shrink guard and the status page. */
  count: (c: pg.PoolClient | pg.Pool) => Promise<number>;
  /** Fetch, check the mapping, and replace the table(s) inside the open transaction. */
  load: (f: Fetchers, c: pg.PoolClient) => Promise<LoadResult>;
}

const n = async (c: pg.PoolClient | pg.Pool, sql: string, p: unknown[] = []) => Number((await c.query(sql, p)).rows[0].n);
const today = () => new Date().toISOString().slice(0, 10);

/* ------------------------------ tariff ------------------------------ */
// Two datasets joined: varenummer = the declarable codes, units and validity (no text);
// tolltariffstruktur = the hierarchy and the wording. The wording is a classification aid only and
// must never be copied into box 31 (Tolletaten's rule).
const tariff: Dataset = {
  id: 'tolltariff', label: 'Tolltariff (varenumre og tekster)', source: 'data.toll.no: varenummer + tolltariffstruktur',
  count: c => n(c, "SELECT COUNT(*) n FROM tariff WHERE level = 'Code'"),
  async load(f, c) {
    const struct = await f.ckanDataset('tolltariffstruktur');
    const nodes = flatten((struct.data as any)?.avsnitt ?? []);
    if (!nodes.length) throw new Error('Tolltariffstrukturen var tom.');
    const byCode = new Map<string, (typeof nodes)[number]>();
    for (const node of nodes) {
      if (!node.digits) continue;
      const key = node.digits.length >= 8 ? padCode(node.digits) : node.digits;
      const prior = byCode.get(key);
      if (!prior || node.digits.length > prior.digits.length) byCode.set(key, node);
    }
    const codes = await f.ckanDataset('varenummer');
    const { rows } = recordsAt(codes.data, '$.varenummer');
    validateMapping(rows, { code: ['id'], unit: ['enhet'], from: ['fomdato'] }, ['code']);
    await c.query('DELETE FROM tariff');
    const out: unknown[][] = [];
    const seen = new Set<string>();
    for (const r of rows) {
      const code = padCode(pick(r, ['id']));
      if (!code || code.length !== 8 || seen.has(code)) continue;
      seen.add(code);
      const node = byCode.get(code);
      out.push([code, displayCode(code), 'Code', node?.text ?? null, node?.pathText ?? null, node?.hs ?? null, node?.blv ?? null,
        pick(r, ['enhet']) ?? null, pick(r, ['enhetBeskrivelse']) ?? null, node?.section ?? null, code.slice(0, 2), code.slice(0, 6),
        dateOrNull(r.fomdato), dateOrNull(r.tomdato)]);
    }
    // Upper levels, so a code can be shown with its chapter and heading.
    for (const node of nodes) {
      const d = node.digits;
      if (!d || d.length >= 8 || ![2, 4, 6].includes(d.length) || seen.has(d)) continue;
      seen.add(d);
      out.push([d, displayCode(d), levelOf(node.type, d), node.text, node.pathText, node.hs, null, null, null, node.section,
        d.slice(0, 2), d.length > 2 ? d.slice(0, d.length - 2) : null, null, null]);
    }
    await bulkInsert(c, 'tariff', ['code', 'display', 'level', 'text', 'path_text', 'hs_code', 'blv', 'supp_unit', 'supp_text',
      'section', 'chapter', 'parent', 'valid_from', 'valid_to'], out);
    return { rowsSeen: rows.length, rowsWritten: out.length, url: codes.url };
  }
};

/* ------------------------------ rates ------------------------------ */
/** satsEnhet K / L / S = per kg / litre / piece (specific); P = per cent. */
export function rateUnit(code: unknown, text: unknown): 'PERCENT' | 'SPECIFIC' {
  const c = upperCode(code), t = String(text ?? '').toLowerCase();
  if (c === 'P' || /prosent|%/.test(t)) return 'PERCENT';
  if (['K', 'L', 'S'].includes(c) || /per |kr\//.test(t)) return 'SPECIFIC';
  return t ? 'SPECIFIC' : 'PERCENT';
}
const rates = (id: string, dataset: string, duty: 'TL1' | 'RT100', label: string): Dataset => ({
  id, label, source: `data.toll.no: ${dataset}`,
  count: c => n(c, 'SELECT COUNT(*) n FROM tariff_rate WHERE duty_code = $1', [duty]),
  async load(f, c) {
    const { data, url } = await f.ckanDataset(dataset);
    const { rows } = recordsAt(data, '$.varer');
    validateMapping(rows, { code: ['id'], agreements: ['avtalesatser'] }, ['code', 'agreements']);
    await c.query('DELETE FROM tariff_rate WHERE duty_code = $1', [duty]);
    const out: unknown[][] = [];
    const key = new Set<string>();
    for (const r of rows) {
      const code = padCode(r.id);
      if (!code || !Array.isArray(r.avtalesatser)) continue;
      for (const a of r.avtalesatser) {
        const group = upperCode(a.landgruppe);          // exact: TAL and TALL are different groups
        if (!group) continue;
        for (const s of Array.isArray(a.sats) ? a.sats : a.sats ? [a.sats] : []) {
          const from = dateOrNull(s.fomdato) ?? '1900-01-01';
          const k = `${code}|${group}|${from}`;
          if (key.has(k)) continue;
          key.add(k);
          out.push([code, group, duty, decimal(s.satsVerdi), rateUnit(s.satsEnhet, s.satsEnhetBeskrivelse), s.satsEnhet ?? null,
            s.satsEnhetBeskrivelse ?? null, from, dateOrNull(s.tomdato)]);
        }
      }
    }
    await bulkInsert(c, 'tariff_rate', ['code', 'landgruppe', 'duty_code', 'rate_value', 'rate_unit', 'unit_code', 'unit_text', 'valid_from', 'valid_to'], out);
    return { rowsSeen: rows.length, rowsWritten: out.length, url };
  }
});

/* ------------------------------ country groups ------------------------------ */
const groups: Dataset = {
  id: 'landgrupper', label: 'Landgrupper og land', source: 'data.toll.no: landgruppe + medlemsland',
  count: c => n(c, 'SELECT COUNT(*) n FROM landgruppe_country'),
  async load(f, c) {
    const g = await f.ckanDataset('landgruppe');
    const gr = recordsAt(g.data, '$.landgrupper').rows;
    validateMapping(gr, { code: ['landgruppekode'], name: ['landgruppenavn'] }, ['code']);
    const m = await f.ckanDataset('medlemsland');
    const mr = recordsAt(m.data, '$.medlemsland').rows;
    validateMapping(mr, { country: ['landkode'], name: ['landnavn'], groups: ['landgrupper'] }, ['country', 'groups']);
    await c.query('DELETE FROM landgruppe_country; DELETE FROM landgruppe; DELETE FROM country;');
    const gOut = new Map<string, unknown[]>();
    for (const r of gr) {
      const code = upperCode(r.landgruppekode);
      if (code) gOut.set(code, [code, r.landgruppenavn ?? null, r.preferansekode ?? null, dateOrNull(r.fomdato), dateOrNull(r.tomdato)]);
    }
    const cOut = new Map<string, unknown[]>(), mOut = new Map<string, unknown[]>();
    for (const r of mr) {
      const country = upperCode(r.landkode);
      if (!/^[A-Z0-9]{2}$/.test(country)) continue;
      cOut.set(country, [country, String(r.landnavn ?? country).trim()]);
      for (const x of Array.isArray(r.landgrupper) ? r.landgrupper : []) {
        const code = upperCode(x.landgruppekode);
        if (!code) continue;
        const from = dateOrNull(x.fomdato) ?? '1900-01-01';
        mOut.set(`${code}|${country}|${from}`, [code, country, from, dateOrNull(x.tomdato)]);
      }
    }
    await bulkInsert(c, 'landgruppe', ['code', 'name', 'preference_code', 'valid_from', 'valid_to'], [...gOut.values()]);
    await bulkInsert(c, 'country', ['code', 'name'], [...cOut.values()]);
    await bulkInsert(c, 'landgruppe_country', ['landgruppe', 'country_code', 'valid_from', 'valid_to'], [...mOut.values()]);
    return { rowsSeen: gr.length + mr.length, rowsWritten: mOut.size, url: m.url };
  }
};

/* ------------------------------ restrictions ------------------------------ */
/** The box 44 document a restriction implies — only when its text says so; the broker decides the rest. */
export function documentFor(type: unknown, groupText: unknown): string | null {
  const g = String(groupText ?? '').toLowerCase();
  if (/ched/.test(g)) return 'CHED';
  if (upperCode(type) === 'CITES' || /cites/.test(g)) return 'C400';
  return null;
}
const authorityOf = (t: unknown) =>
  String(t ?? '').match(/(Mattilsynet|Landbruksdirektoratet|Milj\S*direktoratet|Legemiddelverket|Politiet|Fiskeridirektoratet|Direktoratet for strålevern)/i)?.[1] ?? null;
const restrictions: Dataset = {
  id: 'restriksjoner', label: 'Innførselsrestriksjoner', source: 'data.toll.no: innfoerselsrestriksjon',
  count: c => n(c, 'SELECT COUNT(*) n FROM restriction'),
  async load(f, c) {
    const { data, url } = await f.ckanDataset('innfoerselsrestriksjon');
    const { rows } = recordsAt(data, '$.varer');
    validateMapping(rows, { code: ['id'], restrictions: ['restriksjoner'] }, ['code', 'restrictions']);
    await c.query('DELETE FROM restriction');
    const out: unknown[][] = [];
    for (const r of rows) {
      const code = padCode(r.id);
      if (!code || !Array.isArray(r.restriksjoner)) continue;
      for (const x of r.restriksjoner) {
        const gt = x.restriksjonsgruppebeskrivelse ?? null;
        out.push([code, x.landgruppe ?? null, x.landgruppebeskrivelse ?? null, x.gjelder ?? null, x.restriksjontype ?? null,
          x.restriksjontypebeskrivelse ?? null, x.restriksjonsgruppe != null && x.restriksjonsgruppe !== '' ? Number(x.restriksjonsgruppe) : null, gt,
          documentFor(x.restriksjontype, gt), authorityOf(gt), dateOrNull(x.fomdato), dateOrNull(x.tomdato)]);
      }
    }
    await bulkInsert(c, 'restriction', ['code', 'landgruppe', 'landgruppe_text', 'applies_to', 'restriction_code', 'restriction_text',
      'restriction_group', 'restriction_group_text', 'document_code', 'authority', 'valid_from', 'valid_to'], out);
    return { rowsSeen: rows.length, rowsWritten: out.length, url };
  }
};

/* ------------------------------ TVINN error codes ------------------------------ */
// Which box to send the user to; the dataset gives the meaning, not the box (hand-maintained, from ODIN LINK).
const ERROR_BOX: Record<string, string> = {
  '9017': 'f54', '9018': 'f54', '9110': 'f48', '9111': 'f48', '9066': 'fReason', '9070': 'fParentRef', '9082': 'fParentRef',
  '9279': 'fParentRef', '9301': 'fCat', '9302': 'fItems', '9303': 'fItems', '9304': 'fItems', '9305': 'fItems', '9306': 'fItems',
  '9307': 'fItems', '9308': 'fItems', '9309': 'fItems', '9311': 'fItems', '9312': 'fItems', '9313': 'f44', '9314': 'f47', '9315': 'f47'
};
const errors: Dataset = {
  id: 'feilmeldinger', label: 'TVINN-feilmeldinger', source: 'data.toll.no: feilmelding',
  count: c => n(c, 'SELECT COUNT(*) n FROM tvinn_error_code'),
  async load(f, c) {
    const { data, url } = await f.ckanDataset('feilmelding');
    const { rows } = recordsAt(data, '$.feilmelding');
    validateMapping(rows, { number: ['meldingNummer'], text: ['meldingTekst'] }, ['number', 'text']);
    await c.query('DELETE FROM tvinn_error_code');
    const out = new Map<string, unknown[]>();
    for (const r of rows) {
      const num = String(r.meldingNummer ?? '').trim(), text = String(r.meldingTekst ?? '').trim();
      if (num && text) out.set(num, [num, text, ERROR_BOX[num] ?? null]);
    }
    await bulkInsert(c, 'tvinn_error_code', ['number', 'text', 'box'], [...out.values()]);
    return { rowsSeen: rows.length, rowsWritten: out.size, url };
  }
};

/* ------------------------------ exchange rates ------------------------------ */
// Tolletaten's customs rates (the ones TVINN uses), current and future periods together.
// omregningsenhet: JPY quoted "7,231" per 100 means 1 JPY = 0.07231 NOK.
const fx: Dataset = {
  id: 'valutakurser', label: 'Valutakurser (tollkurs)', source: 'data.toll.no: valutakurs',
  count: c => n(c, 'SELECT COUNT(*) n FROM fx_rate WHERE valid_to IS NULL OR valid_to >= $1', [today()]),
  async load(f, c) {
    const { data, url } = await f.ckanDataset('valutakurs');
    const { rows } = recordsAt(data, '$.omregningskurser');
    validateMapping(rows, { currency: ['valutakode'], rate: ['valutakurs'], from: ['fomdato'] }, ['currency', 'rate', 'from']);
    const cur = new Map<string, unknown[]>(), out = new Map<string, unknown[]>();
    for (const r of rows) {
      const code = upperCode(r.valutakode);
      const quoted = decimal(r.valutakurs), from = dateOrNull(r.fomdato);
      if (!/^[A-Z]{3}$/.test(code) || !quoted || !from) continue;
      const per = Number(r.omregningsenhet) || 1;
      if (r.valutabeskrivelse) cur.set(code, [code, String(r.valutabeskrivelse).trim()]);
      out.set(`${code}|${from}`, [code, from, dateOrNull(r.tomdato), quoted, quoted, per]);
    }
    // Keep history: only the published periods are replaced, earlier periods stay for older declarations.
    for (const v of out.values()) await c.query('DELETE FROM fx_rate WHERE currency = $1 AND valid_from = $2', [v[0], v[1]]);
    await bulkInsert(c, 'fx_rate', ['currency', 'valid_from', 'valid_to', 'rate', 'quoted', 'per_unit'], [...out.values()]);
    // Divide in exact decimal arithmetic (in JavaScript 6.031 / 100 is 0.060309999999999996).
    await c.query('UPDATE fx_rate SET rate = trim_scale(quoted / per_unit) WHERE per_unit <> 1 AND rate = quoted');
    for (const v of cur.values()) await c.query('INSERT INTO currency (code, name) VALUES ($1, $2) ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name', v);
    return { rowsSeen: rows.length, rowsWritten: out.size, url };
  }
};

/* ------------------------------ postal codes ------------------------------ */
// Posten's register: tab-separated, no header, Windows-1252: postnr, poststed, kommunenr, kommunenavn, kategori.
const POSTNUMMER_URL = process.env.POSTNUMMER_URL || 'https://www.bring.no/postnummerregister-ansi.txt';
const postal: Dataset = {
  id: 'postnummer', label: 'Postnumre (Posten)', source: 'bring.no: postnummerregister',
  count: c => n(c, 'SELECT COUNT(*) n FROM postnummer'),
  async load(f, c) {
    const { text, url } = await f.textFile(POSTNUMMER_URL, 'windows-1252');
    const lines = text.split(/\r\n|\r|\n/).filter(l => l.trim());
    const out = new Map<string, unknown[]>();
    for (const l of lines) {
      const [nr, sted, knr, knavn, kat] = l.split('\t').map(s => (s ?? '').trim());
      if (!/^\d{4}$/.test(nr) || !sted) continue;
      out.set(`${nr}|${sted.toUpperCase()}`, [nr, sted.toUpperCase(), knr || null, knavn || null, kat || null]);
    }
    if (out.size < 1000) throw new Error(`Bare ${out.size} postnumre lest — kontroller kildeformatet (tabulatorseparert, firesifret postnummer først).`);
    await c.query('DELETE FROM postnummer');
    await bulkInsert(c, 'postnummer', ['postnr', 'poststed', 'kommunenr', 'kommunenavn', 'kategori'], [...out.values()]);
    return { rowsSeen: lines.length, rowsWritten: out.size, url };
  }
};

/* ------------------------------ declaration code lists (phase 2a) ------------------------------ */
const trimmed = (v: unknown) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim());
/**
 * A simple code list: one array of records, replaced as a whole. `empty` lists (quotas, code validity)
 * may legitimately be published with no rows; the others must have at least one.
 */
const codeList = (o: { id: string; label: string; dataset: string; path: string; table: string; columns: string[];
  mapping: Record<string, string[]>; required: string[]; empty?: boolean; keyless?: boolean; row: (r: any) => unknown[] | null }): Dataset => ({
  id: o.id, label: o.label, source: `data.toll.no: ${o.dataset}`,
  count: c => n(c, `SELECT COUNT(*) n FROM ${o.table}`),
  async load(f, c) {
    const { data, url } = await f.ckanDataset(o.dataset);
    const { rows } = recordsAt(data, o.path);
    if (rows.length || !o.empty) validateMapping(rows, o.mapping, o.required);
    await c.query(`DELETE FROM ${o.table}`);
    const out = new Map<string, unknown[]>();
    // The first column is the table's key (last record wins), except where the table has its own id.
    for (const r of rows) { const v = o.row(r); if (v) out.set(o.keyless ? String(out.size) : String(v[0]), v); }
    await bulkInsert(c, o.table, o.columns, [...out.values()]);
    return { rowsSeen: rows.length, rowsWritten: out.size, url };
  }
});

const offices = codeList({
  id: 'tollsteder', label: 'Ekspedisjonsenheter (rubrikk A)', dataset: 'ekspedisjonsenhet', path: '$.ekspedisjonsenheter', table: 'ref_office',
  columns: ['code', 'name', 'area', 'direction', 'valid_from', 'valid_to'],
  mapping: { code: ['ekspedisjonsenhetskode'], name: ['ekspedisjonsenhetnavn'] }, required: ['code', 'name'],
  row: r => { const code = String(r.ekspedisjonsenhetskode ?? '').replace(/\D/g, ''); return code.length === 6
    ? [code, String(r.ekspedisjonsenhetnavn ?? '').trim(), trimmed(r.fagomraade), trimmed(r.retning), dateOrNull(r.fomdato), dateOrNull(r.tomdato)] : null; }
});
const procedures = codeList({
  id: 'prosedyrer', label: 'Prosedyrekoder (rubrikk 37)', dataset: 'prosedyrekode', path: '$.prosedyre', table: 'ref_procedure',
  columns: ['code', 'text', 'valid_from', 'valid_to'],
  mapping: { code: ['prosedyrekode'], text: ['prosedyrekodebeskrivelse'] }, required: ['code'],
  row: r => { const code = String(r.prosedyrekode ?? '').trim(); return /^\d{4}$/.test(code) ? [code, trimmed(r.prosedyrekodebeskrivelse), dateOrNull(r.fomdato), dateOrNull(r.tomdato)] : null; }
});
const importRefs = codeList({
  id: 'referansekoder', label: 'Referansekoder ved innførsel (rubrikk 44)', dataset: 'innfoerselsreferanse', path: '$.referanser', table: 'ref_import_ref',
  columns: ['code', 'text', 'valid_from', 'valid_to'],
  mapping: { code: ['kode'], text: ['beskrivelse'] }, required: ['code'],
  row: r => { const code = upperCode(r.kode); return code ? [code, trimmed(r.beskrivelse), dateOrNull(r.fomdato), dateOrNull(r.tomdato)] : null; }
});
const quotas = codeList({
  id: 'tollkvoter', label: 'Tollkvoter (rubrikk 39)', dataset: 'tollkvote', path: '$.tollkvoter', table: 'ref_quota', empty: true,
  columns: ['doc', 'landgruppe', 'max_qty', 'used_qty', 'unit', 'unit_text', 'codes', 'valid_from', 'valid_to'],
  mapping: { doc: ['dokumentnummer'], codes: ['varenumre'] }, required: ['doc'],
  row: r => { const doc = trimmed(r.dokumentnummer); return doc ? [doc, trimmed(r.landgruppekode), decimal(r.maksMengde), decimal(r.avskrevetMengde), trimmed(r.mengdeenhet),
    trimmed(r.mengdeenhetBeskrivelse), (Array.isArray(r.varenumre) ? r.varenumre : []).map(padCode).filter((x: string) => x.length === 8), dateOrNull(r.fomdato), dateOrNull(r.tomdato)] : null; }
});
const codeValidity = codeList({
  id: 'datogyldighet', label: 'Datogyldighet på varenummer', dataset: 'datogyldighetforvare', path: '$.vare', table: 'ref_code_validity', empty: true, keyless: true,
  columns: ['code', 'valid_from', 'valid_to'],
  mapping: { code: ['id', 'varenummer'] }, required: ['code'],
  row: r => { const code = padCode(pick(r, ['id', 'varenummer'])); return code.length === 8 ? [code, dateOrNull(r.fomdato), dateOrNull(r.tomdato)] : null; }
});

export const DATASETS: Dataset[] = [
  tariff,
  rates('tollsatser', 'tollavgiftssats', 'TL1', 'Tollsatser (TL1)'),
  rates('rt100-satser', 'raavaretollavgiftssats', 'RT100', 'Råvaretollavgift (RT100)'),
  groups, restrictions, errors, fx, postal,
  offices, procedures, importRefs, quotas, codeValidity
];
export const datasetById = (id: string) => DATASETS.find(d => d.id === id);
export { normCode };
