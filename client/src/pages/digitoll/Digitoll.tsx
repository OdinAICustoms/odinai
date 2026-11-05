import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, type Me } from '../../api';
import { T, fmtDateTime } from '../../i18n';
import { Findings, useCountries } from '../../components/Form';

/** Digitoll (phase 3b): road transport, master and house consignments, on Tolletaten's simulator. */
const KIND_PATH: Record<string, string> = { TRANSPORT: 'transports', MASTER: 'masters', HOUSE: 'houses' };
const KIND_LABEL: Record<string, string> = { TRANSPORT: 'Transport', MASTER: 'Hovedforsendelse', HOUSE: 'Forsendelse' };
const STATUS: Record<string, [string, string]> = { DRAFT: ['Utkast', 'info'], ACCEPTED: ['Akseptert', 'accepted'], INCOMPLETE: ['Ufullstendig', 'submitted'],
  REJECTED: ['Avvist', 'rejected'], CANCELLED: ['Kansellert', 'cancelled'] };
const pill = (s: string) => <span className={`pill ${STATUS[s]?.[1] ?? ''}`}>{T(STATUS[s]?.[0] ?? s)}</span>;

/* ------------------------------ JSON paths ------------------------------ */
const getIn = (o: any, p: string) => p.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
function setIn(o: any, p: string, v: any): any {
  const [k, ...rest] = p.split('.');
  const key: string | number = /^\d+$/.test(k) ? Number(k) : k;
  const base = Array.isArray(o) ? [...o] : { ...(o ?? {}) };
  (base as any)[key] = rest.length ? setIn((o ?? {})[key] ?? (/^\d+$/.test(rest[0]) ? [] : {}), rest.join('.'), v) : v;
  return base;
}
const toLocal = (iso: string) => { if (!iso) return ''; const d = new Date(iso); if (Number.isNaN(d.getTime())) return ''; const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000); return z.toISOString().slice(0, 16); };
const fromLocal = (v: string) => (v ? new Date(v).toISOString().replace(/\.\d+Z$/, 'Z') : '');

type F = { p: string; label: string; t?: 'text' | 'number' | 'country' | 'datetime' | 'check' | 'select'; opts?: Record<string, string>; wide?: boolean };
const partyFields = (base: string, label: string): F[] => [
  { p: `${base}.name`, label: `${label}: navn` }, { p: `${base}.identificationNumber`, label: `${label}: EORI / org.nr.` },
  { p: `${base}.address.streetLine`, label: `${label}: gateadresse` }, { p: `${base}.address.postcode`, label: `${label}: postnummer` },
  { p: `${base}.address.city`, label: `${label}: sted` }, { p: `${base}.address.country`, label: `${label}: land`, t: 'country' }];
function fieldsFor(kind: string, codes: any): F[] {
  if (kind === 'TRANSPORT') return [
    { p: 'activeBorderTransportMeans.identificationNumber', label: 'Registreringsnummer (trekkvogn)' }, { p: 'activeBorderTransportMeans.countryCode', label: 'Kjøretøyets nasjonalitet', t: 'country' },
    { p: 'activeBorderTransportMeans.operator.name', label: 'Sjåfør' }, { p: 'activeBorderTransportMeans.operator.communication.0.identifier', label: 'Sjåførens telefon' },
    { p: 'carrier.name', label: 'Transportør' }, { p: 'carrier.identificationNumber', label: 'Transportørens EORI / org.nr.' },
    { p: 'carrier.address.city', label: 'Transportørens sted' }, { p: 'carrier.address.country', label: 'Transportørens land', t: 'country' },
    { p: 'customsOfficeOfFirstEntry.referenceNumber', label: 'Tollsted ved ankomst (f.eks. NO377001)' },
    { p: 'scheduledDateAndTimeOfArrival', label: 'Planlagt ankomst', t: 'datetime' }, { p: 'estimatedDateAndTimeOfArrival', label: 'Forventet ankomst', t: 'datetime' }];
  if (kind === 'MASTER') return [
    { p: 'consignmentMasterLevel.transportDocumentMasterLevel.documentNumber', label: 'Transportdokumentnummer' },
    { p: 'consignmentMasterLevel.transportDocumentMasterLevel.type', label: 'Dokumenttype (N730 = CMR)' },
    { p: 'consignmentMasterLevel.grossMass', label: 'Bruttovekt (kg)', t: 'number' }, { p: 'consignmentMasterLevel.containerIndicator', label: 'Container', t: 'check' },
    ...partyFields('consignmentMasterLevel.consignor', 'Avsender'), ...partyFields('consignmentMasterLevel.consignee', 'Mottaker')];
  return [
    { p: 'consignmentHouseLevel.transportDocumentHouseLevel.documentNumber', label: 'Transportdokumentnummer' },
    { p: 'consignmentHouseLevel.transportDocumentHouseLevel.type', label: 'Dokumenttype (N730 = CMR)' },
    { p: 'consignmentHouseLevel.goodsDescription', label: 'Varebeskrivelse', wide: true },
    { p: 'consignmentHouseLevel.numberOfPackages', label: 'Antall kolli', t: 'number' }, { p: 'consignmentHouseLevel.totalGrossMass', label: 'Bruttovekt (kg)', t: 'number' },
    { p: 'consignmentHouseLevel.containerIndicator', label: 'Container', t: 'check' },
    { p: 'consignmentHouseLevel.importProcedure.importProcedure', label: 'Tollprosedyre', t: 'select', opts: codes?.importProcedures ?? {} },
    { p: 'consignmentHouseLevel.importProcedure.outgoingProcedure', label: 'Prosedyre fram til grensen', t: 'select', opts: codes?.outgoingProcedures ?? {} },
    { p: 'consignmentHouseLevel.importProcedure.hasOutgoingProcedure', label: 'Har prosedyre fram til grensen', t: 'check' },
    ...partyFields('consignmentHouseLevel.consignor', 'Avsender'), ...partyFields('consignmentHouseLevel.consignee', 'Mottaker')];
}

/* ------------------------------ overview ------------------------------ */
export function DigitollOverview({ me }: { me: Me }) {
  const nav = useNavigate();
  const [o, setO] = useState<any>(null), [tab, setTab] = useState('attention'), [err, setErr] = useState('');
  useEffect(() => { api('/digitoll').then(setO).catch(e => setErr(e.message)); }, []);
  const can = me.perms.includes('declaration.edit');
  const create = async (kind: string) => { try { const r = await api(`/digitoll/${KIND_PATH[kind]}`, { body: {} }); nav(`/digitoll/${KIND_PATH[kind]}/${r.id}`); } catch (x) { setErr((x as Error).message); } };
  if (!o) return err ? <div className="err">{T(err)}</div> : <p className="muted">{T('Laster …')}</p>;
  const lists: Record<string, any[]> = { houses: o.houses, masters: o.masters, transports: o.transports };
  const TABS: [string, string, number][] = [['attention', 'Krever handling', o.attention.length], ['houses', 'Forsendelser', o.houses.length], ['masters', 'Hovedforsendelser', o.masters.length], ['transports', 'Transporter', o.transports.length]];
  return (
    <section>
      <div className="pagehead"><h2>Digitoll</h2><span className="chip">{T('Vei · simulator')}</span><span className="spacer" />
        {can && <><button className="btn add" type="button" onClick={() => create('HOUSE')}>{T('+ Forsendelse')}</button>
          <button className="btn grey" type="button" onClick={() => create('MASTER')}>{T('+ Hovedforsendelse')}</button>
          <button className="btn grey" type="button" onClick={() => create('TRANSPORT')}>{T('+ Transport')}</button></>}</div>
      <p className="hint" style={{ marginTop: 0 }}>{T('Forhåndsvarsel til Tolletaten for varer som kommer på vei: transporten (kjøretøyet), hovedforsendelsen (fraktbrevet) og forsendelsen (varene per klient). En forsendelse lages raskest fra en innførselsdeklarasjon. Alt går til simulatoren — ingenting sendes til Tolletaten.')}</p>
      {err && <div className="err">{T(err)}</div>}
      <div className="tabs" role="tablist">{TABS.map(([k, l, n]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{T(l)}<span className="c">{n}</span></button>)}</div>
      {tab === 'attention' ? <div className="tblwrap"><table className="t">
        <thead><tr><th>{T('Type')}</th><th>{T('Referanse')}</th><th>{T('Hva må gjøres')}</th></tr></thead>
        <tbody>{o.attention.map((a: any, i: number) => <tr key={i} className="click" onClick={() => nav(`/digitoll/${KIND_PATH[a.kind]}/${a.id}`)}>
          <td>{T(KIND_LABEL[a.kind])}</td><td className="mono">{a.label ?? '—'}</td><td>{T(a.reason)}</td></tr>)}
          {!o.attention.length && <tr><td colSpan={3} className="muted">{T('Ingenting krever handling.')}</td></tr>}</tbody></table></div>
        : <div className="tblwrap"><table className="t">
          <thead><tr><th>{T(tab === 'transports' ? 'Registreringsnummer' : 'Transportdokument')}</th><th>{T('Status')}</th><th>MRN</th>
            {tab === 'houses' && <><th>{T('Deklarasjon')}</th><th>{T('Klient')}</th></>}{tab === 'transports' && <th>{T('Planlagt ankomst')}</th>}<th>{T('Sist endret')}</th></tr></thead>
          <tbody>{lists[tab].map((r: any) => <tr key={r.id} className="click" onClick={() => nav(`/digitoll/${tab}/${r.id}`)}>
            <td className="mono">{r.label ?? <span className="muted">—</span>}</td><td>{pill(r.status)}{r.pending_change && <span className="pill submitted" style={{ marginLeft: 4 }}>{T('Endret')}</span>}</td>
            <td className="mono">{r.mrn ?? ''}</td>{tab === 'houses' && <><td className="mono">{r.decl_no ?? ''}</td><td>{r.client_name ?? ''}</td></>}
            {tab === 'transports' && <td className="nowrap">{fmtDateTime(r.scheduled_arrival)}</td>}<td className="muted nowrap">{fmtDateTime(r.updated_at)}</td></tr>)}
            {!lists[tab].length && <tr><td colSpan={6} className="muted">{T('Ingen ennå.')}</td></tr>}</tbody></table></div>}
    </section>
  );
}

/* ------------------------------ one message ------------------------------ */
export function DigitollCard({ me }: { me: Me }) {
  const { kind: path, id } = useParams();
  const nav = useNavigate();
  const countries = useCountries();
  const [r, setR] = useState<any>(null), [data, setData] = useState<any>(null), [links, setLinks] = useState<any>({}), [codes, setCodes] = useState<any>(null);
  const [err, setErr] = useState(''), [ok, setOk] = useState(''), [reason, setReason] = useState(''), [json, setJson] = useState<string | null>(null), [others, setOthers] = useState<any>(null);
  const take = (x: any) => { setR(x); setData(x.data); setLinks({ master_id: x.master_id ?? '', transport_id: x.transport_id ?? '' }); setJson(null); };
  const load = () => api(`/digitoll/${path}/${id}`).then(take).catch(e => setErr(e.message));
  useEffect(() => { load(); api('/digitoll').then(o => { setCodes(o.codes); setOthers(o); }).catch(() => {}); }, [path, id]);
  if (!r || !data) return err ? <div className="err">{T(err)}</div> : <p className="muted">{T('Laster …')}</p>;
  const can = me.perms.includes('declaration.edit') && r.status !== 'CANCELLED';
  const dirty = JSON.stringify(data) !== JSON.stringify(r.data) || (links.master_id || null) !== (r.master_id ?? null) || (links.transport_id || null) !== (r.transport_id ?? null);
  const act = async (fn: () => Promise<any>, msg: string) => { setErr(''); setOk(''); try { take(await fn()); setOk(msg); } catch (x) { setErr((x as Error).message); if ((x as any).code === 'VERSION') load(); } };
  const save = () => act(() => api(`/digitoll/${path}/${id}`, { method: 'PUT', body: { data, version: r.version, ...(r.kind === 'MASTER' ? { transport_id: links.transport_id || null } : {}),
    ...(r.kind === 'HOUSE' ? { master_id: links.master_id || null, transport_id: links.transport_id || null } : {}) } }), T('Lagret.'));
  const issuesFor = (p: string) => r.check.issues.filter((i: any) => i.path === p || i.path.startsWith(p + '.'));
  const docs: any[] = data.consignmentHouseLevel?.previousDocuments ?? [];
  const setDocs = (list: any[]) => setData(setIn(data, 'consignmentHouseLevel.previousDocuments', list));
  const lockedNow = (p: string) => r.locked?.includes(p);
  const opts = (list: any[], label: (x: any) => string) => list.filter((x: any) => x.status !== 'CANCELLED').map((x: any) => <option key={x.id} value={x.id}>{label(x)}</option>);
  return (
    <section>
      <div className="cardhead">
        <div><div className="muted">Digitoll · {T('vei')} · {T('opprettet')} {fmtDateTime(r.created_at)}</div>
          <h2>{T(KIND_LABEL[r.kind])} <span className="mono">{r.kind === 'TRANSPORT' ? r.means_id ?? '' : r.doc_number ?? ''}</span></h2></div>
        <div className="pills">{pill(r.status)}{r.mrn && <span className="chip mono">MRN {r.mrn}</span>}{r.pending_change && <span className="pill submitted">{T('Endret etter innsending')}</span>}
          {r.variant && <span className="chip">{T('Variant')} {r.variant}</span>}</div>
        <span className="spacer" /><button className="btn grey" type="button" onClick={() => nav('/digitoll')}>← Digitoll</button>
      </div>
      {r.status === 'CANCELLED' && <div className="warnmsg">{T('Kansellert')}: {r.cancel_reason}</div>}
      {can && <div className={`wfbar ${r.status === 'REJECTED' ? 'bad' : r.status === 'INCOMPLETE' || r.pending_change ? 'warn' : r.status === 'ACCEPTED' ? 'ok' : ''}`}>
        <div className="wftext">{dirty ? T('Ulagrede endringer — lagre før du sender.') : r.mrn && !r.pending_change && r.status !== 'REJECTED' ? T('Sendt. Endre et felt og lagre for å sende en endring med samme MRN.')
          : r.check.ok ? T(r.mrn ? 'Klar til å sende endringen.' : 'Klar til å sendes til Tolletaten (simulator).') : `${r.check.issues.filter((i: any) => i.lvl === 'err').length} ${T('feil — Tolletaten vil avvise meldingen.')}`}</div>
        {dirty && <button className="btn" type="button" onClick={save}>{T('Lagre')}</button>}
        {!dirty && (!r.mrn || r.pending_change || r.status === 'REJECTED') && <button className="btn add" type="button" onClick={() => act(() => api(`/digitoll/${path}/${id}/send`, { body: {} }), T('Sendt.'))}>{T(r.mrn ? 'Send endring' : 'Send')}</button>}
        {r.kind === 'TRANSPORT' && r.mrn && !r.arrival_registered_at && <button className="btn grey" type="button" onClick={() => act(() => api(`/digitoll/transports/${id}/arrival`, { body: {} }), T('Ankomst registrert.'))}>{T('Ankomst registrert')}</button>}
      </div>}
      <Findings error={err} />{ok && <div className="okmsg">{ok}</div>}
      <div className="declgrid">
        <div>
          <div className="panelbox"><h3>{T('Opplysninger')}</h3>
            <div className="formgrid">{fieldsFor(r.kind, codes).map(f => {
              const v = getIn(data, f.p), is = issuesFor(f.p), dis = !can || lockedNow(f.p), idf = `dt-${f.p}`;
              const set = (x: any) => setData(setIn(data, f.p, x));
              if (f.t === 'check') return <label key={f.p} className="chk fcheck"><input id={idf} type="checkbox" disabled={dis} checked={f.p.endsWith('containerIndicator') ? Number(v) === 1 : !!v}
                onChange={e => set(f.p.endsWith('containerIndicator') ? (e.target.checked ? 1 : 0) : e.target.checked)} /> {T(f.label)}</label>;
              return <div key={f.p} className={`${f.wide ? 'fwide' : ''} ${is.some((i: any) => i.lvl === 'err') ? 'haserr' : is.length ? 'haswarn' : ''}`}>
                <label htmlFor={idf}>{T(f.label)}{lockedNow(f.p) ? ' 🔒' : ''}</label>
                {f.t === 'country' ? <select id={idf} value={v ?? ''} disabled={dis} onChange={e => set(e.target.value)}><option value="">—</option>{countries.map(c => <option key={c.code} value={c.code}>{c.code} – {c.name}</option>)}</select>
                  : f.t === 'select' ? <select id={idf} value={v ?? ''} disabled={dis} onChange={e => set(e.target.value || undefined)}><option value="">—</option>{Object.entries(f.opts ?? {}).map(([k, l]) => <option key={k} value={k}>{k} – {T(String(l))}</option>)}</select>
                  : f.t === 'datetime' ? <input id={idf} type="datetime-local" value={toLocal(v ?? '')} disabled={dis} onChange={e => set(fromLocal(e.target.value))} />
                  : <input id={idf} value={v ?? ''} inputMode={f.t === 'number' ? 'decimal' : undefined} disabled={dis} onChange={e => set(f.t === 'number' ? (e.target.value === '' ? null : Number(e.target.value.replace(',', '.'))) : e.target.value)} />}
                {is.map((i: any, n: number) => <p key={n} className={`fmsg ${i.lvl === 'err' ? 'err' : 'warn'}`}>{T(i.msg)}</p>)}
              </div>;
            })}</div>
            {r.locked?.length > 0 && <p className="hint">🔒 {T('Feltene kan ikke endres etter at MRN er gitt (Tolletatens regel).')}</p>}
          </div>

          {r.kind === 'HOUSE' && <div className="panelbox"><h3>{T('Dokumentreferanser')}</h3>
            <div className="docrows">{docs.map((d0, i) => <div key={i} className="docrow">
              <select aria-label={T('Type')} value={d0.typeOfReference ?? ''} disabled={!can} onChange={e => setDocs(docs.map((x, n) => (n === i ? { typeOfReference: e.target.value } : x)))}>
                {['CUDE', 'N820', 'RETR', 'GONU', 'ATA', 'TIR'].map(t => <option key={t} value={t}>{t}{t === 'CUDE' ? ` – ${T('tolldeklarasjon')}` : t === 'N820' ? ` – ${T('transitt')}` : ''}</option>)}</select>
              {d0.typeOfReference === 'CUDE' ? <span className="mono">{d0.declarantNumber ?? ''}-{d0.declarationDate ?? ''}-{d0.sequenceNumber ?? ''}</span>
                : <input aria-label={T('Referanse')} placeholder={T('Referanse')} value={d0.referenceNumber ?? ''} disabled={!can} onChange={e => setDocs(docs.map((x, n) => (n === i ? { ...x, referenceNumber: e.target.value } : x)))} />}
              <span />{can && <button type="button" className="linkbtn" onClick={() => setDocs(docs.filter((_, n) => n !== i))}>{T('Fjern')}</button>}
            </div>)}
              {can && <button type="button" className="btn ghost small" onClick={() => setDocs([...docs, { typeOfReference: 'N820', referenceNumber: '' }])}>{T('+ Legg til referanse')}</button>}
            </div>
            <p className="hint">{T('Tolldeklarasjonen (CUDE) legges til av seg selv når den koblede innførselsdeklarasjonen er sendt til TVINN.')}</p>
          </div>}

          {r.kind !== 'TRANSPORT' && <div className="panelbox"><h3>{T('Koblinger')}</h3><div className="formgrid">
            {r.kind === 'HOUSE' && <div><label htmlFor="dt-master">{T('Hovedforsendelse')}</label>
              <select id="dt-master" value={links.master_id} disabled={!can} onChange={e => setLinks({ master_id: e.target.value, transport_id: e.target.value ? '' : links.transport_id })}>
                <option value="">—</option>{opts(others?.masters ?? [], (x: any) => `${x.label ?? T('uten nummer')} (${T(STATUS[x.status]?.[0] ?? x.status)})`)}</select></div>}
            <div><label htmlFor="dt-transport">{T(r.kind === 'HOUSE' ? 'Eller direkte til transport' : 'Transport')}</label>
              <select id="dt-transport" value={links.transport_id} disabled={!can || (r.kind === 'HOUSE' && !!links.master_id)} onChange={e => setLinks({ ...links, transport_id: e.target.value })}>
                <option value="">—</option>{opts(others?.transports ?? [], (x: any) => `${x.label ?? T('uten nummer')} (${T(STATUS[x.status]?.[0] ?? x.status)})`)}</select></div>
          </div>
            {r.links?.declaration && <p className="hint">{T('Deklarasjon')}: <a href={`/declarations/${r.links.declaration.id}`} onClick={e => { e.preventDefault(); nav(`/declarations/${r.links.declaration.id}`); }}>{r.links.declaration.decl_no}</a>
              {r.links.client ? ` · ${r.links.client.legal_name}` : ''}</p>}</div>}
          {r.kind !== 'HOUSE' && (r.links?.houses?.length || r.links?.masters?.length) ? <div className="panelbox"><h3>{T('Koblet til denne')}</h3><ul className="comments">
            {[...(r.links.masters ?? []).map((x: any) => ['masters', x]), ...(r.links.houses ?? []).map((x: any) => ['houses', x])].map(([p, x]: any) => <li key={x.id}>
              <a href={`/digitoll/${p}/${x.id}`} onClick={e => { e.preventDefault(); nav(`/digitoll/${p}/${x.id}`); }}>{T(p === 'masters' ? 'Hovedforsendelse' : 'Forsendelse')} {x.doc_number ?? ''}</a> {pill(x.status)}</li>)}</ul></div> : null}

          <div className="panelbox"><h3>{T('Meldingen i Tolletatens format')}</h3>
            {json === null ? <button type="button" className="linkbtn" onClick={() => setJson(JSON.stringify(data, null, 2))}>{T('Vis / rediger JSON')}</button>
              : <><textarea value={json} rows={16} disabled={!can} onChange={e => setJson(e.target.value)} style={{ fontFamily: 'var(--mono)', fontSize: 12 }} />
                <div className="row">{can && <button type="button" className="btn ghost small" onClick={() => { try { setData(JSON.parse(json)); setJson(null); } catch { setErr(T('Ugyldig JSON.')); } }}>{T('Bruk JSON')}</button>}
                  <button type="button" className="btn grey small" onClick={() => setJson(null)}>{T('Lukk')}</button></div></>}
          </div>
          {can && <div className="panelbox"><h3>{T('Kanseller')}</h3><div className="row" style={{ marginTop: 0 }}>
            <input aria-label={T('Årsak')} placeholder={T('Årsak (påkrevd)')} value={reason} onChange={e => setReason(e.target.value)} style={{ flex: 1, minWidth: 220 }} />
            <button className="btn danger" type="button" disabled={!reason.trim()} onClick={() => act(() => api(`/digitoll/${path}/${id}/cancel`, { body: { reason } }), T('Kansellert.'))}>{T('Kanseller')}</button></div></div>}
        </div>
        <aside className="checkpanel">
          <div className="panelbox"><h3>{T('Kontroll')}</h3>
            {dirty && <p className="hint" style={{ marginTop: 0 }}>{T('Kontrollen gjelder det som er lagret.')}</p>}
            {r.check.ok && !r.check.issues.length ? <div className="okmsg">{T('Ingen feil.')}</div> : <ul className="issues">{r.check.issues.map((i: any, n: number) =>
              <li key={n} className={i.lvl === 'err' ? 'err' : 'warn'}>{i.lvl === 'incomplete' ? `${T('Ufullstendig')}: ` : ''}{T(i.msg)}</li>)}</ul>}
          </div>
          {r.answer && <div className="panelbox"><h3>{T('Siste svar')}</h3>
            <p className="hint" style={{ marginTop: 0 }}>{pill(r.answer.status)} {r.answer.simulator ? T('simulator') : ''} · {fmtDateTime(r.sent_at)}</p>
            {r.answer.errors?.length > 0 && <ul className="issues">{r.answer.errors.map((e: any, n: number) => <li key={n} className="err">{T(e.msg)}</li>)}</ul>}
            {r.answer.incompleteDocumentationReasons?.length > 0 && <p className="hint">{r.answer.incompleteDocumentationReasons.join(', ')}</p>}
          </div>}
          <div className="panelbox"><h3>{T('Meldingslogg')}</h3><ul className="comments">{r.messages.map((m: any) => <li key={m.id}>
            <b>{m.direction === 'OUT' ? '→' : '←'} {m.operation}</b> <span className="muted">{fmtDateTime(m.created_at)}{m.user_name ? ` · ${m.user_name}` : ''}</span>{m.mrn && <div className="mono muted">{m.mrn}</div>}</li>)}
            {!r.messages.length && <li className="muted">{T('Ikke sendt ennå.')}</li>}</ul></div>
        </aside>
      </div>
    </section>
  );
}
