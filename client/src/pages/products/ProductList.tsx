import { Fragment, useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type Me } from '../../api';
import { T, locale } from '../../i18n';
import { Fields, Findings, PartnerPicker } from '../../components/Form';
import { RtPermitView, rtPill } from '../../components/Rt';

export const PSTATUS: Record<string, [string, string]> = {
  DRAFT: ['Utkast', 'cancelled'], REVIEW: ['Under kontroll', 'submitted'], CHECKED: ['Kontrollert', 'accepted'], EXPIRED: ['Utløpt', 'rejected'], BLOCKED: ['Blokkert', 'rejected']
};
export const pPill = (s: string) => <span className={`pill ${PSTATUS[s]?.[1] ?? ''}`}>{T(PSTATUS[s]?.[0] ?? s)}</span>;
export const fmtCode = (c: string | null) => (c && c.length === 8 ? `${c.slice(0, 4)} ${c.slice(4, 6)} ${c.slice(6)}` : c ?? '');
const d = (v: string | null) => (v ? new Date(v + 'T00:00:00').toLocaleDateString(locale()) : '');

const WORK: [string, string][] = [['needsChecking', 'Trenger kontroll'], ['rtMissing', 'RT uten gyldig tillatelse'], ['expiringSoon', 'Utløper innen 90 dager'],
  ['conflicts', 'Avvikende varenummer på faktura'], ['tariffChange', 'Berørt av tariffendring'], ['newFromImports', 'Nye fra import / AI']];

/** Product register: work lists, filters, list, and new products. */
export function ProductList({ me }: { me: Me }) {
  const nav = useNavigate();
  const [work, setWork] = useState<Record<string, any[]>>({});
  const [rows, setRows] = useState<any[]>([]);
  const [wl, setWl] = useState('');
  const [f, setF] = useState<Record<string, string>>({ q: '', status: '', owner: '', rt: '' });
  const [ownerName, setOwnerName] = useState('');
  const [adding, setAdding] = useState(false);
  useEffect(() => { api('/products/worklists').then(setWork); }, []);
  useEffect(() => {
    if (wl) return;
    const t = setTimeout(() => api('/products?' + new URLSearchParams(Object.entries(f).filter(([, v]) => v))).then(setRows), 200);
    return () => clearTimeout(t);
  }, [f, wl]);
  const shown = wl ? work[wl] ?? [] : rows;
  return (
    <section>
      <div className="pagehead"><h2>{T('Produktregister')}</h2><span className="spacer" />
        {me.perms.includes('product.edit') && <button className="btn add" type="button" onClick={() => setAdding(true)}>{T('+ Nytt produkt')}</button>}</div>
      <div className="cards">{WORK.map(([k, l]) => <button key={k} type="button" className={`card ${(work[k]?.length ?? 0) > 0 ? 'warn' : ''} ${wl === k ? 'on' : ''}`}
        onClick={() => setWl(wl === k ? '' : k)}><div className="l">{T(l)}</div><div className="n">{work[k]?.length ?? '–'}</div></button>)}</div>
      {adding && <NewProduct onDone={id => nav(`/products/${id}`)} onCancel={() => setAdding(false)} />}
      {!wl ? <div className="filters">
        <input value={f.q} onChange={e => setF({ ...f, q: e.target.value })} placeholder={T('Søk navn, produktnr., varenummer, GTIN, artikkelnr.')} aria-label={T('Søk')} style={{ flex: 1, minWidth: 240 }} />
        <span style={{ minWidth: 220 }}><PartnerPicker id="pf-owner" placeholder={T('Klient')} value={ownerName} onPick={(id, n) => { setOwnerName(n); setF({ ...f, owner: id }); }} /></span>
        {f.owner && <button className="linkbtn" type="button" onClick={() => { setOwnerName(''); setF({ ...f, owner: '' }); }}>{T('Alle klienter')}</button>}
        <select value={f.status} onChange={e => setF({ ...f, status: e.target.value })} aria-label={T('Status')}><option value="">{T('Alle statuser')}</option>
          {Object.entries(PSTATUS).map(([k, [l]]) => <option key={k} value={k}>{T(l)}</option>)}</select>
        <select value={f.rt} onChange={e => setF({ ...f, rt: e.target.value })} aria-label="RT"><option value="">RT100</option>
          <option value="yes">{T('Med RT-tillatelse')}</option><option value="missing">{T('RT uten gyldig tillatelse')}</option><option value="no">{T('Uten RT-tillatelse')}</option></select>
      </div> : <p className="muted">{T(WORK.find(w => w[0] === wl)![1])} · <button className="linkbtn" type="button" onClick={() => setWl('')}>{T('Vis alle produkter')}</button></p>}
      <div className="tblwrap"><table className="t">
        <thead><tr><th>{T('Produktnr.')}</th><th>{T('Navn')}</th><th>{T('Klient')}</th><th>{T('Varenummer')}</th><th>{T('Opprinnelse')}</th><th>{T('Artikkelnr. / GTIN')}</th><th>{T('Status')}</th><th>RT100</th></tr></thead>
        <tbody>{shown.map(p => <tr key={p.id} className="click" onClick={() => nav(`/products/${p.id}`)}>
          <td className="mono">{p.product_no}</td><td><b>{p.name}</b></td><td>{p.owner_name ?? <span className="bad">{T('Ingen klient')}</span>}</td>
          <td className="mono nowrap">{fmtCode(p.code)}</td><td>{p.origin}</td><td className="muted">{p.ids}</td><td>{pPill(p.status)}</td>
          <td>{p.rt_valid_to && p.rt_valid_to >= new Date().toISOString().slice(0, 10) ? <span className="pill accepted">{T('til')} {d(p.rt_valid_to)}</span>
            : p.rt_required ? <span className="pill rejected">{T('Mangler')}</span> : <span className="muted">—</span>}</td>
        </tr>)}
        {!shown.length && <tr><td colSpan={8} className="muted">{T('Ingen produkter.')}</td></tr>}</tbody>
      </table></div>
    </section>
  );
}

function NewProduct({ onDone, onCancel }: { onDone: (id: string) => void; onCancel: () => void }) {
  const [v, setV] = useState<Record<string, any>>({});
  const [ids, setIds] = useState({ client: '', supplier: '', gtin: '' });
  const [err, setErr] = useState('');
  const save = async (e: FormEvent) => {
    e.preventDefault(); setErr('');
    const identifiers = [ids.client && { type: 'CLIENT_ART', value: ids.client }, ids.supplier && { type: 'SUPPLIER_ART', value: ids.supplier }, ids.gtin && { type: 'GTIN', value: ids.gtin }].filter(Boolean);
    try { const r = await api('/products', { body: { ...v, identifiers } }); onDone(r.product.id); } catch (x) { setErr((x as Error).message); }
  };
  return (
    <form className="panelbox" onSubmit={save}>
      <h3>{T('Nytt produkt')}</h3>
      <Fields idPrefix="np" value={v} onChange={setV} spec={[
        { k: 'name', label: 'Produktnavn', req: true, wide: true }, { k: 'descr', label: 'Varebeskrivelse (rubrikk 31)', wide: true, hint: 'Tomt = produktnavnet.' },
        { k: 'owner_id', label: 'Klient', t: 'partner', req: true }, { k: 'supplier_id', label: 'Leverandør', t: 'partner' },
        { k: 'code', label: 'Varenummer (8 siffer)' }, { k: 'origin', label: 'Opprinnelsesland', t: 'country' }]} />
      <div className="formgrid">
        <div><label htmlFor="np-ca">{T('Klientens artikkelnr.')}</label><input id="np-ca" value={ids.client} onChange={e => setIds({ ...ids, client: e.target.value })} /></div>
        <div><label htmlFor="np-sa">{T('Leverandørens artikkelnr.')}</label><input id="np-sa" value={ids.supplier} onChange={e => setIds({ ...ids, supplier: e.target.value })} /></div>
        <div><label htmlFor="np-gt">GTIN / EAN</label><input id="np-gt" value={ids.gtin} onChange={e => setIds({ ...ids, gtin: e.target.value })} /></div>
      </div>
      <p className="hint">{T('Produktet lagres som utkast. Neste steg er å kontrollere varenummeret med grunnlag (BKU eller annet) på produktkortet.')}</p>
      <div className="row"><button className="btn add" type="submit">{T('Opprett')}</button><button className="btn grey" type="button" onClick={onCancel}>{T('Avbryt')}</button></div>
      <Findings error={err} />
    </form>
  );
}

/** Produkter › RT-tillatelser: every permit, filtered, with the permits that have no product. */
export function RtList({ me }: { me: Me }) {
  const [f, setF] = useState({ q: '', status: '', unlinked: '' });
  const [rows, setRows] = useState<any[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const load = () => api('/rt-permits?' + new URLSearchParams(Object.entries(f).filter(([, v]) => v))).then(setRows);
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [f]);
  const can = me.perms.includes('product.edit');
  return (
    <section>
      <div className="pagehead"><h2>{T('RT-tillatelser')}</h2></div>
      <p className="lead muted">{T('Råvaretollavgift (RT100): nedsatt sats per kg fra Landbruksdirektoratet. Hvert vedtak gjelder ett produkt og ett firma. Nye vedtak registreres fra produktkortet.')}</p>
      <div className="filters">
        <input value={f.q} onChange={e => setF({ ...f, q: e.target.value })} placeholder={T('Søk produkt, tillatelse, saksnummer, varenummer, klient')} aria-label={T('Søk')} style={{ flex: 1, minWidth: 240 }} />
        <select value={f.status} onChange={e => setF({ ...f, status: e.target.value })} aria-label={T('Status')}><option value="">{T('Alle statuser')}</option>
          <option value="VALID">{T('Gyldig')}</option><option value="EXPIRING">{T('Utløper snart')}</option><option value="EXPIRED">{T('Utløpt')}</option><option value="NOT_YET_VALID">{T('Ikke gyldig ennå')}</option></select>
        <label className="chk"><input type="checkbox" checked={!!f.unlinked} onChange={e => setF({ ...f, unlinked: e.target.checked ? '1' : '' })} /> {T('Uten produkt')}</label>
      </div>
      <div className="tblwrap"><table className="t">
        <thead><tr><th>{T('Tillatelse')}</th><th>{T('Produkt')}</th><th>{T('Klient (innehaver)')}</th><th>{T('Varenummer')}</th><th className="r">TALL</th><th className="r">TOES</th><th>{T('Gyldig')}</th><th>{T('Status')}</th></tr></thead>
        <tbody>{rows.map(r => <Fragment key={r.id}>
          <tr className="click" onClick={() => setOpen(open === r.id ? null : r.id)}>
            <td className="mono">{r.permit_no}</td><td>{r.product_no ? `${r.product_no} ${r.product_label}` : <span className="bad">{T('Uten produkt')}: {r.product_name}</span>}</td>
            <td>{r.holder_label ?? r.holder_name}</td><td className="mono nowrap">{fmtCode(r.tariff_code)}</td>
            <td className="r">{r.rate_tall != null ? Number(r.rate_tall).toLocaleString(locale()) : '—'}</td><td className="r">{r.rate_toes != null ? Number(r.rate_toes).toLocaleString(locale()) : '—'}</td>
            <td className="nowrap">{d(r.valid_from)} – {d(r.valid_to)}</td><td>{rtPill(r.status)}{!r.latest && r.status !== 'INACTIVE' && <span className="muted"> ({T('erstattet')})</span>}{r.warnings.length > 0 && <span className="pill submitted">!</span>}</td>
          </tr>
          {open === r.id && <tr><td colSpan={8}><RtPermitView r={r} can={can} onChange={load} /></td></tr>}
        </Fragment>)}
        {!rows.length && <tr><td colSpan={8} className="muted">{T('Ingen RT-tillatelser.')}</td></tr>}</tbody>
      </table></div>
    </section>
  );
}
