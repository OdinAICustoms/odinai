import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, type Me } from '../../api';
import { T, fmtDateTime } from '../../i18n';
import { Findings, PartnerPicker, ProductPicker, useCountries } from '../../components/Form';
import { DocList, Upload } from '../../components/Docs';
import { fmtCode } from '../products/ProductList';
import { dPill, fmtAmount } from './DeclarationList';

type Issue = { lvl: 'err' | 'warn' | 'info'; box: string; rule: string; msg: string; item?: number; field?: string };
type Meta = Record<string, any>;
let metaCache: Meta | null = null;
const lists: Record<string, any[]> = {};
function useList(path: string) {
  const [v, setV] = useState<any[]>(lists[path] ?? []);
  useEffect(() => { if (!lists[path]) api(path).then(r => { lists[path] = r; setV(r); }).catch(() => {}); }, [path]);
  return v;
}

const HEADER_KEYS = ['client_id', 'exporter_id', 'importer_id', 'declarant_id', 'own_ref', 'decl_type', 'office', 'decl_date', 'place', 'dispatch_country',
  'transport_id', 'transport_nat', 'container', 'container_nos', 'transport_mode', 'incoterms', 'incoterms_place', 'invoice_total', 'currency',
  'transaction_type', 'goods_location', 'prev_doc', 'warehouse_id', 'reexport_deadline', 'payment_method', 'payment_account', 'docs', 'notes', 'value_details'];
const ITEM_KEYS = ['product_id', 'description', 'packages', 'package_kind', 'marks', 'code', 'origin', 'preference', 'procedure', 'nat_procedure', 'quota',
  'gross_kg', 'net_kg', 'supp_qty', 'price', 'valuation_method', 'freight', 'add_amount', 'ded_amount', 'docs', 'article_no', 'gtin', 'levies'];
const LISTS = new Set(['docs', 'value_details', 'levies']);
const differs = (a: unknown, b: unknown) => JSON.stringify(a ?? '') !== JSON.stringify(b ?? '');
const NUMERIC = new Set(['invoice_total', 'packages', 'gross_kg', 'net_kg', 'supp_qty', 'price', 'freight', 'add_amount', 'ded_amount']);
/** Numbers from the server arrive as "1250.50"; show them as the user types them back ("1250,50" is accepted too). */
const show = (k: string, v: any) => (NUMERIC.has(k) && v !== '' && v != null ? String(Number(v)) : v);

export function DeclarationEditor({ me }: { me: Me }) {
  const { id } = useParams();
  const nav = useNavigate();
  const [d, setD] = useState<any>(null);
  const [meta, setMeta] = useState<Meta | null>(metaCache);
  const [v, setV] = useState<Record<string, any>>({});
  const [err, setErr] = useState(''), [ok, setOk] = useState('');
  const [item, setItem] = useState<string | 'new' | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const can = !!d && d.editable && me.perms.includes('declaration.edit');

  const take = (r: any) => { setD(r); setV(Object.fromEntries(HEADER_KEYS.map(k => [k, show(k, r[k] ?? (LISTS.has(k) ? [] : k === 'container' ? false : ''))]))); };
  const load = () => api(`/declarations/${id}`).then(take).catch(e => setErr(e.message));
  useEffect(() => { setD(null); setItem(null); load(); if (!metaCache) api('/declarations/meta').then(m => { metaCache = m; setMeta(m); }); }, [id]);

  const dirty = useMemo(() => (d ? HEADER_KEYS.filter(k => differs(show(k, d[k] ?? (LISTS.has(k) ? [] : k === 'container' ? false : '')), v[k])) : []), [d, v]);
  const act = async (fn: () => Promise<any>, msg = '') => {
    setErr(''); setOk('');
    try { const r = await fn(); if (r?.id) take(r); else await load(); if (msg) setOk(msg); return r; } catch (x) { setErr((x as Error).message); if ((x as any).code === 'VERSION') await load(); return null; }
  };
  const save = () => act(() => api(`/declarations/${id}`, { method: 'PUT', body: { version: d.version, ...Object.fromEntries(dirty.map(k => [k, v[k] === '' ? null : v[k]])) } }), T('Lagret.'));

  // Clicking a finding: open the goods item, or scroll to the box.
  useEffect(() => {
    if (!focus) return;
    const el = document.getElementById(focus);
    if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); (el as HTMLElement).focus?.(); }
    setFocus(null);
  }, [focus, item]);
  const goto = (i: Issue) => {
    if (i.item) { const it = d.items.find((x: any) => x.line_no === i.item); if (it) { setItem(it.id); setFocus(i.field ? `it-${i.field}` : 'item-form'); } }
    else setFocus(i.field ? `f-${i.field}` : i.box === '44' ? 'sec-docs' : i.box === '32' ? 'sec-items' : null);
  };

  if (err && !d) return <div className="err">{T(err)}</div>;
  if (!d || !meta) return <p className="muted">{T('Laster …')}</p>;
  const issuesFor = (field: string) => (d.issues as Issue[]).filter(i => !i.item && i.field === field);
  const hp = { v, set: (k: string, x: any) => setV(s => ({ ...s, [k]: x })), all: (d.issues as Issue[]).filter(i => !i.item), disabled: !can };
  const opt = (o: Record<string, string>, withCode = true) => Object.fromEntries(Object.entries(o).map(([k, l]) => [k, withCode ? `${k} – ${T(l)}` : T(l)]));

  return (
    <section>
      <div className="cardhead">
        <div><div className="muted">{T('Innførselsdeklarasjon')} · {T('opprettet')} {fmtDateTime(d.created_at)}{d.created_by_name ? ` · ${d.created_by_name}` : ''}</div>
          <h2 className="mono">{d.decl_no}</h2></div>
        <div className="pills">{dPill(d.status)}<span className="chip mono" title={T('Rubrikk 1')}>{d.box1 ?? '—'} {d.decl_type}</span>
          {d.created_from !== 'MANUAL' && <span className="pill info">{T('Fra')} {d.created_from}</span>}</div>
        <span className="spacer" />
        {me.perms.includes('declaration.edit') && <button className="btn grey" type="button" onClick={async () => { const r = await act(() => api(`/declarations/${id}/copy`, { body: {} })); if (r?.id) nav(`/declarations/${r.id}`); }}>{T('Kopier')}</button>}
        <button className="btn grey" type="button" onClick={() => nav('/declarations')}>← {T('Deklarasjoner')}</button>
      </div>
      {d.status === 'CANCELLED' && <div className="warnmsg">{T('Kansellert')}: {d.cancel_reason}</div>}
      {!d.editable && d.status !== 'CANCELLED' && <div className="warnmsg">{T('Deklarasjonen er sendt til godkjenning eller videre og kan ikke endres.')}</div>}

      <div className="declgrid">
        <div>
          {can && dirty.length > 0 && <div className="savebar"><span>{T('Ulagrede endringer')}: {dirty.length}</span><span className="spacer" />
            <button className="btn" type="button" onClick={save}>{T('Lagre')}</button><button className="btn grey" type="button" onClick={() => take(d)}>{T('Angre')}</button></div>}
          <Findings error={err} />{ok && !dirty.length && <div className="okmsg">{ok}</div>}

          <Section title="Parter">
            <PartyField k="exporter_id" box="2" label="Avsender / eksportør" d={d} v={v} setV={setV} can={can} issues={issuesFor('exporter_id')} name={d.parties.exporter} />
            <PartyField k="importer_id" box="8" label="Mottaker / importør" d={d} v={v} setV={setV} can={can} issues={issuesFor('importer_id')} name={d.parties.importer} />
            <PartyField k="declarant_id" box="14" label="Deklarant / representant" d={d} v={v} setV={setV} can={can} issues={issuesFor('declarant_id')} name={d.parties.declarant} />
            <PartyField k="client_id" box="" label="Klient (faktureres)" d={d} v={v} setV={setV} can={can} issues={[]} name={d.parties.client} />
          </Section>

          <Section title="Deklarasjon">
            <Field {...hp} k="decl_type" box="1" label="Deklarasjonstype" t="select" opts={opt(meta.declTypes)} req />
            <OfficeField v={v} setV={setV} can={can} issues={issuesFor('office')} />
            <Field {...hp} k="decl_date" box="54" label="Deklarasjonsdato" t="date" req />
            <Field {...hp} k="place" box="54a" label="Sted" req />
            <Field {...hp} k="own_ref" box="7" label="Egen referanse" />
            {v.decl_type === '5' && <Field {...hp} k="reexport_deadline" box="B" label="Gjenutførselsfrist" t="date" req />}
            {v.decl_type === '7' && <Field {...hp} k="warehouse_id" box="49" label="Lageridentifikasjon" req />}
          </Section>

          <Section title="Transport">
            <Field {...hp} k="dispatch_country" box="15" label="Avsenderland" t="country" req />
            <Field {...hp} k="transport_mode" box="25" label="Transportmåte ved grensen" t="select" opts={opt(meta.transportModes)} req />
            <Field {...hp} k="transport_id" box="18" label="Transportmidlets identitet" req />
            <Field {...hp} k="transport_nat" box="21" label="Transportmidlets nasjonalitet" t="country" />
            <Field {...hp} k="container" box="19" label="Container" t="check" />
            {v.container && <Field {...hp} k="container_nos" box="19" label="Containernummer" req />}
            <Field {...hp} k="goods_location" box="30" label="Varens lagringssted" req />
            <Field {...hp} k="prev_doc" box="40" label="Tidligere dokument" />
          </Section>

          <Section title="Verdi og betaling">
            <Field {...hp} k="incoterms" box="20" label="Leveringsvilkår" t="select" opts={Object.fromEntries(meta.incoterms.map((x: string) => [x, x]))} req />
            <Field {...hp} k="incoterms_place" box="20a" label="Leveringssted" req />
            <Field {...hp} k="invoice_total" box="22" label="Fakturert totalbeløp" t="number" req />
            <CurrencyField v={v} setV={setV} can={can} issues={issuesFor('currency')} />
            <Field {...hp} k="transaction_type" box="24" label="Transaksjonstype" t="select" opts={opt(meta.transactionTypes)} />
            <PaymentField id={id!} v={v} setV={setV} can={can} issues={[...issuesFor('payment_method'), ...issuesFor('payment_account')]} meta={meta} />
            <div className={`fwide ${cls(issuesFor('value_details'))}`}>
              <label><span className="boxno">12</span>{T('Verdiopplysninger: frakt, forsikring, rabatt')}</label>
              <Box12 rows={v.value_details ?? []} meta={meta} can={can} currency={v.currency} onChange={rows => setV(s => ({ ...s, value_details: rows }))} />
              <p className="hint">{T('Fordeles på alle vareposter i hele kroner (frakt etter bruttovekt, ellers etter verdi). Når rubrikk 12 er fylt ut, brukes ikke tillegg og fradrag ført på vareposten.')}</p>
              <Marks issues={issuesFor('value_details')} />
            </div>
          </Section>

          <div className="panelbox" id="sec-docs" tabIndex={-1}>
            <h3><span className="boxno">44</span> {T('Dokumenter for hele sendingen')}</h3>
            <DocRows rows={v.docs} codes={meta.declDocCodes} dateKey="date" can={can} onChange={docs => setV(s => ({ ...s, docs }))} idPrefix="f-docs" />
            <p className="hint">{T('Faktura (N380), pakkliste (N271) og fraktbrev (N730). Varenummerspesifikke koder (VT, SER, USK …) føres på vareposten.')}</p>
            <h3 style={{ marginTop: 14 }}>{T('Filer')}</h3>
            {me.perms.includes('declaration.edit') && d.status !== 'CANCELLED' && <div className="row" style={{ marginTop: 0 }}>
              <Upload label="+ Faktura" docCode="N380" path={`/declarations/${id}/documents`} onDone={load} />
              <Upload label="+ Pakkliste" docCode="N271" path={`/declarations/${id}/documents`} onDone={load} />
              <Upload label="+ Annet" path={`/declarations/${id}/documents`} onDone={load} /></div>}
            <DocList docs={d.documents} can={can} onChange={load} />
            {!d.documents.length && <p className="muted">{T('Ingen filer lastet opp.')}</p>}
          </div>

          <Items d={d} meta={meta} can={can} sel={item} setSel={setItem} act={act} />

          <Section title="Merknader">
            <Field {...hp} k="notes" box="" label="Interne merknader (sendes ikke til Tolletaten)" t="textarea" wide />
          </Section>

          {can && <div className="panelbox"><h3>{T('Kanseller deklarasjonen')}</h3><Cancel onCancel={reason => act(() => api(`/declarations/${id}/cancel`, { body: { reason, version: d.version } }), T('Kansellert.'))} /></div>}
        </div>

        <aside className="checkpanel">
          <div className="panelbox">
            <h3>{T('Kontroll')}</h3>
            {d.check.ok ? <div className="okmsg">{T('Ingen feil.')} {d.check.warnings ? `${d.check.warnings} ${T('varsler å se på.')}` : ''}</div>
              : <div className="err" style={{ marginTop: 0 }}>{d.check.errors} {T('feil må rettes før innsending.')}</div>}
            {dirty.length > 0 && <p className="hint">{T('Kontrollen gjelder det som er lagret.')}</p>}
            <ul className="issues">{(d.issues as Issue[]).map((i, n) => <li key={n} className={i.lvl}>
              <button type="button" className="linkbtn" onClick={() => goto(i)}><span className="boxno">{i.box}</span>{T(i.msg)}</button></li>)}</ul>
          </div>
          <div className="panelbox">
            <h3>{T('Sammendrag')}</h3>
            <dl className="kv small">
              <dt>{T('Vareposter')}</dt><dd>{d.items.length}</dd>
              <dt>{T('Kolli')}</dt><dd>{d.items.reduce((a: number, x: any) => a + (Number(x.packages) || 0), 0)}</dd>
              <dt>{T('Bruttovekt')}</dt><dd>{fmtAmount(d.items.reduce((a: number, x: any) => a + (Number(x.gross_kg) || 0), 0), 3)} kg</dd>
              <dt>{T('Nettovekt')}</dt><dd>{fmtAmount(d.items.reduce((a: number, x: any) => a + (Number(x.net_kg) || 0), 0), 3)} kg</dd>
              <dt>{T('Sum varepris')}</dt><dd>{fmtAmount(d.items.reduce((a: number, x: any) => a + (Number(x.price) || 0), 0))} {d.currency ?? ''}</dd>
              <dt>{T('Sist endret')}</dt><dd>{fmtDateTime(d.updated_at)}{d.updated_by_name ? ` · ${d.updated_by_name}` : ''}</dd>
            </dl>
          </div>
          <CalcPanel c={d.calc} />
        </aside>
      </div>
    </section>
  );
}

const kr = (v: unknown) => `${fmtAmount(v, 0)} kr`;

/** Box 47 for the whole declaration: what is charged, in whole kroner per goods item as TVINN does. */
function CalcPanel({ c }: { c: any }) {
  if (!c) return null;
  const row = (label: string, v: number, show = true) => (show ? <><dt>{T(label)}</dt><dd className="num">{kr(v)}</dd></> : null);
  return (
    <div className="panelbox calcpanel">
      <h3><span className="boxno">47</span> {T('Beregning')}</h3>
      {c.fx == null ? <div className="warnmsg">{T('Ingen tollkurs for valutaen på deklarasjonsdatoen — verdien kan ikke regnes om til kroner.')}</div>
        : c.currency && c.currency !== 'NOK' && <p className="hint" style={{ marginTop: 0 }}>{T('Tollkurs')} {c.currency} {String(c.fx).replace('.', ',')} ({c.date})</p>}
      {c.suspended && <div className="warnmsg">{T('Midlertidig innførsel / tollager: beløpene beregnes, men belastes ikke.')}</div>}
      <dl className="kv small">
        {row('Statistisk verdi (46)', c.statValue)}
        {row('Toll (A00)', c.duty)}
        {row('Råvaretollavgift (RT100)', c.rt, c.rt > 0 || c.lines.some((l: any) => l.rtRequired))}
        {row('Forskningsavgift (FA)', c.fa)}
        {row('Særavgifter', c.saer, c.saer > 0)}
        {row('Tilleggstollavgift', c.tillegg, c.tillegg > 0)}
        <dt><b>{T('Toll og avgifter')}</b></dt><dd className="num"><b>{kr(c.payable)}</b></dd>
        {row('MVA-grunnlag', c.vatBase)}
        {row('Merverdiavgift', c.vat)}
        <dt><b>{T('Totalt')}</b></dt><dd className="num"><b>{kr(c.total)}</b></dd>
      </dl>
      {c.box12?.active && <p className="hint">{T('Rubrikk 12 fordelt')}: +{kr(c.box12.addTotal)}{c.box12.dedTotal ? ` / −${kr(c.box12.dedTotal)}` : ''}</p>}
      {c.incomplete && <p className="hint">{T('Beregningen er ufullstendig for minst én varepost (mangler varenummer, kurs eller sats). Se kontrollen.')}</p>}
    </div>
  );
}

/** Box 12: shipment-level additions and deductions, spread over the goods items. */
function Box12({ rows, meta, can, currency, onChange }: { rows: any[]; meta: Meta; can: boolean; currency: string; onChange: (r: any[]) => void }) {
  const set = (i: number, k: string, x: any) => onChange(rows.map((r, n) => (n === i ? { ...r, [k]: x, ...(k === 'kind' ? { type: Object.keys(meta.box12Types[x])[0] } : {}) } : r)));
  return (
    <div className="docrows" id="f-value_details" tabIndex={-1}>
      {rows.map((r, i) => <div key={i} className="b12row">
        <select aria-label={T('Tillegg eller fradrag')} value={r.kind} disabled={!can} onChange={e => set(i, 'kind', e.target.value)}>
          <option value="ADD">{T('Tillegg')}</option><option value="DED">{T('Fradrag')}</option></select>
        <select aria-label={T('Type')} value={r.type} disabled={!can} onChange={e => set(i, 'type', e.target.value)}>
          {Object.entries(meta.box12Types[r.kind] ?? {}).map(([k, l]) => <option key={k} value={k}>{T(l as string)}</option>)}</select>
        <input aria-label={T('Beløp')} inputMode="decimal" value={r.amount ?? ''} disabled={!can} onChange={e => set(i, 'amount', e.target.value)} />
        <select aria-label={T('Valuta')} value={r.currency ?? 'INV'} disabled={!can} onChange={e => set(i, 'currency', e.target.value)}>
          <option value="INV">{currency || T('Fakturavaluta')}</option><option value="NOK">NOK</option></select>
        <select aria-label={T('Fordeles etter')} value={r.basis ?? ''} disabled={!can} onChange={e => set(i, 'basis', e.target.value)}>
          {Object.entries(meta.box12Bases).map(([k, l]) => <option key={k} value={k}>{T('etter')} {T(l as string).toLowerCase()}</option>)}</select>
        <input aria-label={T('Beskrivelse')} placeholder={T('Beskrivelse')} value={r.text ?? ''} disabled={!can} onChange={e => set(i, 'text', e.target.value)} />
        {can && <button type="button" className="linkbtn" onClick={() => onChange(rows.filter((_, n) => n !== i))}>{T('Fjern')}</button>}
      </div>)}
      {can && <button type="button" className="btn ghost small" onClick={() => onChange([...rows, { kind: 'ADD', type: 'FRAKT', amount: '', currency: 'NOK', basis: 'GROSS' }])}>{T('+ Legg til tillegg eller fradrag')}</button>}
      {!rows.length && !can && <p className="muted">{T('Ingen.')}</p>}
    </div>
  );
}

/** Box 47 for one goods item, and the excise choices for the levy types on its code. */
function ItemCalc({ l, v, setV, can }: { l: any; v: any; setV: (f: (s: any) => any) => void; can: boolean }) {
  if (!l) return null;
  const choice = (type: string) => (v.levies ?? []).find((x: any) => x.type === type) ?? {};
  const setChoice = (type: string, patch: any) => setV(s => {
    const list = (s.levies ?? []).filter((x: any) => x.type !== type);
    return { ...s, levies: [...list, { ...choice(type), type, ...patch }] };
  });
  const rate = (n: number | null | undefined, unit?: string | null) => (n == null ? '—' : `${String(n).replace('.', ',')}${unit === 'PERCENT' || unit === 'P' ? ' %' : ' kr/kg'}`);
  return (
    <div className="itemcalc">
      <h3><span className="boxno">47</span> {T('Beregning for vareposten')}{l.suspended ? ` · ${T('belastes ikke')}` : ''}</h3>
      <table className="t small"><tbody>
        <tr><td>{T('Statistisk verdi (46)')}</td><td className="muted">{l.add45 || l.ded45 ? `${T('justering')} ${l.add45 - l.ded45 >= 0 ? '+' : ''}${fmtAmount(l.add45 - l.ded45, 0)}${l.fromBox12 ? ` (${T('rubrikk 12')})` : ''}` : ''}</td><td className="num">{kr(l.customsValue)}</td></tr>
        <tr><td>{T('Toll (A00)')}</td><td className="muted">{l.tl1.landgruppe ?? '—'} · {rate(l.tl1.rate, l.tl1.unit)}{l.tl1.source === 'PREFERENCE' ? ` · ${T('preferanse')}` : ''}</td><td className="num">{l.tl1.amount == null ? '—' : kr(l.tl1.amount)}</td></tr>
        {l.rt && <tr><td>RT100</td><td className="muted">{l.rt.status === 'PUBLISHED_RATE' ? T('publisert sats') : l.rt.permit ? `${l.rt.permit.permit_no} ${l.rt.variant ?? ''}` : T('mangler')} · {rate(l.rt.rate)}</td><td className="num">{kr(l.rt.amount)}</td></tr>}
        <tr><td>{T('Forskningsavgift (FA)')}</td><td className="muted">{l.fa ? rate(l.fa.rate, l.fa.unit) : T('ikke på varenummeret')}</td><td className="num">{kr(l.fa?.amount ?? 0)}</td></tr>
        {l.saer.map((s: any) => <tr key={s.type}><td>{s.type}</td><td className="muted">{s.groupText ?? s.group}{s.qty != null ? ` · ${fmtAmount(s.qty, 3)} × ${String(s.rate).replace('.', ',')}` : ''}</td><td className="num">{kr(s.amount)}</td></tr>)}
        {l.tillegg && <tr><td>{T('Tilleggstollavgift')}</td><td className="muted">{l.tillegg.landgruppe} · {rate(l.tillegg.rate, l.tillegg.unit)}</td><td className="num">{kr(l.tillegg.amount)}</td></tr>}
        <tr><td>{T('Merverdiavgift')}</td><td className="muted">{l.vat.rate == null ? '—' : `${l.vat.rate} % ${T('av')} ${fmtAmount(l.vat.base, 0)}`}{l.vat.source === 'DEFAULT' ? ` · ${T('standardsats, avgiftsdata mangler')}` : ''}</td><td className="num">{l.vat.amount == null ? '—' : kr(l.vat.amount)}</td></tr>
      </tbody></table>
      {l.levyTypes.length > 0 && <div id="it-levies" tabIndex={-1}>
        <h3 style={{ marginTop: 10 }}>{T('Særavgifter på varenummeret')}</h3>
        {l.levyTypes.map((t: any) => { const c = choice(t.type), g = t.groups.find((x: any) => x.group === String(c.group)); return <div key={t.type} className="levyrow">
          <span><b>{t.type}</b> {t.text}</span>
          <select aria-label={`${t.type} ${T('avgiftsgruppe')}`} value={c.group ?? ''} disabled={!can} onChange={e => setChoice(t.type, { group: e.target.value })}>
            <option value="">{T('Velg …')}</option><option value="NA">{T('Gjelder ikke')}</option>
            {t.groups.map((x: any) => <option key={x.group} value={x.group}>{x.group} – {x.text ?? ''} ({String(x.rate).replace('.', ',')} {x.unit === 'P' ? '%' : `kr/${(x.unitText ?? x.unit ?? '').toLowerCase()}`})</option>)}</select>
          {g && g.unit !== 'P' && <input aria-label={`${t.type} ${T('mengde')}`} inputMode="decimal" placeholder={`${T('Mengde')} (${(g.unitText ?? g.unit ?? '').toLowerCase()})`} value={c.qty ?? ''} disabled={!can} onChange={e => setChoice(t.type, { qty: e.target.value })} />}
        </div>; })}
      </div>}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <div className="panelbox"><h3>{T(title)}</h3><div className="formgrid">{children}</div></div>;
}

const Marks = ({ issues }: { issues: Issue[] }) => <>{issues.map((i, n) => <p key={n} className={`fmsg ${i.lvl}`}>{T(i.msg)}</p>)}</>;
const cls = (issues: Issue[]) => (issues.some(i => i.lvl === 'err') ? 'haserr' : issues.some(i => i.lvl === 'warn') ? 'haswarn' : '');
const Label = ({ id, box, label, req }: { id: string; box: string; label: string; req?: boolean }) =>
  <label htmlFor={id}>{box && <span className="boxno">{box}</span>}{T(label)}{req ? ' *' : ''}</label>;

interface FieldProps { k: string; box: string; label: string; t?: 'text' | 'select' | 'date' | 'country' | 'number' | 'check' | 'textarea'; opts?: Record<string, string>;
  req?: boolean; wide?: boolean; v: Record<string, any>; set: (k: string, v: any) => void; all: Issue[]; disabled: boolean; idPrefix?: string }
function Field({ k, box, label, t = 'text', opts, req, wide, v, set, all, disabled, idPrefix = 'f' }: FieldProps) {
  const issues = all.filter(i => i.field === k);
  const countries = useCountries();
  const id = `${idPrefix}-${k}`, val = v[k] ?? '';
  if (t === 'check') return <label className="chk fcheck"><input id={id} type="checkbox" checked={!!v[k]} disabled={disabled} onChange={e => set(k, e.target.checked)} /> <span className="boxno">{box}</span>{T(label)}</label>;
  return (
    <div className={`${wide ? 'fwide' : ''} ${cls(issues)}`}>
      <Label id={id} box={box} label={label} req={req} />
      {t === 'select' ? <select id={id} value={val} disabled={disabled} onChange={e => set(k, e.target.value)}><option value="">—</option>
          {Object.entries(opts ?? {}).map(([o, l]) => <option key={o} value={o}>{l}</option>)}</select>
        : t === 'country' ? <select id={id} value={val} disabled={disabled} onChange={e => set(k, e.target.value)}><option value="">—</option>
          {countries.map(c => <option key={c.code} value={c.code}>{c.code} – {c.name}</option>)}</select>
        : t === 'textarea' ? <textarea id={id} value={val} disabled={disabled} rows={3} onChange={e => set(k, e.target.value)} />
        : <input id={id} type={t === 'date' ? 'date' : 'text'} inputMode={t === 'number' ? 'decimal' : undefined} value={val} disabled={disabled} onChange={e => set(k, e.target.value)} />}
      <Marks issues={issues} />
    </div>
  );
}

function PartyField({ k, box, label, d, v, setV, can, issues, name }: { k: string; box: string; label: string; d: any; v: any; setV: (f: (s: any) => any) => void; can: boolean; issues: Issue[]; name: any }) {
  const nav = useNavigate();
  const [edit, setEdit] = useState(false);
  const changed = v[k] !== (d[k] ?? '');
  useEffect(() => setEdit(false), [d]);
  return (
    <div className={cls(issues)}>
      <Label id={`f-${k}`} box={box} label={label} req={!!box} />
      {edit || (!v[k] && can) ? <PartnerPicker id={`f-${k}`} onPick={pid => { setV(s => ({ ...s, [k]: pid })); setEdit(false); }} />
        : <div className="partyval" id={`f-${k}`} tabIndex={-1}>
          {changed ? <i>{T('Endret — lagre for å se navnet')}</i> : name ? <><a href={`/partners/${name.id}`} onClick={e => { e.preventDefault(); nav(`/partners/${name.id}`); }}>{name.legal_name}</a>
            <span className="muted"> {name.partner_no}{name.identifier ? ` · ${name.identifier}` : ''}</span></> : <span className="muted">—</span>}
          {can && <button type="button" className="linkbtn" onClick={() => setEdit(true)}>{T('Endre')}</button>}
          {can && v[k] && k !== 'declarant_id' && <button type="button" className="linkbtn" onClick={() => setV(s => ({ ...s, [k]: '' }))}>{T('Fjern')}</button>}
        </div>}
      <Marks issues={issues} />
    </div>
  );
}

function OfficeField({ v, setV, can, issues }: { v: any; setV: (f: (s: any) => any) => void; can: boolean; issues: Issue[] }) {
  const offices = useList('/refdata/offices?direction=IMPORT');
  const known = offices.some(o => o.code === v.office);
  return (
    <div className={cls(issues)}>
      <Label id="f-office" box="A" label="Tollsted (ekspedisjonsenhet)" req />
      {offices.length ? <select id="f-office" value={v.office} disabled={!can} onChange={e => setV(s => ({ ...s, office: e.target.value }))}>
          <option value="">—</option>{!known && v.office && <option value={v.office}>{v.office}</option>}
          {offices.map(o => <option key={o.code} value={o.code}>{o.code} – {o.name}</option>)}</select>
        : <input id="f-office" value={v.office} disabled={!can} placeholder="300101" onChange={e => setV(s => ({ ...s, office: e.target.value }))} />}
      <Marks issues={issues} />
    </div>
  );
}

function CurrencyField({ v, setV, can, issues }: { v: any; setV: (f: (s: any) => any) => void; can: boolean; issues: Issue[] }) {
  const cur = useList('/refdata/currencies');
  return (
    <div className={cls(issues)}>
      <Label id="f-currency" box="22a" label="Valuta" req />
      <select id="f-currency" value={v.currency} disabled={!can} onChange={e => setV(s => ({ ...s, currency: e.target.value }))}>
        <option value="">—</option><option value="NOK">NOK – Norske kroner</option>
        {cur.filter(c => c.code !== 'NOK').map(c => <option key={c.code} value={c.code}>{c.code} – {c.name}</option>)}</select>
      <Marks issues={issues} />
    </div>
  );
}

function PaymentField({ id, v, setV, can, issues, meta }: { id: string; v: any; setV: (f: (s: any) => any) => void; can: boolean; issues: Issue[]; meta: Meta }) {
  const [opts, setOpts] = useState<{ accounts: any[]; suggested: any } | null>(null);
  useEffect(() => { api(`/declarations/${id}/payment-options`).then(setOpts).catch(() => {}); }, [id, v.importer_id, v.declarant_id]);
  const accounts = (opts?.accounts ?? []).filter(a => !v.payment_method || a.payment_type === v.payment_method);
  return (
    <div className={`fwide ${cls(issues)}`}>
      <Label id="f-payment_method" box="48" label="Betalingsmåte og konto" />
      <div className="row" style={{ marginTop: 0 }}>
        <select id="f-payment_method" value={v.payment_method} disabled={!can} onChange={e => setV(s => ({ ...s, payment_method: e.target.value, ...(e.target.value === 'KONTANT' ? { payment_account: '' } : {}) }))}>
          <option value="">—</option>{Object.entries(meta.paymentMethods).map(([k, l]) => <option key={k} value={k}>{T(l as string)}</option>)}</select>
        {v.payment_method && v.payment_method !== 'KONTANT' && <select id="f-payment_account" value={v.payment_account} disabled={!can} onChange={e => setV(s => ({ ...s, payment_account: e.target.value }))}>
          <option value="">{T('Velg konto')}</option>{!accounts.some(a => a.account === v.payment_account) && v.payment_account && <option value={v.payment_account}>{v.payment_account}</option>}
          {accounts.map(a => <option key={a.account} value={a.account}>{a.account} – {a.legal_name} ({T('rubrikk')} {a.box}{a.debtor ? `, ${T('tollskyldner')}` : `, ${T('representant')}`})</option>)}</select>}
        {can && !v.payment_method && opts?.suggested && <button type="button" className="linkbtn" onClick={() => setV(s => ({ ...s, payment_method: opts.suggested.payment_type, payment_account: opts.suggested.account }))}>
          {T('Bruk')} {opts.suggested.account} ({opts.suggested.legal_name})</button>}
      </div>
      <Marks issues={issues} />
    </div>
  );
}

/** Box 44 rows: code, reference, date (shipment documents) or valid-to (permits on an item). */
function DocRows({ rows, codes, dateKey, can, onChange, idPrefix }: { rows: any[]; codes: Record<string, string> | [string, string, string][]; dateKey: 'date' | 'valid'; can: boolean; onChange: (r: any[]) => void; idPrefix: string }) {
  const list: [string, string, string?][] = Array.isArray(codes) ? codes : Object.entries(codes);
  const set = (i: number, k: string, x: string) => onChange(rows.map((r, n) => (n === i ? { ...r, [k]: x } : r)));
  return (
    <div className="docrows" id={idPrefix} tabIndex={-1}>
      {rows.map((r, i) => <div key={i} className="docrow">
        <select aria-label={T('Kode')} value={r.code} disabled={!can} onChange={e => set(i, 'code', e.target.value)}>
          {!list.some(c => c[0] === r.code) && <option value={r.code}>{r.code}</option>}{list.map(c => <option key={c[0]} value={c[0]}>{c[0]} – {T(c[1])}</option>)}</select>
        <input aria-label={T('Referanse')} placeholder={T('Referanse')} value={r.ref ?? ''} disabled={!can} onChange={e => set(i, 'ref', e.target.value)}
          title={list.find(c => c[0] === r.code)?.[2] ? T(list.find(c => c[0] === r.code)![2]!) : undefined} />
        <input aria-label={dateKey === 'date' ? T('Dokumentdato') : T('Gyldig til')} type="date" value={r[dateKey] ?? ''} disabled={!can} onChange={e => set(i, dateKey, e.target.value)} />
        {can && <button type="button" className="linkbtn" onClick={() => onChange(rows.filter((_, n) => n !== i))}>{T('Fjern')}</button>}
      </div>)}
      {can && <button type="button" className="btn ghost small" onClick={() => onChange([...rows, { code: list[0]?.[0] ?? 'N380', ref: '' }])}>{T('+ Legg til dokument')}</button>}
      {!rows.length && !can && <p className="muted">{T('Ingen.')}</p>}
    </div>
  );
}

/* ------------------------------ goods items ------------------------------ */
function Items({ d, meta, can, sel, setSel, act }: { d: any; meta: Meta; can: boolean; sel: string | null; setSel: (s: string | null) => void; act: (fn: () => Promise<any>, msg?: string) => Promise<any> }) {
  const [bulk, setBulk] = useState({ field: 'procedure', value: '' });
  const count = (n: number) => (d.issues as Issue[]).filter(i => i.item === n);
  const calcOf = (n: number) => d.calc?.lines.find((l: any) => l.line_no === n);
  const current = sel === 'new' ? null : d.items.find((x: any) => x.id === sel);
  return (
    <div className="panelbox" id="sec-items" tabIndex={-1}>
      <div className="row" style={{ marginTop: 0, alignItems: 'center' }}><h3 style={{ margin: 0 }}>{T('Vareposter')}</h3><span className="spacer" />
        {can && <button className="btn add small" type="button" onClick={() => setSel('new')}>{T('+ Ny varepost')}</button>}</div>
      <div className="tblwrap" style={{ marginTop: 10 }}><table className="t items">
        <thead><tr><th>32</th><th>{T('Varebeskrivelse')} (31)</th><th>{T('Varenr.')} (33)</th><th>34</th><th>36</th><th>37</th><th className="num">{T('Kolli')}</th>
          <th className="num">{T('Brutto')} (35)</th><th className="num">{T('Netto')} (38)</th><th className="num">{T('Pris')} (42)</th><th className="num">{T('Stat. verdi')} (46)</th><th className="num">{T('Toll og avg.')} (47)</th><th>{T('Kontroll')}</th>{can && <th />}</tr></thead>
        <tbody>{d.items.map((it: any) => {
          const is = count(it.line_no), e = is.filter(i => i.lvl === 'err').length, w = is.filter(i => i.lvl === 'warn').length;
          return <tr key={it.id} id={`item-${it.line_no}`} className={`click ${sel === it.id ? 'sel' : ''}`} onClick={() => setSel(sel === it.id ? null : it.id)}>
            <td>{it.line_no}</td><td><b>{it.description}</b>{it.product_no && <span className="muted"> · {it.product_no}</span>}</td><td className="mono nowrap">{fmtCode(it.code)}</td>
            <td>{it.origin}</td><td>{it.preference}</td><td className="mono">{it.procedure}</td><td className="num">{it.packages}{it.package_kind ? ` ${it.package_kind}` : ''}</td>
            <td className="num">{fmtAmount(it.gross_kg, 3)}</td><td className="num">{fmtAmount(it.net_kg, 3)}</td><td className="num">{fmtAmount(it.price)}</td>
            <td className="num">{calcOf(it.line_no) ? fmtAmount(calcOf(it.line_no).customsValue, 0) : ''}</td>
            <td className="num">{calcOf(it.line_no) ? fmtAmount(calcOf(it.line_no).payable, 0) : ''}</td>
            <td className="nowrap">{e ? <span className="pill rejected">{e} {T('feil')}</span> : null}{w ? <span className="pill submitted">{w}</span> : null}{!e && !w ? <span className="pill accepted">OK</span> : null}</td>
            {can && <td className="nowrap" onClick={ev => ev.stopPropagation()}>
              <button type="button" className="linkbtn" disabled={it.line_no === 1} title={T('Flytt opp')} onClick={() => act(() => api(`/declarations/${d.id}/items/${it.id}/move`, { body: { to: it.line_no - 1, version: d.version } }))}>↑</button>
              <button type="button" className="linkbtn" disabled={it.line_no === d.items.length} title={T('Flytt ned')} onClick={() => act(() => api(`/declarations/${d.id}/items/${it.id}/move`, { body: { to: it.line_no + 1, version: d.version } }))}>↓</button></td>}
          </tr>;
        })}
        {!d.items.length && <tr><td colSpan={14} className="muted">{T('Ingen vareposter ennå.')}</td></tr>}
        {d.items.length > 0 && d.calc && <tr className="sum"><td colSpan={10}>{T('Sum')}</td><td className="num">{fmtAmount(d.calc.statValue, 0)}</td><td className="num">{fmtAmount(d.calc.payable, 0)}</td><td colSpan={can ? 2 : 1} /></tr>}</tbody>
      </table></div>
      {can && d.items.length > 1 && <div className="row bulk">
        <span className="muted">{T('Sett på alle vareposter')}:</span>
        <select aria-label={T('Felt')} value={bulk.field} onChange={e => setBulk({ field: e.target.value, value: '' })}>
          {[['procedure', 'Prosedyre (37)'], ['origin', 'Opprinnelsesland (34)'], ['preference', 'Preferanse (36)'], ['valuation_method', 'Verdimetode (43)'], ['package_kind', 'Kollislag']].map(([k, l]) =>
            <option key={k} value={k}>{T(l)}</option>)}</select>
        <input aria-label={T('Verdi')} value={bulk.value} onChange={e => setBulk({ ...bulk, value: e.target.value })} placeholder={bulk.field === 'procedure' ? '4000' : ''} style={{ width: 120 }} />
        <button type="button" className="btn ghost small" disabled={!bulk.value} onClick={() => act(() => api(`/declarations/${d.id}/items/bulk`, { body: { ...bulk, version: d.version } }), T('Endret på alle vareposter.'))}>{T('Bruk')}</button>
      </div>}
      {sel && <ItemForm key={sel} d={d} it={current} meta={meta} can={can} onClose={() => setSel(null)} act={act} issues={current ? count(current.line_no) : []} />}
    </div>
  );
}

function ItemForm({ d, it, meta, can, onClose, act, issues }: { d: any; it: any; meta: Meta; can: boolean; onClose: () => void; act: (fn: () => Promise<any>, msg?: string) => Promise<any>; issues: Issue[] }) {
  const empty = { procedure: d.items[0]?.procedure ?? '4000', origin: '', valuation_method: '1', docs: [] };
  const [v, setV] = useState<Record<string, any>>(() => Object.fromEntries(ITEM_KEYS.map(k => [k, show(k, it ? it[k] : (empty as any)[k]) ?? (LISTS.has(k) ? [] : '')])));
  const [tariff, setTariff] = useState<any>(null);
  useEffect(() => {
    const c = String(v.code ?? '').replace(/\D/g, '');
    if (c.length !== 8) { setTariff(null); return; }
    const t = setTimeout(() => api(`/refdata/tariff/${c}${d.decl_date ? `?date=${d.decl_date}` : ''}`).then(setTariff).catch(() => setTariff({ missing: true })), 250);
    return () => clearTimeout(t);
  }, [v.code]);
  const forField = (k: string) => issues.filter(i => i.field === k);
  const hp = { v, set: (k: string, x: any) => setV(s => ({ ...s, [k]: x })), all: issues, disabled: !can, idPrefix: 'it' };
  const opt = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).map(([k, l]) => [k, `${k} – ${T(l)}`]));
  const body = () => {
    const out: Record<string, any> = { version: d.version };
    for (const k of ITEM_KEYS) if (!it || differs(show(k, it[k]) ?? (LISTS.has(k) ? [] : ''), v[k])) out[k] = v[k] === '' ? null : v[k];
    return out;
  };
  const save = async () => {
    const r = await act(() => (it ? api(`/declarations/${d.id}/items/${it.id}`, { method: 'PUT', body: body() }) : api(`/declarations/${d.id}/items`, { body: body() })), T('Varepost lagret.'));
    if (r && !it) onClose();
  };
  return (
    <div className="subform itemform" id="item-form" tabIndex={-1}>
      <div className="row" style={{ marginTop: 0, alignItems: 'center' }}><h3 style={{ margin: 0 }}>{it ? `${T('Varepost')} ${it.line_no}` : T('Ny varepost')}</h3><span className="spacer" />
        <button type="button" className="linkbtn" onClick={onClose}>{T('Lukk')}</button></div>
      {issues.length > 0 && <ul className="issues inline">{issues.filter(i => !i.field || !ITEM_KEYS.includes(i.field)).map((i, n) => <li key={n} className={i.lvl}>{T(i.msg)}</li>)}</ul>}
      <div className="formgrid">
        <div className="fwide"><label htmlFor="it-product_id"><span className="boxno">P</span>{T('Produkt i registeret')}</label>
          {it?.product_no && <div className="partyval">{it.product_no} <span className="muted">{it.product_status}</span></div>}
          {can && <ProductPicker id="it-product_id" ownerId={d.importer_id ?? d.client_id} placeholder={it?.product_no ? T('Bytt produkt') : T('Søk produkt (tomme felt fylles fra produktet)')}
            onPick={(pid, p) => setV(s => ({ ...s, product_id: pid, description: s.description || p.name, code: s.code || p.code || '', origin: s.origin || p.origin || '' }))} />}
        </div>
        <Field {...hp} k="description" box="31" label="Varebeskrivelse" req wide />
        <Field {...hp} k="packages" box="31" label="Antall kolli" t="number" />
        <Field {...hp} k="package_kind" box="31" label="Kollislag" />
        <Field {...hp} k="marks" box="31" label="Merker og nummer" />
        <Field {...hp} k="code" box="33" label="Varenummer" req />
        <Field {...hp} k="origin" box="34" label="Opprinnelsesland" t="country" req />
        <Field {...hp} k="preference" box="36" label="Preferanse" t="select" opts={opt(meta.preferences)} />
        <Field {...hp} k="procedure" box="37" label="Prosedyre" req />
        <Field {...hp} k="nat_procedure" box="37" label="Nasjonal tilleggskode" />
        <Field {...hp} k="quota" box="39" label="Tollkvote" />
        <Field {...hp} k="gross_kg" box="35" label="Bruttovekt (kg)" t="number" />
        <Field {...hp} k="net_kg" box="38" label="Nettovekt (kg)" t="number" req />
        <Field {...hp} k="supp_qty" box="41" label={tariff?.supp_text ? `${T('Mengde')} (${tariff.supp_text})` : 'Mengde i annen enhet'} t="number" />
        <Field {...hp} k="price" box="42" label={`${T('Varens pris')} (${d.currency || T('valuta')})`} t="number" req />
        <Field {...hp} k="valuation_method" box="43" label="Verdimetode" t="select" opts={opt(meta.valuationMethods)} />
        <Field {...hp} k="freight" box="45" label="Frakt til grensen (NOK)" t="number" />
        <Field {...hp} k="add_amount" box="45" label="Andre tillegg (NOK)" t="number" />
        <Field {...hp} k="ded_amount" box="45" label="Fradrag (NOK)" t="number" />
        <Field {...hp} k="article_no" box="" label="Artikkelnr. på fakturaen" />
        <Field {...hp} k="gtin" box="" label="GTIN / EAN" />
      </div>
      {tariff && (tariff.missing ? <p className="fmsg err">{T('Varenummeret finnes ikke i tolltariffen.')}</p>
        : <p className="hint">{tariff.display}: {tariff.path_text ?? tariff.text}{tariff.rtRequired ? ' · RT100' : ''}{tariff.restrictions?.length ? ` · ${T('Restriksjoner')}: ${[...new Set(tariff.restrictions.map((r: any) => r.restriction_code))].join(', ')}` : ''}</p>)}
      {it && <ItemCalc l={d.calc?.lines.find((x: any) => x.line_no === it.line_no)} v={v} setV={setV} can={can} />}
      <Marks issues={forField('levies')} />
      <h3 style={{ marginTop: 12 }}><span className="boxno">44</span> {T('Dokumenter på vareposten')}</h3>
      <DocRows rows={v.docs} codes={meta.itemDocCodes} dateKey="valid" can={can} onChange={docs => setV(s => ({ ...s, docs }))} idPrefix="it-docs" />
      <Marks issues={forField('docs')} />
      {can && <div className="row">
        <button className="btn" type="button" onClick={save}>{it ? T('Lagre varepost') : T('Legg til varepost')}</button>
        <button className="btn grey" type="button" onClick={onClose}>{T('Avbryt')}</button>
        {it && <><span className="spacer" /><button className="btn danger" type="button" onClick={async () => { if (await act(() => api(`/declarations/${d.id}/items/${it.id}/remove`, { body: { version: d.version } }), T('Varepost fjernet.'))) onClose(); }}>{T('Fjern varepost')}</button></>}
      </div>}
    </div>
  );
}

function Cancel({ onCancel }: { onCancel: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  return <div className="row" style={{ marginTop: 0 }}>
    <input aria-label={T('Årsak')} placeholder={T('Årsak (påkrevd)')} value={reason} onChange={e => setReason(e.target.value)} style={{ flex: 1, minWidth: 220 }} />
    <button className="btn danger" type="button" disabled={!reason.trim()} onClick={() => onCancel(reason.trim())}>{T('Kanseller')}</button>
    <p className="hint" style={{ flexBasis: '100%' }}>{T('En deklarasjon slettes aldri. Den kansellerte deklarasjonen blir liggende med årsaken.')}</p>
  </div>;
}
