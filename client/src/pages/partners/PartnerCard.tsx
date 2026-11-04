import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, type Me } from '../../api';
import { T, fmtDateTime, getLang, locale } from '../../i18n';
import { Fields, Findings, PartnerPicker, type FieldSpec } from '../../components/Form';

type Meta = { roles: Record<string, { no: string; en: string }>; addressTypes: Record<string, string>; identifierTypes: Record<string, string>;
  contactTypes: Record<string, string>; relationshipTypes: Record<string, string>; categories: Record<string, string>; priceItems: any[] };
type Result = { partner: any; warnings?: { msg: string }[] };

const TABS: [string, string][] = [['general', 'Generelt'], ['addresses', 'Adresser'], ['identifiers', 'Identifikatorer'], ['roles', 'Roller'],
  ['contacts', 'Kontakter'], ['links', 'Koblinger og fullmakt'], ['credit', 'Tollkreditt'], ['prices', 'Priser og fakturering'], ['registry', 'Brønnøysund'], ['audit', 'Endringslogg']];
const d = (v: string | null) => (v ? new Date(v + 'T00:00:00').toLocaleDateString(locale()) : '');
const period = (r: any) => (r.valid_from || r.valid_to ? `${d(r.valid_from) || '…'} – ${d(r.valid_to) || '…'}` : '');

export function PartnerCard({ me }: { me: Me }) {
  const { id } = useParams();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const tab = sp.get('tab') || 'general';
  const [p, setP] = useState<any>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [warn, setWarn] = useState<{ msg: string }[]>([]);
  const [err, setErr] = useState('');
  const can = me.perms.includes('partner.edit') && p && !p.merged_into;
  useEffect(() => { api('/partners/meta').then(setMeta); }, []);
  useEffect(() => { setP(null); setErr(''); api(`/partners/${id}`).then(setP).catch(e => setErr(e.message)); }, [id]);
  /** Run a change; the server answers with the fresh card and any warnings. */
  const act = async (fn: () => Promise<Result>) => {
    setErr(''); setWarn([]);
    try { const r = await fn(); setP(r.partner); setWarn(r.warnings ?? []); return true; } catch (x) { setErr((x as Error).message); return false; }
  };
  if (err && !p) return <div className="err">{T(err)}</div>;
  if (!p || !meta) return <p className="muted">{T('Laster …')}</p>;
  const reg = p.registry;
  const regBad = reg && [reg.deleted && 'slettet fra Enhetsregisteret', reg.bankrupt && 'konkurs', reg.winding_up && 'under avvikling', reg.forced_dissolution && 'under tvangsavvikling'].filter(Boolean);

  return (
    <section>
      <div className="cardhead">
        <div><div className="muted">{p.partner_no} · {T(meta.categories[p.category])} · {p.registration_country}{p.orgNo ? ` · ${T('org.nr.')} ${p.orgNo}` : ''}</div>
          <h2>{p.legal_name}</h2></div>
        <div className="pills">{p.is_client && <span className="pill info">{T('Klient av Odin Customs')}</span>}
          <span className={`pill ${p.status === 'ACTIVE' ? 'accepted' : 'cancelled'}`}>{T(p.status === 'ACTIVE' ? 'Aktiv' : 'Inaktiv')}</span>
          {p.activeRoles.map((r: string) => <span key={r} className="chip" title={meta.roles[r]?.[getLang()]}>{r}</span>)}</div>
        <span className="spacer" />
        <button className="btn grey" type="button" onClick={() => nav('/partners')}>← {T('Alle partnere')}</button>
      </div>
      {p.merged_into && <div className="warnmsg">{T('Slått sammen med')} <a href={`/partners/${p.merged_into}`} onClick={e => { e.preventDefault(); nav(`/partners/${p.merged_into}`); }}>{p.mergedIntoNo}</a>. {T('Kortet vises bare som historikk.')}</div>}
      {regBad?.length ? <div className="err">{T('Brønnøysund')}: {regBad.map((x: string) => T(x)).join(', ')} ({fmtDateTime(reg.fetched_at)})</div> : null}
      {p.duplicates.length > 0 && <div className="warnmsg">{T('Samme organisasjonsnummer finnes på')} {p.duplicates.map((x: any) => <a key={x.id} href={`/partners/${x.id}`} onClick={e => { e.preventDefault(); nav(`/partners/${x.id}`); }}>{x.partner_no} {x.legal_name}</a>)}.
        {' '}{T('Slå sammen under «Generelt».')}</div>}
      <div className="tabs" role="tablist">{TABS.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''}
        onClick={() => { setSp({ tab: k }); setErr(''); setWarn([]); }}>{T(l)}{k === 'addresses' ? <span className="c">{p.addresses.filter((a: any) => a.status === 'ACTIVE').length}</span> : null}</button>)}</div>
      <Findings warnings={warn} error={err} />
      {tab === 'general' && <General p={p} meta={meta} me={me} can={!!can} act={act} />}
      {tab === 'addresses' && <Rows p={p} kind="addresses" can={!!can} act={act} spec={[
        { k: 'address_type', label: 'Type', t: 'select', req: true, opts: meta.addressTypes }, { k: 'address_name', label: 'Navn (valgfritt)' },
        { k: 'street', label: 'Gate', wide: true }, { k: 'postal_code', label: 'Postnummer' }, { k: 'city', label: 'Poststed' },
        { k: 'country_code', label: 'Land', t: 'country', req: true }, { k: 'location_code', label: 'Lagerkode / varens plassering' },
        { k: 'valid_from', label: 'Gyldig fra', t: 'date' }, { k: 'valid_to', label: 'Gyldig til', t: 'date' }, { k: 'is_standard', label: 'Standardadresse', t: 'check' }]}
        defaults={{ address_type: 'REGISTERED', country_code: p.registration_country }}
        cols={[['Type', a => T(meta.addressTypes[a.address_type]) + (a.is_standard ? ' ★' : '')], ['Adresse', a => [a.address_name, a.street, [a.postal_code, a.city].join(' '), a.country_code].filter(x => x && x.trim()).join(', ')],
          ['Lagerkode', a => a.location_code], ['Gyldig', period]]} />}
      {tab === 'identifiers' && <Rows p={p} kind="identifiers" can={!!can} act={act} spec={[
        { k: 'identifier_type', label: 'Type', t: 'select', req: true, opts: meta.identifierTypes }, { k: 'identifier_value', label: 'Verdi', req: true },
        { k: 'issuing_country', label: 'Utstedt av', t: 'country' }, { k: 'valid_from', label: 'Gyldig fra', t: 'date' }, { k: 'valid_to', label: 'Gyldig til', t: 'date' },
        { k: 'is_primary', label: 'Hovedidentifikator av denne typen', t: 'check' }]}
        defaults={{ identifier_type: 'ORG_NO', is_primary: true }}
        cols={[['Type', i => T(meta.identifierTypes[i.identifier_type]) + (i.is_primary ? ' ★' : '')], ['Verdi', i => <span className="mono">{i.identifier_value}</span>],
          ['Kontroll', i => i.identifier_type !== 'EORI' ? (i.source === 'BRREG' ? <span className="muted">Brønnøysund</span> : null)
            : <>{i.check_status && <span className={`pill ${i.check_status === 'VALID' ? 'accepted' : i.check_status === 'INVALID' ? 'rejected' : 'cancelled'}`}>{T({ VALID: 'Gyldig', INVALID: 'Ugyldig', NOT_APPLICABLE: 'Ikke i EU-registeret' }[i.check_status as string] ?? i.check_status)}</span>}
              {i.check_name && <span className="muted"> {i.check_name}</span>}{i.checked_at && <span className="muted"> · {fmtDateTime(i.checked_at)}</span>}
              {can && i.status === 'ACTIVE' && <button className="linkbtn" type="button" onClick={() => act(() => api(`/partners/${p.id}/identifiers/${i.id}/check-eori`, { body: {} }))}>{T('Sjekk EORI')}</button>}</>],
          ['Gyldig', period]]} />}
      {tab === 'roles' && <Rows p={p} kind="roles" can={!!can} act={act} spec={[
        { k: 'role_code', label: 'Rolle', t: 'select', req: true, opts: Object.fromEntries(Object.entries(meta.roles).map(([k, v]) => [k, `${k} – ${v.no}`])) },
        { k: 'valid_from', label: 'Gyldig fra', t: 'date' }, { k: 'valid_to', label: 'Gyldig til', t: 'date' }, { k: 'notes', label: 'Merknad', wide: true }]}
        defaults={{ role_code: 'IMP' }} cols={[['Rolle', r => `${r.role_code} – ${meta.roles[r.role_code]?.[getLang()] ?? ''}`], ['Gyldig', period], ['Merknad', r => r.notes]]} />}
      {tab === 'contacts' && <Rows p={p} kind="contacts" can={!!can} act={act} spec={[
        { k: 'contact_type', label: 'Type', t: 'select', req: true, opts: meta.contactTypes }, { k: 'contact_name', label: 'Navn' }, { k: 'department', label: 'Avdeling' },
        { k: 'email', label: 'E-post' }, { k: 'telephone', label: 'Telefon' }, { k: 'is_primary', label: 'Hovedkontakt', t: 'check' },
        { k: 'clearance_mail', label: 'Får godkjent fortolling på e-post', t: 'check' }]}
        defaults={{ contact_type: 'CUSTOMS' }} cols={[['Type', c => T(meta.contactTypes[c.contact_type]) + (c.is_primary ? ' ★' : '')], ['Navn', c => [c.contact_name, c.department].filter(Boolean).join(', ')],
          ['E-post', c => c.email], ['Telefon', c => c.telephone], ['Fortolling på e-post', c => c.clearance_mail ? '✓' : '']]} />}
      {tab === 'links' && <Links p={p} meta={meta} can={!!can} act={act} nav={nav} />}
      {tab === 'credit' && <Rows p={p} kind="credit" can={!!can} act={act} spec={[
        { k: 'account', label: 'Kontonummer', req: true }, { k: 'payment_type', label: 'Type', t: 'select', req: true, opts: { TOLLKREDITT: 'Tollkreditt', DAGSOPPGJOR: 'Dagsoppgjør' } },
        { k: 'valid_to', label: 'Gyldig til', t: 'date' }]} defaults={{ payment_type: 'TOLLKREDITT' }}
        intro="Kontoene brukes i rubrikk 48 når partneren er tollskyldner (rollen DEB) eller representant."
        cols={[['Konto', c => <span className="mono">{c.account}</span>], ['Type', c => T(c.payment_type === 'TOLLKREDITT' ? 'Tollkreditt' : 'Dagsoppgjør')], ['Gyldig til', c => d(c.valid_to)]]} />}
      {tab === 'prices' && <Prices p={p} meta={meta} me={me} can={!!can} act={act} />}
      {tab === 'registry' && <Registry p={p} can={!!can} act={act} />}
      {tab === 'audit' && <PartnerAudit id={p.id} />}
    </section>
  );
}

/* ------------------------------ general ------------------------------ */
function General({ p, meta, me, can, act }: { p: any; meta: Meta; me: Me; can: boolean; act: (fn: () => Promise<Result>) => Promise<boolean> }) {
  const [v, setV] = useState<Record<string, any>>({});
  const [merge, setMerge] = useState<string>('');
  useEffect(() => setV({ ...p, deposit_amount: p.deposit_amount ?? '' }), [p]);
  const save = (e: FormEvent) => { e.preventDefault(); act(() => api(`/partners/${p.id}`, { method: 'PUT', body: { ...v, version: p.version } })); };
  const manage = me.perms.includes('partner.manage');
  return (
    <div className="cols2">
      <form className="panelbox" onSubmit={save}>
        <h3>{T('Generelt')}</h3>
        <fieldset disabled={!can} className="plain">
          <Fields idPrefix="g" value={v} onChange={setV} spec={[
            { k: 'legal_name', label: 'Juridisk navn', req: true, wide: true }, { k: 'category', label: 'Kategori', t: 'select', req: true, opts: meta.categories },
            { k: 'registration_country', label: 'Land', t: 'country', req: true }, { k: 'language', label: 'Språk', t: 'select', req: true, opts: { NO: 'Norsk', EN: 'Engelsk' } },
            { k: 'is_client', label: 'Klient av Odin Customs', t: 'check' },
            { k: 'default_incoterms', label: 'Standard leveringsvilkår', t: 'select', opts: Object.fromEntries(['EXW', 'FCA', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP', 'FAS', 'FOB', 'CFR', 'CIF'].map(x => [x, x])) },
            { k: 'default_incoterms_place', label: 'Standard leveringssted' },
            { k: 'deposit_paid', label: 'Depositum innbetalt', t: 'check' }, { k: 'deposit_amount', label: 'Depositum (NOK)', t: 'number' }, { k: 'deposit_date', label: 'Depositum dato', t: 'date' },
            { k: 'notes', label: 'Merknader', t: 'textarea', wide: true }]} />
        </fieldset>
        {can && <div className="row"><button className="btn" type="submit">{T('Lagre')}</button></div>}
        <p className="hint">{T('Opprettet')} {fmtDateTime(p.created_at)} · {T('sist endret')} {fmtDateTime(p.updated_at)} · {T('kilde')}: {p.source}</p>
      </form>
      <div>
        <div className="panelbox"><h3>{T('Sammendrag')}</h3>
          <dl className="kv"><dt>{T('Standardadresse')}</dt><dd>{p.addressText || '—'}</dd><dt>{T('Org.nr.')}</dt><dd className="mono">{p.orgNo || '—'}</dd>
            <dt>EORI</dt><dd className="mono">{p.eori || '—'}</dd><dt>{T('MVA-nummer')}</dt><dd className="mono">{p.vatNo || '—'}</dd>
            <dt>{T('Roller')}</dt><dd>{p.activeRoles.map((r: string) => `${r} – ${meta.roles[r]?.[getLang()]}`).join(', ') || '—'}</dd>
            <dt>{T('Fullmakt til Odin')}</dt><dd>{p.fullmakt.filter((f: any) => f.partner_id === p.id && f.status === 'ACTIVE').map((f: any) => `${f.rep_name} ${d(f.valid_from)}–${d(f.valid_to) || '…'}`).join('; ') || '—'}</dd></dl></div>
        {manage && !p.merged_into && <div className="panelbox"><h3>{T('Status og sammenslåing')}</h3>
          <div className="row" style={{ marginTop: 0 }}>{p.status === 'ACTIVE'
            ? <button className="btn grey" type="button" onClick={() => act(() => api(`/partners/${p.id}/deactivate`, { body: {} }))}>{T('Gjør inaktiv')}</button>
            : <button className="btn grey" type="button" onClick={() => act(() => api(`/partners/${p.id}/reactivate`, { body: {} }))}>{T('Aktiver igjen')}</button>}</div>
          <label htmlFor="mergeTarget">{T('Slå sammen inn i (partneren som beholdes)')}</label>
          <PartnerPicker id="mergeTarget" exclude={p.id} onPick={pid => setMerge(pid)} />
          <p className="hint">{T('Adresser, identifikatorer, roller, kontakter, kontoer, priser, produkter og RT-tillatelser flyttes. Dette kortet blir inaktivt og viser hvor det ble av.')}</p>
          <button className="btn danger" type="button" disabled={!merge} onClick={() => act(() => api(`/partners/${p.id}/merge`, { body: { target: merge } }))}>{T('Slå sammen')}</button></div>}
      </div>
    </div>
  );
}

/* ------------------------------ dated rows ------------------------------ */
function Rows({ p, kind, spec, cols, defaults, can, act, intro }: { p: any; kind: string; spec: FieldSpec[]; cols: [string, (r: any) => ReactNode][];
  defaults: Record<string, any>; can: boolean; act: (fn: () => Promise<Result>) => Promise<boolean>; intro?: string }) {
  const [edit, setEdit] = useState<Record<string, any> | null>(null);
  const [showEnded, setShowEnded] = useState(false);
  const rows = (p[kind] as any[]).filter(r => showEnded || r.status === 'ACTIVE');
  const save = async (e: FormEvent) => { e.preventDefault(); if (await act(() => api(`/partners/${p.id}/rows/${kind}`, { body: edit! }))) setEdit(null); };
  return (
    <div className="panelbox">
      {intro && <p className="hint" style={{ marginTop: 0 }}>{T(intro)}</p>}
      <div className="row" style={{ marginTop: 0, marginBottom: 8 }}>
        {can && !edit && <button className="btn add small" type="button" onClick={() => setEdit({ ...defaults })}>{T('+ Legg til')}</button>}
        <label className="chk" style={{ marginLeft: 'auto' }}><input type="checkbox" checked={showEnded} onChange={e => setShowEnded(e.target.checked)} /> {T('Vis avsluttede')}</label>
      </div>
      {edit && <form onSubmit={save} className="subform">
        <Fields idPrefix={kind} value={edit} onChange={setEdit} spec={spec} />
        <div className="row"><button className="btn" type="submit">{T('Lagre')}</button><button className="btn grey" type="button" onClick={() => setEdit(null)}>{T('Avbryt')}</button></div>
      </form>}
      <div className="tblwrap"><table className="t">
        <thead><tr>{cols.map(([h]) => <th key={h}>{T(h)}</th>)}<th /></tr></thead>
        <tbody>{rows.map(r => <tr key={r.id} className={r.status === 'ACTIVE' ? '' : 'inactive'}>
          {cols.map(([h, f]) => <td key={h}>{f(r)}</td>)}
          <td className="r">{r.status !== 'ACTIVE' ? <span className="pill cancelled">{T('Avsluttet')}</span> : can && <>
            <button className="linkbtn" type="button" onClick={() => setEdit({ ...r })}>{T('Endre')}</button>
            <button className="linkbtn" type="button" onClick={() => act(() => api(`/partners/${p.id}/rows/${kind}/${r.id}/end`, { body: {} }))}>{T('Avslutt')}</button></>}</td>
        </tr>)}
        {!rows.length && <tr><td colSpan={cols.length + 1} className="muted">{T('Ingen registrert.')}</td></tr>}</tbody>
      </table></div>
    </div>
  );
}

/* ------------------------------ links and fullmakt ------------------------------ */
function Links({ p, meta, can, act, nav }: { p: any; meta: Meta; can: boolean; act: (fn: () => Promise<Result>) => Promise<boolean>; nav: (to: string) => void }) {
  const [fm, setFm] = useState<Record<string, any> | null>(null);
  const [rel, setRel] = useState<Record<string, any> | null>(null);
  const link = (pid: string, label: string) => <a href={`/partners/${pid}`} onClick={e => { e.preventDefault(); nav(`/partners/${pid}`); }}>{label}</a>;
  return (
    <div className="cols2">
      <div className="panelbox"><h3>{T('Fullmakt (rubrikk 14)')}</h3>
        {can && !fm && <button className="btn add small" type="button" onClick={() => setFm({ representation: 'DIRECT', scope: 'IMPORT_EXPORT', valid_from: new Date().toISOString().slice(0, 10) })}>{T('+ Registrer fullmakt')}</button>}
        {fm && <form className="subform" onSubmit={async e => { e.preventDefault(); if (await act(() => api(`/partners/${p.id}/fullmakt`, { body: fm }))) setFm(null); }}>
          <Fields idPrefix="fm" value={fm} onChange={setFm} spec={[{ k: 'representative_id', label: 'Representant (f.eks. Odin Customs AS)', t: 'partner', req: true, wide: true },
            { k: 'representation', label: 'Representasjon', t: 'select', req: true, opts: { DIRECT: 'Direkte', INDIRECT: 'Indirekte' } },
            { k: 'scope', label: 'Omfang', t: 'select', req: true, opts: { IMPORT_EXPORT: 'Innførsel og utførsel', IMPORT: 'Innførsel', EXPORT: 'Utførsel' } },
            { k: 'valid_from', label: 'Gyldig fra', t: 'date', req: true }, { k: 'valid_to', label: 'Gyldig til', t: 'date' }, { k: 'document_ref', label: 'Dokumentreferanse' }]} />
          <div className="row"><button className="btn" type="submit">{T('Lagre')}</button><button className="btn grey" type="button" onClick={() => setFm(null)}>{T('Avbryt')}</button></div></form>}
        <div className="tblwrap"><table className="t"><thead><tr><th>{T('Fra')}</th><th>{T('Til')}</th><th>{T('Omfang')}</th><th>{T('Gyldig')}</th><th /></tr></thead>
          <tbody>{p.fullmakt.map((f: any) => <tr key={f.id} className={f.status === 'ACTIVE' ? '' : 'inactive'}>
            <td>{f.partner_id === p.id ? <b>{f.party_name}</b> : link(f.partner_id, f.party_name)}</td><td>{f.representative_id === p.id ? <b>{f.rep_name}</b> : link(f.representative_id, f.rep_name)}</td>
            <td>{T({ IMPORT_EXPORT: 'Innførsel og utførsel', IMPORT: 'Innførsel', EXPORT: 'Utførsel' }[f.scope as string]!)} · {T(f.representation === 'DIRECT' ? 'Direkte' : 'Indirekte')}</td>
            <td>{period(f)}</td><td className="r">{f.status === 'ACTIVE' ? (can && f.partner_id === p.id && <button className="linkbtn" type="button" onClick={() => act(() => api(`/partners/${p.id}/fullmakt/${f.id}/revoke`, { body: {} }))}>{T('Trekk tilbake')}</button>) : <span className="pill cancelled">{T('Trukket tilbake')}</span>}</td></tr>)}
            {!p.fullmakt.length && <tr><td colSpan={5} className="muted">{T('Ingen fullmakt registrert.')}</td></tr>}</tbody></table></div></div>
      <div className="panelbox"><h3>{T('Koblinger')}</h3>
        {can && !rel && <button className="btn add small" type="button" onClick={() => setRel({ relationship_type: 'OTHER' })}>{T('+ Legg til kobling')}</button>}
        {rel && <form className="subform" onSubmit={async e => { e.preventDefault(); if (await act(() => api(`/partners/${p.id}/relationships`, { body: rel }))) setRel(null); }}>
          <Fields idPrefix="rel" value={rel} onChange={setRel} spec={[{ k: 'relationship_type', label: 'Denne partneren er', t: 'select', req: true, opts: meta.relationshipTypes },
            { k: 'target_partner_id', label: 'Partner', t: 'partner', req: true, wide: true }, { k: 'notes', label: 'Merknad', wide: true }]} />
          <div className="row"><button className="btn" type="submit">{T('Lagre')}</button><button className="btn grey" type="button" onClick={() => setRel(null)}>{T('Avbryt')}</button></div></form>}
        <div className="tblwrap"><table className="t"><tbody>{p.relationships.map((r: any) => <tr key={r.id} className={r.status === 'ACTIVE' ? '' : 'inactive'}>
          <td>{r.source_partner_id === p.id ? <b>{r.source_name}</b> : link(r.source_partner_id, r.source_name)}</td><td className="muted">{T(meta.relationshipTypes[r.relationship_type])}</td>
          <td>{r.target_partner_id === p.id ? <b>{r.target_name}</b> : link(r.target_partner_id, r.target_name)}</td><td className="muted">{r.notes}</td>
          <td className="r">{r.status === 'ACTIVE' && can && <button className="linkbtn" type="button" onClick={() => act(() => api(`/partners/${p.id}/relationships/${r.id}/end`, { body: {} }))}>{T('Avslutt')}</button>}</td></tr>)}
          {!p.relationships.length && <tr><td className="muted">{T('Ingen koblinger.')}</td></tr>}</tbody></table></div></div>
    </div>
  );
}

/* ------------------------------ prices and invoicing ------------------------------ */
function Prices({ p, meta, me, can, act }: { p: any; meta: Meta; me: Me; can: boolean; act: (fn: () => Promise<Result>) => Promise<boolean> }) {
  const [np, setNp] = useState<Record<string, any> | null>(null);
  const [inv, setInv] = useState<Record<string, any>>({});
  useEffect(() => setInv(p.invoicing ?? { consolidation: 'PER_DECLARATION', due_days: 14 }), [p]);
  const today = new Date().toISOString().slice(0, 10);
  const nok = (v: unknown) => Number(v).toLocaleString(locale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const unit: Record<string, string> = { PER_DECL: 'per deklarasjon', PER_LINE: 'per varepost', PER_HOUR: 'per time', FIXED: 'fast', PERCENT_DUTY: '% av toll/avgift' };
  const canInv = me.perms.includes('invoice.edit') && !p.merged_into;
  return (
    <div className="cols2">
      <div className="panelbox"><h3>{T('Låste priser for klienten')}</h3>
        <p className="hint" style={{ marginTop: 0 }}>{T('En låst pris endres aldri. En ny pris legges inn fra en senere dato, og den forrige avsluttes dagen før. Tjenester uten egen pris faktureres etter prislisten.')}</p>
        {can && !np && <button className="btn add small" type="button" onClick={() => setNp({ item_code: meta.priceItems[0]?.code, valid_from: today })}>{T('+ Lås ny pris')}</button>}
        {np && <form className="subform" onSubmit={async e => { e.preventDefault(); if (await act(() => api(`/partners/${p.id}/prices`, { body: np }))) setNp(null); }}>
          <Fields idPrefix="pr" value={np} onChange={setNp} spec={[{ k: 'item_code', label: 'Tjeneste', t: 'select', req: true, opts: Object.fromEntries(meta.priceItems.map(i => [i.code, i.name_no])) },
            { k: 'price', label: 'Pris (NOK eks. mva)', t: 'number', req: true }, { k: 'free_lines', label: 'Vareposter inkludert', t: 'number' },
            { k: 'valid_from', label: 'Gjelder fra', t: 'date', req: true }, { k: 'note', label: 'Merknad (f.eks. avtale av …)', wide: true }]} />
          <div className="row"><button className="btn" type="submit">{T('Lås prisen')}</button><button className="btn grey" type="button" onClick={() => setNp(null)}>{T('Avbryt')}</button></div></form>}
        <div className="tblwrap"><table className="t"><thead><tr><th>{T('Tjeneste')}</th><th className="r">{T('Pris')}</th><th>{T('Gjelder')}</th><th>{T('Låst av')}</th></tr></thead>
          <tbody>{p.prices.map((x: any) => { const now = x.valid_from <= today && (!x.valid_to || x.valid_to >= today);
            return <tr key={x.id} className={now || x.valid_from > today ? '' : 'inactive'}>
              <td>{getLang() === 'en' ? x.name_en : x.name_no}{x.note && <div className="hint">{x.note}</div>}</td>
              <td className="r nowrap">{x.unit === 'PERCENT_DUTY' ? `${nok(x.price)} %` : `NOK ${nok(x.price)}`} <span className="muted">{T(unit[x.unit])}</span>{x.free_lines != null && <div className="hint">{x.free_lines} {T('vareposter inkludert')}</div>}</td>
              <td className="nowrap">{d(x.valid_from)} – {d(x.valid_to) || '…'} {now ? <span className="pill accepted">{T('Gjelder nå')}</span> : x.valid_from > today ? <span className="pill info">{T('Fremtidig')}</span> : null}</td>
              <td className="muted">{x.locked_by_name} {fmtDateTime(x.locked_at)}</td></tr>; })}
            {!p.prices.length && <tr><td colSpan={4} className="muted">{T('Ingen egne priser — prislisten gjelder.')}</td></tr>}</tbody></table></div></div>
      <form className="panelbox" onSubmit={e => { e.preventDefault(); act(() => api(`/partners/${p.id}/invoicing`, { method: 'PUT', body: inv })); }}>
        <h3>{T('Fakturering')}</h3>
        <fieldset disabled={!canInv} className="plain"><Fields idPrefix="inv" value={inv} onChange={setInv} spec={[
          { k: 'consolidation', label: 'Faktureres', t: 'select', req: true, opts: { PER_DECLARATION: 'Per deklarasjon', MONTHLY: 'Samlet per måned' } },
          { k: 'due_days', label: 'Betalingsfrist (dager)', t: 'number' }, { k: 'invoice_email', label: 'Faktura sendes til (e-post)', wide: true },
          { k: 'ehf', label: 'Send som EHF (elektronisk faktura)', t: 'check' }, { k: 'notes', label: 'Merknad', t: 'textarea', wide: true }]} /></fieldset>
        {canInv ? <div className="row"><button className="btn" type="submit">{T('Lagre')}</button></div> : <p className="hint">{T('Fakturainnstillinger endres av økonomi eller godkjenner.')}</p>}
      </form>
    </div>
  );
}

/* ------------------------------ Brønnøysund ------------------------------ */
function Registry({ p, can, act }: { p: any; can: boolean; act: (fn: () => Promise<Result>) => Promise<boolean> }) {
  const [diff, setDiff] = useState<any>(null);
  const r = p.registry, u = r?.data;
  const refresh = () => act(async () => { const x = await api(`/partners/${p.id}/brreg/refresh`, { body: {} }); setDiff(x.diff); return x; });
  return (
    <div className="panelbox">
      <div className="row" style={{ marginTop: 0 }}>{can && p.orgNo && <button className="btn" type="button" onClick={refresh}>{T('Hent på nytt fra Brønnøysund')}</button>}
        {!p.orgNo && <span className="muted">{T('Legg inn organisasjonsnummer under Identifikatorer for å koble partneren til Enhetsregisteret.')}</span>}</div>
      {diff && (diff.name || diff.address) && <div className="warnmsg">
        {diff.name && <div>{T('Navn i Brønnøysund')}: <b>{diff.name.registry}</b> ({T('kortet')}: {diff.name.card})</div>}
        {diff.address && <div>{T('Forretningsadresse i Brønnøysund')}: <b>{diff.address.registry}</b> ({T('kortet')}: {diff.address.card || '—'})</div>}
        <div className="row"><button className="btn small" type="button" onClick={() => act(() => api(`/partners/${p.id}/brreg/apply`, { body: { name: !!diff.name, address: !!diff.address } })).then(() => setDiff(null))}>{T('Bruk Brønnøysunds opplysninger')}</button></div></div>}
      {diff && !diff.name && !diff.address && <div className="okmsg">{T('Kortet stemmer med Brønnøysund.')}</div>}
      {u ? <dl className="kv">
        <dt>{T('Navn')}</dt><dd>{u.name}</dd><dt>{T('Organisasjonsform')}</dt><dd>{u.orgForm?.text}</dd>
        <dt>{T('MVA-registrert')}</dt><dd>{u.vatRegistered ? T('Ja') : <b className="bad">{T('Nei')}</b>}</dd>
        <dt>{T('Status')}</dt><dd>{[u.bankrupt && 'konkurs', u.windingUp && 'under avvikling', u.forcedDissolution && 'under tvangsavvikling', u.deleted && 'slettet'].filter(Boolean).map((x: string) => T(x)).join(', ') || T('Aktiv')}</dd>
        <dt>{T('Næring')}</dt><dd>{u.industry?.text}</dd><dt>{T('Ansatte')}</dt><dd>{u.employees ?? '—'}</dd>
        <dt>{T('Daglig leder')}</dt><dd>{(r.roles?.dailyManager ?? []).join(', ') || '—'}</dd><dt>{T('Styreleder')}</dt><dd>{(r.roles?.chair ?? []).join(', ') || '—'}</dd>
        <dt>{T('Hentet')}</dt><dd>{fmtDateTime(r.fetched_at)}{r.fetch_error && <span className="bad"> · {r.fetch_error}</span>}</dd>
        <dt>{T('Lenke')}</dt><dd><a href={u.link} target="_blank" rel="noopener noreferrer">{u.link}</a></dd></dl>
        : <p className="muted">{T('Ikke hentet fra Brønnøysund ennå.')}</p>}
    </div>
  );
}

const ACTION: Record<string, string> = {
  PARTNER_CREATED: 'Partner opprettet', PARTNER_CHANGED: 'Generelt endret', PARTNER_ROW_ADDED: 'Rad lagt til', PARTNER_ROW_CHANGED: 'Rad endret',
  PARTNER_ROW_ENDED: 'Rad avsluttet', PARTNER_LINK_ADDED: 'Kobling lagt til', PARTNER_LINK_ENDED: 'Kobling avsluttet', FULLMAKT_ADDED: 'Fullmakt registrert',
  FULLMAKT_REVOKED: 'Fullmakt trukket tilbake', PRICE_LOCKED: 'Pris låst', INVOICING_CHANGED: 'Fakturering endret', BRREG_CHECKED: 'Hentet fra Brønnøysund',
  BRREG_APPLIED: 'Brønnøysunds opplysninger brukt', EORI_CHECKED: 'EORI kontrollert', PARTNER_MERGED: 'Slått sammen', PARTNER_DEACTIVATED: 'Gjort inaktiv',
  PARTNER_REACTIVATED: 'Aktivert igjen'
};
const KIND: Record<string, string> = { addresses: 'adresse', identifiers: 'identifikator', roles: 'rolle', contacts: 'kontakt', credit: 'tollkreditt' };

function PartnerAudit({ id }: { id: string }) {
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => { api(`/admin/audit?objectType=PARTNER&objectId=${id}&limit=200`).then(setRows).catch(() => setRows([])); }, [id]);
  const show = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  return (
    <div className="tblwrap"><table className="t"><thead><tr><th>{T('Tidspunkt')}</th><th>{T('Bruker')}</th><th>{T('Hendelse')}</th><th>{T('Endringer')}</th></tr></thead>
      <tbody>{rows.map(r => <tr key={r.id}><td className="nowrap">{fmtDateTime(r.at)}</td><td>{r.user_name || '—'}</td><td>{T(ACTION[r.action] ?? r.action)}{r.detail?.kind ? ` · ${T(KIND[r.detail.kind] ?? r.detail.kind)}` : ''}</td>
        <td>{r.changes ? Object.entries(r.changes as Record<string, [unknown, unknown]>).map(([k, [a, b]]) => <div key={k}><b>{k}</b>: {show(a)} → {show(b)}</div>) : r.detail ? <span className="muted">{show(r.detail)}</span> : ''}</td></tr>)}
        {!rows.length && <tr><td colSpan={4} className="muted">{T('Ingen endringer, eller du mangler tilgang til endringsloggen.')}</td></tr>}</tbody></table></div>
  );
}
