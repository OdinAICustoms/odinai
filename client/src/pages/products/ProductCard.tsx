import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, type Me } from '../../api';
import { T, fmtDateTime, locale } from '../../i18n';
import { Fields, Findings, ProductPicker } from '../../components/Form';
import { DocList, Upload } from '../../components/Docs';
import { NewRtPermit, RtPermitView } from '../../components/Rt';
import { PSTATUS, pPill, fmtCode } from './ProductList';

const TABS: [string, string][] = [['general', 'Generelt'], ['identifiers', 'Identifikatorer'], ['rt', 'RT-tillatelser'], ['documents', 'Dokumenter'], ['history', 'Historikk']];
const ID_LABEL: Record<string, string> = { GTIN: 'GTIN / EAN', CLIENT_ART: 'Klientens artikkelnr.', SUPPLIER_ART: 'Leverandørens artikkelnr.', NAME: 'Alternativt navn' };
const BASIS: Record<string, string> = { BKU: 'BKU (bindende klassifiseringsuttalelse)', RULING: 'Annen bindende uttalelse', OTHER: 'Annet grunnlag' };
const d = (v: string | null) => (v ? new Date(v + 'T00:00:00').toLocaleDateString(locale()) : '');

export function ProductCard({ me }: { me: Me }) {
  const { id } = useParams();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const tab = sp.get('tab') || 'general';
  const [p, setP] = useState<any>(null);
  const [err, setErr] = useState(''), [warn, setWarn] = useState<{ msg: string }[]>([]);
  const can = me.perms.includes('product.edit') && p && !p.merged_into;
  const load = () => api(`/products/${id}`).then(setP).catch(e => setErr(e.message));
  useEffect(() => { setP(null); load(); }, [id]);
  const act = async (fn: () => Promise<any>) => {
    setErr(''); setWarn([]);
    try { const r = await fn(); if (r?.product) setP(r.product); else await load(); setWarn(r?.warnings ?? []); return true; } catch (x) { setErr((x as Error).message); return false; }
  };
  if (err && !p) return <div className="err">{T(err)}</div>;
  if (!p) return <p className="muted">{T('Laster …')}</p>;
  const activeRt = p.rtPermits.filter((r: any) => r.status !== 'INACTIVE');
  return (
    <section>
      <div className="cardhead">
        <div><div className="muted">{p.product_no} · {T('klient')} {p.owner_id ? <a href={`/partners/${p.owner_id}`} onClick={e => { e.preventDefault(); nav(`/partners/${p.owner_id}?tab=products`); }}>{p.owner_name}</a> : <span className="bad">{T('ingen')}</span>}</div>
          <h2>{p.name}</h2></div>
        <div className="pills">{pPill(p.status)}{p.codeDisplay && <span className="chip mono">{p.codeDisplay}</span>}{p.rtRequired && <span className="chip">RT100</span>}
          {p.created_from !== 'MANUAL' && <span className="pill info">{T('Fra')} {p.created_from}</span>}{!p.active && <span className="pill cancelled">{T('Inaktiv')}</span>}</div>
        <span className="spacer" /><button className="btn grey" type="button" onClick={() => nav('/products')}>← {T('Produkter')}</button>
      </div>
      {p.merged_into && <div className="warnmsg">{T('Slått sammen med')} <a href={`/products/${p.merged_into}`} onClick={e => { e.preventDefault(); nav(`/products/${p.merged_into}`); }}>{p.mergedIntoNo}</a>.</div>}
      {p.status === 'EXPIRED' && p.status_reason && <div className="err">{T('Utløpt')}: {p.status_reason}. {T('Kontroller varenummeret og merk produktet som kontrollert på nytt.')}</div>}
      {p.rtRequired && !activeRt.some((r: any) => ['VALID', 'EXPIRING'].includes(r.status)) && <div className="warnmsg">{T('RT100 gjelder for varenummeret, men produktet har ingen gyldig RT-tillatelse. Uten tillatelse brukes ordinær sats.')}</div>}
      <div className="tabs" role="tablist">{TABS.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => { setSp({ tab: k }); setErr(''); setWarn([]); }}>
        {T(l)}{k === 'rt' && activeRt.length ? <span className="c">{activeRt.length}</span> : null}{k === 'identifiers' ? <span className="c">{p.identifiers.length}</span> : null}{k === 'documents' && p.documents.length ? <span className="c">{p.documents.length}</span> : null}</button>)}</div>
      <Findings warnings={warn} error={err} />
      {tab === 'general' && <General p={p} me={me} can={!!can} act={act} />}
      {tab === 'identifiers' && <Identifiers p={p} can={!!can} act={act} />}
      {tab === 'rt' && <div className="panelbox">
        <p className="hint" style={{ marginTop: 0 }}>{T('Ett vedtaksbrev gjelder ett produkt; tidligere vedtak beholdes som historikk. Den tillatelsen som gjelder på deklarasjonsdatoen brukes, og innehaveren kontrolleres mot importøren.')}</p>
        {can && <NewRtPermit productId={p.id} onDone={load} />}
        {p.rtPermits.map((r: any) => <RtPermitView key={r.id} r={r} can={!!can} onChange={load} showProduct={false} />)}
        {!p.rtPermits.length && <p className="muted">{p.rtRequired ? T('Ingen RT-tillatelse registrert.') : T('RT100 gjelder ikke for varenummeret.')}</p>}
      </div>}
      {tab === 'documents' && <div className="panelbox">
        <p className="hint" style={{ marginTop: 0 }}>{T('BKU-brev, produktspesifikasjon, sertifikater. Filene lagres uforandret og kan ikke endres i ettertid.')}</p>
        {can && <div className="row" style={{ marginTop: 0 }}><Upload label="+ Last opp BKU" docCode="BKU" path={`/products/${p.id}/documents`} onDone={load} />
          <Upload label="+ Last opp spesifikasjon" docCode="SPEC" path={`/products/${p.id}/documents`} onDone={load} />
          <Upload label="+ Last opp annet" path={`/products/${p.id}/documents`} onDone={load} /></div>}
        <DocList docs={p.documents} can={!!can} onChange={load} />
        {!p.documents.length && <p className="muted">{T('Ingen dokumenter.')}</p>}
      </div>}
      {tab === 'history' && <div className="tblwrap"><table className="t"><thead><tr><th>{T('Tidspunkt')}</th><th>{T('Bruker')}</th><th>{T('Felt')}</th><th>{T('Fra')}</th><th>{T('Til')}</th><th>{T('Grunnlag')}</th></tr></thead>
        <tbody>{p.history.map((h: any) => <tr key={h.id}><td className="nowrap">{fmtDateTime(h.at)}</td><td>{h.user_name || T('System')}</td><td>{h.field}</td>
          <td className="muted">{h.field === 'code' ? fmtCode(h.old_value) : h.old_value}</td><td>{h.field === 'code' ? fmtCode(h.new_value) : h.new_value}</td><td className="muted">{h.basis}</td></tr>)}</tbody></table></div>}
    </section>
  );
}

function General({ p, me, can, act }: { p: any; me: Me; can: boolean; act: (fn: () => Promise<any>) => Promise<boolean> }) {
  const nav = useNavigate();
  const [v, setV] = useState<Record<string, any>>({});
  const [basis, setBasis] = useState('');
  const [st, setSt] = useState<Record<string, any> | null>(null);
  const [merge, setMerge] = useState('');
  useEffect(() => { setV({ ...p, code: p.codeDisplay ?? '' }); setBasis(''); }, [p]);
  const codeChanged = (v.code || '').replace(/\D/g, '') !== (p.code || '');
  const save = (e: FormEvent) => { e.preventDefault(); const { owner_id, supplier_id, ...rest } = v; void owner_id; void supplier_id;
    act(() => api(`/products/${p.id}`, { method: 'PUT', body: { ...rest, version: p.version, change_basis: basis } })); };
  return (
    <div className="cols2">
      <form className="panelbox" onSubmit={save}>
        <h3>{T('Produkt')}</h3>
        <fieldset disabled={!can} className="plain"><Fields idPrefix="pg" value={v} onChange={setV} spec={[
          { k: 'name', label: 'Produktnavn', req: true, wide: true }, { k: 'descr', label: 'Varebeskrivelse (rubrikk 31)', t: 'textarea', wide: true },
          { k: 'code', label: 'Varenummer (8 siffer)' }, { k: 'origin', label: 'Opprinnelsesland', t: 'country' }, { k: 'pref_basis', label: 'Preferansegrunnlag' },
          { k: 'supp_unit', label: 'Annen enhet (rubrikk 41)' }, { k: 'net_kg', label: 'Nettovekt per enhet (kg)', t: 'number' }, { k: 'gross_kg', label: 'Bruttovekt per enhet (kg)', t: 'number' },
          { k: 'price', label: 'Normalpris', t: 'number' }, { k: 'currency', label: 'Valuta' }, { k: 'valid_to', label: 'Klassifisering gyldig til', t: 'date' },
          { k: 'notes', label: 'Merknader', t: 'textarea', wide: true }]} /></fieldset>
        {p.tariff_text && <p className="hint">{T('Tolltariffen')}: {p.tariff_text}{p.tariff_supp_unit ? ` · ${T('annen enhet')} ${p.tariff_supp_unit}` : ''}</p>}
        {p.code && p.inTariff === false && <p className="bad">{T('Varenummeret finnes ikke i gjeldende tolltariff.')}</p>}
        {can && codeChanged && <div className="warnmsg"><label htmlFor="pg-basis">{T('Grunnlag for endret varenummer (påkrevd)')}</label>
          <input id="pg-basis" value={basis} onChange={e => setBasis(e.target.value)} placeholder={T('f.eks. BKU 2026/123 eller begrunnelse')} />
          {p.status === 'CHECKED' && <p className="hint">{T('Produktet er kontrollert og må kontrolleres på nytt etter endringen.')}</p>}</div>}
        {can && <div className="row"><button className="btn" type="submit">{T('Lagre')}</button></div>}
        <p className="hint">{T('Klient')}: {p.owner_name ?? '—'} · {T('Leverandør')}: {p.supplier_name ? <a href={`/partners/${p.supplier_id}`} onClick={e => { e.preventDefault(); nav(`/partners/${p.supplier_id}`); }}>{p.supplier_name}</a> : '—'}</p>
      </form>
      <div>
        <div className="panelbox"><h3>{T('Klassifisering og kontroll')}</h3>
          <dl className="kv"><dt>{T('Status')}</dt><dd>{pPill(p.status)}{p.status_reason ? <span className="muted"> {p.status_reason}</span> : null}</dd>
            <dt>{T('Grunnlag')}</dt><dd>{p.basis ? T(BASIS[p.basis]) : '—'}{p.reference_no ? ` · ${p.reference_no}` : ''}</dd>
            <dt>{T('Kontrollert')}</dt><dd>{p.checked_at ? fmtDateTime(p.checked_at) : '—'}</dd>
            {p.conflicts.length > 0 && <><dt>{T('Avvik på faktura')}</dt><dd>{p.conflicts.map((c: any) => `${fmtCode(c.invoice_code)} (${c.n})`).join(', ')}</dd></>}</dl>
          {can && !st && <div className="row">
            {p.status !== 'CHECKED' && me.perms.includes('product.check') && <button className="btn add" type="button" onClick={() => setSt({ status: 'CHECKED', basis: p.basis ?? 'BKU', reference_no: p.reference_no ?? '' })}>{T('Merk som kontrollert')}</button>}
            {p.status === 'DRAFT' && <button className="btn grey" type="button" onClick={() => act(() => api(`/products/${p.id}/status`, { body: { status: 'REVIEW' } }))}>{T('Start kontroll')}</button>}
            {p.status !== 'BLOCKED' && <button className="btn grey" type="button" onClick={() => setSt({ status: 'BLOCKED', reason: '' })}>{T('Blokker')}</button>}
            {p.status === 'BLOCKED' && <button className="btn grey" type="button" onClick={() => act(() => api(`/products/${p.id}/status`, { body: { status: 'REVIEW', reason: 'Blokkering opphevet' } }))}>{T('Opphev blokkering')}</button>}
          </div>}
          {st && <form className="subform" onSubmit={async e => { e.preventDefault(); if (await act(() => api(`/products/${p.id}/status`, { body: st }))) setSt(null); }}>
            {st.status === 'CHECKED' ? <Fields idPrefix="st" value={st} onChange={setSt} spec={[{ k: 'basis', label: 'Grunnlag', t: 'select', req: true, opts: BASIS }, { k: 'reference_no', label: 'BKU- / referansenummer' }]} />
              : <Fields idPrefix="st" value={st} onChange={setSt} spec={[{ k: 'reason', label: 'Hvorfor blokkeres produktet?', wide: true, req: true }]} />}
            <div className="row"><button className="btn" type="submit">{T(st.status === 'CHECKED' ? 'Merk som kontrollert' : 'Blokker')}</button><button className="btn grey" type="button" onClick={() => setSt(null)}>{T('Avbryt')}</button></div></form>}
        </div>
        {can && <div className="panelbox"><h3>{T('Dublett')}</h3>
          <label htmlFor="pm-target">{T('Slå sammen inn i produkt (produktnr.)')}</label>
          <ProductPicker id="pm-target" exclude={p.id} ownerId={p.owner_id} onPick={setMerge} />
          <p className="hint">{T('Identifikatorer, dokumenter, historikk og RT-tillatelser flyttes. Dette produktet blir inaktivt.')}</p>
          <div className="row"><button className="btn danger" type="button" disabled={!merge || !me.perms.includes('product.check')} onClick={() => act(() => api(`/products/${p.id}/merge`, { body: { target: merge } }))}>{T('Slå sammen')}</button>
            {p.active ? <button className="btn grey" type="button" onClick={() => act(() => api(`/products/${p.id}/deactivate`, { body: {} }))}>{T('Gjør inaktiv')}</button>
              : <button className="btn grey" type="button" onClick={() => act(() => api(`/products/${p.id}/reactivate`, { body: {} }))}>{T('Aktiver igjen')}</button>}</div></div>}
      </div>
    </div>
  );
}

function Identifiers({ p, can, act }: { p: any; can: boolean; act: (fn: () => Promise<any>) => Promise<boolean> }) {
  const [v, setV] = useState<Record<string, any> | null>(null);
  return (
    <div className="panelbox">
      <p className="hint" style={{ marginTop: 0 }}>{T('Fakturalinjer kjennes igjen på GTIN, klientens artikkelnummer og leverandørens artikkelnummer. Nye numre læres når en linje kobles til produktet.')}</p>
      {can && !v && <button className="btn add small" type="button" onClick={() => setV({ type: 'CLIENT_ART' })}>{T('+ Legg til')}</button>}
      {v && <form className="subform" onSubmit={async e => { e.preventDefault(); if (await act(() => api(`/products/${p.id}/identifiers`, { body: v }))) setV(null); }}>
        <Fields idPrefix="pi" value={v} onChange={setV} spec={[{ k: 'type', label: 'Type', t: 'select', req: true, opts: ID_LABEL }, { k: 'value', label: 'Verdi', req: true },
          ...(v.type === 'SUPPLIER_ART' && !p.supplier_id ? [{ k: 'partner_id', label: 'Leverandør', t: 'partner' as const, req: true }] : [])]} />
        <div className="row"><button className="btn" type="submit">{T('Lagre')}</button><button className="btn grey" type="button" onClick={() => setV(null)}>{T('Avbryt')}</button></div></form>}
      <div className="tblwrap"><table className="t"><thead><tr><th>{T('Type')}</th><th>{T('Verdi')}</th><th>{T('Tilhører')}</th><th>{T('Kilde')}</th><th>{T('Lagt til')}</th><th /></tr></thead>
        <tbody>{p.identifiers.map((i: any) => <tr key={i.id}><td>{T(ID_LABEL[i.type])}</td><td className="mono">{i.value}</td><td>{i.partner_name ?? '—'}</td><td className="muted">{i.source}</td><td className="muted">{d(String(i.created_at).slice(0, 10))}</td>
          <td className="r">{can && <button className="linkbtn" type="button" onClick={() => act(() => api(`/products/${p.id}/identifiers/${i.id}/remove`, { body: {} }))}>{T('Fjern')}</button>}</td></tr>)}
          {!p.identifiers.length && <tr><td colSpan={6} className="muted">{T('Ingen identifikatorer.')}</td></tr>}</tbody></table></div>
    </div>
  );
}

export { PSTATUS };
