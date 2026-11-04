import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type Me } from '../../api';
import { T, getLang } from '../../i18n';
import { Fields, Findings } from '../../components/Form';

type Meta = { roles: Record<string, { no: string; en: string }>; [k: string]: any };

/** Business partners: counters, filters, list, and the two ways in (Brønnøysund or by hand). */
export function PartnerList({ me }: { me: Me }) {
  const nav = useNavigate();
  const [meta, setMeta] = useState<Meta | null>(null);
  const [cnt, setCnt] = useState<any>({});
  const [rows, setRows] = useState<any[]>([]);
  const [f, setF] = useState({ q: '', role: '', client: '', status: 'ACTIVE' });
  const [mode, setMode] = useState<'' | 'brreg' | 'manual'>('');
  const can = me.perms.includes('partner.edit');
  useEffect(() => { api('/partners/meta').then(setMeta); api('/partners/counters').then(setCnt); }, []);
  useEffect(() => {
    const t = setTimeout(() => api('/partners?' + new URLSearchParams(Object.entries(f).filter(([, v]) => v) as [string, string][])).then(setRows), 200);
    return () => clearTimeout(t);
  }, [f]);
  const roleName = (r: string) => meta?.roles[r]?.[getLang()] ?? r;

  return (
    <section>
      <div className="pagehead"><h2>{T('Forretningspartnere')}</h2><span className="spacer" />
        {can && <><button className="btn ghost" type="button" onClick={() => setMode('manual')}>{T('+ Registrer manuelt')}</button>
          <button className="btn add" type="button" onClick={() => setMode('brreg')}>{T('+ Hent fra Brønnøysund')}</button></>}</div>
      <div className="cards">
        <button type="button" className={`card ${!f.client && f.status === 'ACTIVE' ? 'on' : ''}`} onClick={() => setF({ ...f, client: '', status: 'ACTIVE' })}><div className="l">{T('Aktive partnere')}</div><div className="n">{cnt.active ?? '–'}</div></button>
        <button type="button" className={`card ${f.client ? 'on' : ''}`} onClick={() => setF({ ...f, client: '1', status: 'ACTIVE' })}><div className="l">{T('Klienter')}</div><div className="n">{cnt.clients ?? '–'}</div></button>
        <div className={`card ${cnt.fullmaktExpiring ? 'warn' : ''}`}><div className="l">{T('Fullmakt utløper innen 60 dager')}</div><div className="n">{cnt.fullmaktExpiring ?? '–'}</div></div>
        <div className={`card ${cnt.duplicates ? 'alert' : ''}`}><div className="l">{T('Mulige dubletter (org.nr.)')}</div><div className="n">{cnt.duplicates ?? '–'}</div></div>
        <button type="button" className={`card ${f.status === 'INACTIVE' ? 'on' : ''}`} onClick={() => setF({ ...f, client: '', status: 'INACTIVE' })}><div className="l">{T('Inaktive')}</div><div className="n">{cnt.inactive ?? '–'}</div></button>
      </div>
      {mode === 'brreg' && <BrregImport meta={meta} onDone={id => nav(`/partners/${id}`)} onCancel={() => setMode('')} />}
      {mode === 'manual' && <ManualNew onDone={id => nav(`/partners/${id}`)} onCancel={() => setMode('')} />}
      <div className="filters">
        <input value={f.q} onChange={e => setF({ ...f, q: e.target.value })} placeholder={T('Søk navn, partnernr., org.nr., EORI')} aria-label={T('Søk')} style={{ flex: 1, minWidth: 240 }} />
        <select value={f.role} onChange={e => setF({ ...f, role: e.target.value })} aria-label={T('Rolle')}>
          <option value="">{T('Alle roller')}</option>{meta && Object.keys(meta.roles).map(r => <option key={r} value={r}>{r} – {roleName(r)}</option>)}</select>
      </div>
      <div className="tblwrap"><table className="t">
        <thead><tr><th>{T('Partnernr.')}</th><th>{T('Navn')}</th><th>{T('Land')}</th><th>{T('Org.nr. / EORI')}</th><th>{T('Roller')}</th><th>{T('Adresse')}</th><th /></tr></thead>
        <tbody>{rows.map(p => <tr key={p.id} className="click" onClick={() => nav(`/partners/${p.id}`)}>
          <td className="mono">{p.partner_no}</td><td><b>{p.legal_name}</b></td><td>{p.registration_country}</td>
          <td className="mono">{p.org_no || p.eori || ''}{p.eori_check === 'INVALID' && <span className="pill rejected"> EORI</span>}</td>
          <td>{p.roles.map((r: string) => <span key={r} className="chip" title={roleName(r)}>{r}</span>)}</td>
          <td className="muted">{p.address}</td>
          <td>{p.is_client && <span className="pill info">{T('Klient')}</span>}{p.registry_warning && <span className="pill rejected">{T('Brønnøysund')}</span>}{p.status !== 'ACTIVE' && <span className="pill cancelled">{T('Inaktiv')}</span>}</td>
        </tr>)}
        {!rows.length && <tr><td colSpan={7} className="muted">{T('Ingen partnere funnet.')}</td></tr>}</tbody>
      </table></div>
    </section>
  );
}

function BrregImport({ meta, onDone, onCancel }: { meta: Meta | null; onDone: (id: string) => void; onCancel: () => void }) {
  const [q, setQ] = useState(''), [hits, setHits] = useState<any[]>([]), [sel, setSel] = useState<any>(null);
  const [client, setClient] = useState(true), [roles, setRoles] = useState<string[]>(['IMP', 'CON']);
  const [err, setErr] = useState(''), [busy, setBusy] = useState(false);
  const search = async (e: FormEvent) => { e.preventDefault(); setErr(''); setSel(null); try { setHits(await api('/partners/brreg/search?q=' + encodeURIComponent(q))); } catch (x) { setErr((x as Error).message); } };
  const imp = async () => {
    setBusy(true); setErr('');
    try { const r = await api('/partners/brreg/import', { body: { orgNo: sel.orgNo, is_client: client, roles } }); onDone(r.partner.id); }
    catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="panelbox">
      <h3>{T('Hent fra Brønnøysund (Enhetsregisteret)')}</h3>
      <form className="filters" onSubmit={search}>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder={T('Firmanavn eller organisasjonsnummer')} aria-label={T('Søk i Enhetsregisteret')} style={{ flex: 1 }} autoFocus />
        <button className="btn" type="submit">{T('Søk')}</button><button className="btn grey" type="button" onClick={onCancel}>{T('Avbryt')}</button>
      </form>
      {!sel && hits.length > 0 && <div className="tblwrap"><table className="t"><tbody>{hits.map(h =>
        <tr key={h.orgNo} className={h.partner ? '' : 'click'} onClick={() => !h.partner && setSel(h)}>
          <td className="mono">{h.orgNo}</td><td><b>{h.name}</b> <span className="muted">{h.orgForm?.text}</span></td>
          <td className="muted">{h.businessAddress ? [h.businessAddress.lines.join(', '), h.businessAddress.postalCode, h.businessAddress.city].filter(Boolean).join(' ') : ''}</td>
          <td>{h.partner ? <span className="pill cancelled">{T('Finnes:')} {h.partner.partner_no}</span> : (h.bankrupt || h.windingUp || h.deleted) ? <span className="pill rejected">{T('Konkurs/avvikling')}</span> : null}</td>
        </tr>)}</tbody></table></div>}
      {sel && <div>
        <p><b>{sel.name}</b> · {sel.orgNo} · {sel.vatRegistered ? T('MVA-registrert') : T('Ikke MVA-registrert')}</p>
        <label className="chk"><input type="checkbox" checked={client} onChange={e => setClient(e.target.checked)} /> {T('Klient av Odin Customs')}</label>
        <fieldset className="roles"><legend>{T('Roller')}</legend>
          {meta && Object.entries(meta.roles).map(([k, v]) => <label key={k} className="chk"><input type="checkbox" checked={roles.includes(k)}
            onChange={() => setRoles(r => r.includes(k) ? r.filter(x => x !== k) : [...r, k])} /> {k} – {v[getLang()]}</label>)}</fieldset>
        <p className="hint">{T('Org.nr., EORI (NO + org.nr.), MVA-nummer, adresser og kontakt hentes automatisk. Av rollene i Brønnøysund lagres bare navn.')}</p>
        <div className="row"><button className="btn add" type="button" disabled={busy} onClick={imp}>{T('Opprett partner')}</button>
          <button className="btn grey" type="button" onClick={() => setSel(null)}>{T('Tilbake')}</button></div>
      </div>}
      <Findings error={err} />
    </div>
  );
}

function ManualNew({ onDone, onCancel }: { onDone: (id: string) => void; onCancel: () => void }) {
  const [v, setV] = useState<Record<string, any>>({ category: 'ORGANIZATION', registration_country: 'NO', is_client: false });
  const [err, setErr] = useState('');
  const save = async (e: FormEvent) => {
    e.preventDefault(); setErr('');
    try { const r = await api('/partners', { body: v }); onDone(r.partner.id); } catch (x) { setErr((x as Error).message); }
  };
  return (
    <form className="panelbox" onSubmit={save}>
      <h3>{T('Ny forretningspartner')}</h3>
      <p className="hint">{T('For norske firma: bruk «Hent fra Brønnøysund» — da kommer org.nr., adresse og status med.')}</p>
      <Fields idPrefix="np" value={v} onChange={setV} spec={[
        { k: 'legal_name', label: 'Juridisk navn', req: true, wide: true },
        { k: 'category', label: 'Kategori', t: 'select', req: true, opts: { ORGANIZATION: 'Organisasjon', PERSON: 'Person' } },
        { k: 'registration_country', label: 'Land', t: 'country', req: true },
        { k: 'is_client', label: 'Klient av Odin Customs', t: 'check' }]} />
      <div className="row"><button className="btn" type="submit">{T('Opprett')}</button><button className="btn grey" type="button" onClick={onCancel}>{T('Avbryt')}</button></div>
      <Findings error={err} />
    </form>
  );
}
