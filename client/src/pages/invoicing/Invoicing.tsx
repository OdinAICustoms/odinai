import { Fragment, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, type Me } from '../../api';
import { T, fmtDateTime, locale } from '../../i18n';
import { PartnerPicker } from '../../components/Form';

/** Invoicing (phase 4a): the basis, drafts, issuing with number and KID, credit notes, the PDF and the settings. */
const STATUS: Record<string, [string, string]> = { DRAFT: ['Utkast', 'info'], OPEN: ['Åpen', 'submitted'], OVERDUE: ['Forfalt', 'rejected'], PAID: ['Betalt', 'accepted'],
  CREDITED: ['Kreditert', 'cancelled'], DISCARDED: ['Forkastet', 'cancelled'], ISSUED: ['Utstedt', 'info'] };
const pill = (i: any) => i.kind === 'CREDIT' && i.status !== 'DRAFT' ? <span className="pill info">{T('Kreditnota')}</span>
  : <span className={`pill ${STATUS[i.display]?.[1] ?? ''}`}>{T(STATUS[i.display]?.[0] ?? i.display)}</span>;
const money = (n: unknown) => Number(n ?? 0).toLocaleString(locale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = (d?: string | null) => (d && /^\d{4}-\d{2}-\d{2}/.test(d) ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : '');
const PAYER: Record<string, string> = { ODIN: 'Odin betalte', CLIENT: 'Klienten betalte', UNKNOWN: 'Ukjent betaler', NONE: 'Ingen toll' };
const VAT: Record<string, string> = { HIGH: '25 %', ZERO: '0 % (fritatt)', EXEMPT: 'Utenfor mva', OUTLAY: 'Utlegg' };
const UNIT: Record<string, string> = { PER_DECL: 'per deklarasjon', PER_LINE: 'per varepost', PER_HOUR: 'per time', FIXED: 'fast', PERCENT_DUTY: '% av toll og avgifter' };
const CONS: Record<string, string> = { PER_DECLARATION: 'Per deklarasjon', MONTHLY: 'Månedlig' };
const JOB_KIND: Record<string, string> = { SALE: 'Salg', PAYMENT: 'Innbetaling', PAYMENT_REVERSAL: 'Reversering', SETTLE: 'Oppgjort' };
const JOB: Record<string, [string, string]> = { QUEUED: ['Venter', 'submitted'], SENDING: ['Sender', 'submitted'], DONE: ['Sendt', 'accepted'], FAILED: ['Feilet', 'rejected'], CANCELLED: ['Avbrutt', 'cancelled'] };
const jobPill = (s: string) => <span className={`pill ${JOB[s]?.[1] ?? ''}`}>{T(JOB[s]?.[0] ?? s)}</span>;
const METHOD: Record<string, string> = { BANK: 'Bank', CASH: 'Kontant', OTHER: 'Annet' };
const osloToday = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Oslo' });
const go = (nav: (p: string) => void, p: string) => (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); nav(p); };

function Gaps({ gaps, nav }: { gaps: string[]; nav: (p: string) => void }) {
  if (!gaps?.length) return null;
  return <div className="warnmsg">{T('Firmaopplysninger mangler før fakturaer kan utstedes')}: {gaps.map(g => T(g)).join(', ')}. <a href="/invoice-settings" onClick={go(nav, '/invoice-settings')}>{T('Fakturering › Innstillinger')}</a></div>;
}

/* ------------------------------ the basis ------------------------------ */
export function InvoicingBasis({ me }: { me: Me }) {
  const nav = useNavigate();
  const [b, setB] = useState<any>(null), [upTo, setUpTo] = useState(''), [sel, setSel] = useState<Set<string>>(new Set()), [open, setOpen] = useState<string | null>(null);
  const [err, setErr] = useState(''), [ok, setOk] = useState(''), [busy, setBusy] = useState(false);
  const load = (u = upTo) => api(`/invoicing/basis${u ? `?upTo=${u}` : ''}`).then(x => { setB(x); setUpTo(x.upTo); }).catch(e => setErr(e.message));
  useEffect(() => { load(''); }, []);
  const can = me.perms.includes('invoice.edit');
  const toggle = (id: string) => setSel(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const run = async () => {
    setErr(''); setOk(''); setBusy(true);
    try { const r = await api('/invoicing/run', { body: { upTo } }); setOk(`${r.created.length} ${T('utkast laget.')}`); setSel(new Set()); await load(); } catch (x) { setErr((x as Error).message); }
    setBusy(false);
  };
  const draft = async (clientId: string, ids: string[]) => {
    setErr('');
    try { const r = await api('/invoices', { body: { clientId, declarationIds: ids } }); nav(`/invoices/${r.id}`); } catch (x) { setErr((x as Error).message); }
  };
  if (!b) return err ? <div className="err">{T(err)}</div> : <p className="muted">{T('Laster …')}</p>;
  const dueCount = b.clients.reduce((s: number, c: any) => s + c.declarations.filter((d: any) => d.due).length, 0);
  return (
    <section>
      <div className="pagehead"><h2>{T('Til fakturering')}</h2><span className="spacer" />
        <label className="muted" htmlFor="upto">{T('Månedsfakturaer til og med')}</label>
        <input id="upto" type="date" value={upTo} onChange={e => { setUpTo(e.target.value); load(e.target.value); }} style={{ width: 150 }} />
        {can && <button className="btn add" type="button" disabled={busy || !dueCount} onClick={run}>{T('Lag utkast for alt som er klart')} ({dueCount})</button>}</div>
      <p className="hint" style={{ marginTop: 0 }}>{T('Deklarasjoner som er godtatt av Tolletaten og ikke fakturert. Prisene hentes fra partnerkortet (avtalt pris) eller prislisten. Toll og avgifter tas med som utlegg bare når Odin betalte dem (rubrikk 48). Ingenting utstedes eller sendes av seg selv.')}</p>
      <Gaps gaps={b.gaps} nav={nav} />
      {err && <div className="err">{T(err)}</div>}{ok && <div className="okmsg">{ok} <a href="/invoices" onClick={go(nav, '/invoices?status=DRAFT')}>{T('Se utkastene')}</a></div>}
      {!b.clients.length && <div className="panelbox"><p className="muted" style={{ margin: 0 }}>{T('Ingenting å fakturere.')}</p></div>}
      {b.clients.map((c: any) => {
        const mine = c.declarations.filter((d: any) => sel.has(d.id)).map((d: any) => d.id);
        return <div key={c.client.id} className="panelbox">
          <div className="pagehead" style={{ marginBottom: 6 }}>
            <h3 style={{ margin: 0 }}><a href={`/partners/${c.client.id}`} onClick={go(nav, `/partners/${c.client.id}`)}>{c.client.legal_name}</a> <span className="muted">{c.client.partner_no}</span></h3>
            <span className="chip">{T(CONS[c.consolidation] ?? c.consolidation)}</span>{c.vatRegistered === false && <span className="chip">{T('Ikke mva-registrert')}</span>}
            <span className="spacer" /><b>{money(c.total)} kr</b>
            {can && <button className="btn grey small" type="button" disabled={!mine.length} onClick={() => draft(c.client.id, mine)}>{T('Lag utkast av valgte')} ({mine.length})</button>}</div>
          <div className="tblwrap"><table className="t">
            <thead><tr>{can && <th />}<th>{T('Deklarasjon')}</th><th>{T('Dato')}</th><th>{T('Toll betalt av')}</th><th>{T('Linjer')}</th><th className="num">{T('Beløp')}</th><th /></tr></thead>
            <tbody>{c.declarations.map((d: any) => <Fragment key={d.id}>
              <tr className={d.due ? '' : 'inactive'}>
                {can && <td><input type="checkbox" aria-label={d.decl_no} checked={sel.has(d.id)} onChange={() => toggle(d.id)} /></td>}
                <td className="mono"><a href={`/${d.direction === 'EXPORT' ? 'exports' : 'declarations'}/${d.id}`} onClick={go(nav, `/${d.direction === 'EXPORT' ? 'exports' : 'declarations'}/${d.id}`)}>{d.decl_no}</a></td>
                <td className="nowrap">{fmtDate(d.decl_date)}{!d.due && <div className="muted">{T('ikke forfalt for månedsfaktura')}</div>}</td>
                <td>{T(PAYER[d.payer] ?? d.payer)}</td>
                <td>{d.lines.map((l: any) => T(l.line_type === 'OUTLAY' ? 'Utlegg' : 'Gebyr') + ` ${money(l.amount)}`).join(' · ') || <span className="muted">—</span>}</td>
                <td className="num nowrap">{money(d.total)}</td>
                <td>{d.warnings.length > 0 && <button type="button" className="linkbtn" onClick={() => setOpen(open === d.id ? null : d.id)}>⚠ {d.warnings.length}</button>}</td>
              </tr>
              {open === d.id && <tr><td colSpan={7}><ul className="issues inline">{d.warnings.map((w: any, n: number) => <li key={n} className="warn">{T(w.msg)}</li>)}</ul></td></tr>}
            </Fragment>)}</tbody></table></div>
        </div>;
      })}
      {b.noClient.length > 0 && <div className="panelbox"><h3>{T('Uten klient')}</h3>
        <p className="hint" style={{ marginTop: 0 }}>{T('Disse deklarasjonene har verken klient eller mottaker/avsender og kan ikke faktureres før det er rettet.')}</p>
        <ul className="comments">{b.noClient.map((d: any) => <li key={d.id}><a href={`/declarations/${d.id}`} onClick={go(nav, `/${d.direction === 'EXPORT' ? 'exports' : 'declarations'}/${d.id}`)}>{d.decl_no}</a> <span className="muted">{fmtDate(d.decl_date)}</span></li>)}</ul></div>}
    </section>
  );
}

/* ------------------------------ the list ------------------------------ */
const TABS: [string, string][] = [['', 'Alle'], ['DRAFT', 'Utkast'], ['OPEN', 'Åpne'], ['OVERDUE', 'Forfalt'], ['PAID', 'Betalt'], ['CREDITED', 'Kreditert'], ['DISCARDED', 'Forkastet']];
export function InvoiceList({ me }: { me: Me }) {
  const nav = useNavigate();
  const [status, setStatus] = useState(() => new URLSearchParams(window.location.search).get('status') ?? ''), [q, setQ] = useState('');
  const [rows, setRows] = useState<any[] | null>(null), [sum, setSum] = useState<any>(null), [err, setErr] = useState(''), [newFor, setNewFor] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => api(`/invoices?status=${status || ''}${q ? `&q=${encodeURIComponent(q)}` : ''}`).then(setRows).catch(e => setErr(e.message)), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [status, q]);
  useEffect(() => { api('/invoicing/summary').then(setSum).catch(() => {}); }, []);
  const can = me.perms.includes('invoice.edit');
  const create = async (clientId: string) => { try { const r = await api('/invoices', { body: { clientId } }); nav(`/invoices/${r.id}`); } catch (x) { setErr((x as Error).message); } };
  const count = (k: string) => (k === 'DRAFT' ? sum?.drafts : k === 'OPEN' ? sum?.open : k === 'OVERDUE' ? sum?.overdue : undefined);
  return (
    <section>
      <div className="pagehead"><h2>{T('Fakturaer')}</h2>
        {sum && <span className="chip">{T('Utestående')} {money(sum.openAmount)} kr</span>}<span className="spacer" />
        <input type="search" aria-label={T('Søk')} placeholder={T('Søk: nummer, klient, KID, deklarasjon')} value={q} onChange={e => setQ(e.target.value)} style={{ width: 280 }} />
        {can && <button className="btn add" type="button" onClick={() => setNewFor(!newFor)}>{T('+ Faktura uten deklarasjon')}</button>}</div>
      {newFor && <div className="subform"><label htmlFor="newinv">{T('Klient')}</label><PartnerPicker id="newinv" onPick={id => create(id)} placeholder={T('Søk etter klient')} />
        <p className="hint">{T('For timer og annet arbeid. Linjene legges til på utkastet.')}</p></div>}
      {err && <div className="err">{T(err)}</div>}
      {sum?.fikenFailed > 0 && <div className="warnmsg">{sum.fikenFailed} {T(sum.fikenFailed === 1 ? 'sending til Fiken har feilet.' : 'sendinger til Fiken har feilet.')} <a href="/invoice-settings" onClick={go(nav, '/invoice-settings')}>{T('Se Fiken-køen')}</a></div>}
      <div className="tabs" role="tablist">{TABS.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={status === k} className={status === k ? 'on' : ''} onClick={() => setStatus(k)}>
        {T(l)}{count(k) != null && <span className="c">{count(k)}</span>}</button>)}</div>
      <div className="tblwrap"><table className="t">
        <thead><tr><th>{T('Nr.')}</th><th>{T('Klient')}</th><th>{T('Fakturadato')}</th><th>{T('Forfall')}</th><th>KID</th><th className="num">{T('Beløp')}</th><th className="num">{T('Åpent')}</th><th>{T('Status')}</th></tr></thead>
        <tbody>{(rows ?? []).map(r => <tr key={r.id} className="click" onClick={() => nav(`/invoices/${r.id}`)}>
          <td className="mono">{r.invoice_no ?? <span className="muted">{T('utkast')}</span>}{r.credits_no && <div className="muted">{T('krediterer')} {r.credits_no}</div>}</td>
          <td>{r.client_name}{r.kind === 'INVOICE' && r.declarations > 0 && <div className="muted">{r.declarations} {T(r.declarations === 1 ? 'deklarasjon' : 'deklarasjoner')}{r.consolidation === 'MONTHLY' ? ` · ${T('månedlig')}` : ''}</div>}</td>
          <td className="nowrap">{fmtDate(r.issue_date)}</td><td className="nowrap">{r.kind === 'INVOICE' ? fmtDate(r.due_date) : ''}</td><td className="mono">{r.kid ?? ''}</td>
          <td className="num nowrap">{money(r.total)}</td><td className="num nowrap">{r.open ? money(r.open) : ''}</td><td>{pill(r)}</td></tr>)}
          {rows && !rows.length && <tr><td colSpan={8} className="muted">{T('Ingen fakturaer.')}</td></tr>}</tbody></table></div>
    </section>
  );
}

/* ------------------------------ one invoice ------------------------------ */
const emptyLine = { item_code: '', description: '', quantity: '1', unit: 'stk', unit_price: '', vat_code: 'HIGH' };
export function InvoiceCard({ me }: { me: Me }) {
  const { id } = useParams();
  const nav = useNavigate();
  const [inv, setInv] = useState<any>(null), [meta, setMeta] = useState<any>(null), [err, setErr] = useState(''), [ok, setOk] = useState('');
  const [edit, setEdit] = useState<any>(null), [add, setAdd] = useState<any>(null), [head, setHead] = useState<any>(null);
  const [sel, setSel] = useState<Set<string>>(new Set()), [reason, setReason] = useState(''), [pay, setPay] = useState<any>(null);
  const take = (x: any) => { setInv(x); setHead({ your_ref: x.your_ref ?? '', note: x.note ?? '', delivery_from: x.delivery_from ?? '', delivery_to: x.delivery_to ?? '' }); setEdit(null); setSel(new Set()); };
  const load = () => api(`/invoices/${id}`).then(take).catch(e => setErr(e.message));
  useEffect(() => { setErr(''); setOk(''); load(); }, [id]);
  useEffect(() => { api('/invoicing/meta').then(setMeta).catch(() => {}); }, []);
  if (!inv) return err ? <div className="err">{T(err)}</div> : <p className="muted">{T('Laster …')}</p>;
  const canEdit = me.perms.includes('invoice.edit') && inv.status === 'DRAFT';
  const canIssue = me.perms.includes('invoice.issue');
  const act = async (fn: () => Promise<any>, msg: string) => {
    setErr(''); setOk('');
    try { const r = await fn(); if (r?.id && r.id !== inv.id) nav(`/invoices/${r.id}`); else take(r); setOk(msg); return true; }
    catch (x) { setErr((x as Error).message); if ((x as any).code === 'VERSION') load(); return false; }
  };
  const live = inv.lines.filter((l: any) => !l.removed_at), removed = inv.lines.filter((l: any) => l.removed_at);
  const creditable = inv.kind === 'INVOICE' && inv.status === 'ISSUED' && canIssue;
  const openLines = live.filter((l: any) => !l.credited_by_no);
  const pdfUrl = `/api/invoices/${inv.id}/pdf`;
  const issue = () => {
    if (!window.confirm(`${T('Utstede fakturaen til')} ${inv.client.legal_name} ${T('på')} ${money(inv.total)} kr? ${T('Den får neste fakturanummer og kan ikke endres etterpå, bare krediteres.')}`)) return;
    act(() => api(`/invoices/${inv.id}/issue`, { body: { version: inv.version } }), T('Fakturaen er utstedt.'));
  };
  const credit = () => {
    const n = sel.size || openLines.length;
    if (!window.confirm(`${T('Lage kreditnota for')} ${n} ${T(n === 1 ? 'linje' : 'linjer')}? ${T('Kreditnotaen får neste nummer i serien.')}`)) return;
    act(() => api(`/invoices/${inv.id}/credit`, { body: { reason, lineIds: sel.size ? [...sel] : undefined } }), T('Kreditnota laget.'));
  };
  const lineBody = (l: any) => ({ ...l, quantity: String(l.quantity).replace(',', '.'), unit_price: String(l.unit_price).replace(',', '.'), version: inv.version });
  return (
    <section>
      <div className="cardhead">
        <div><div className="muted">{T(inv.kind === 'CREDIT' ? 'Kreditnota' : 'Faktura')} · <a href={`/partners/${inv.client.id}`} onClick={go(nav, `/partners/${inv.client.id}`)}>{inv.client.legal_name}</a> · {T('opprettet')} {fmtDateTime(inv.created_at)}{inv.created_by_name ? ` · ${inv.created_by_name}` : ''}</div>
          <h2 className="mono">{inv.invoice_no ?? T('Utkast')}</h2></div>
        <div className="pills">{pill(inv)}{inv.kid && <span className="chip mono">KID {inv.kid}</span>}{inv.consolidation === 'MONTHLY' && <span className="chip">{T('Månedlig')}</span>}</div>
        <span className="spacer" />
        <a className="btn grey" href={pdfUrl} target="_blank" rel="noreferrer">{T(inv.status === 'DRAFT' ? 'Forhåndsvis PDF' : 'PDF')}</a>
        {inv.ehfBlocked && (inv.ehfBlocked.length ? <span className="chip" title={inv.ehfBlocked.map((g: string) => T(g)).join(', ')}>{T('EHF ikke mulig')}</span>
          : <a className="btn grey" href={`/api/invoices/${inv.id}/ehf`} title={T('Peppol BIS Billing 3.0. Sending skjer via aksesspunkt når OdinAi er i drift; la aksesspunktet validere den første (utlegg er kategori E).')}>{T('EHF (XML)')}</a>)}
        <button className="btn grey" type="button" onClick={() => nav('/invoices')}>← {T('Fakturaer')}</button>
      </div>
      {inv.status === 'DRAFT' && (canEdit || canIssue) && <div className={`wfbar ${inv.warnings.length ? 'warn' : ''}`}>
        <div className="wftext">{inv.warnings.length ? `${inv.warnings.length} ${T(inv.warnings.length === 1 ? 'merknad — se under.' : 'merknader — se under.')}` : T('Klar til å utstedes. Fakturanummer, forfallsdato og KID gis når du utsteder.')}</div>
        {canIssue && <button className="btn add" type="button" disabled={!live.length} onClick={issue}>{T('Utsted')}</button>}
        {canEdit && <button className="btn grey" type="button" onClick={() => { if (window.confirm(T('Forkaste utkastet? Deklarasjonene går tilbake til fakturagrunnlaget.'))) act(() => api(`/invoices/${inv.id}/discard`, { body: { version: inv.version } }), T('Utkastet er forkastet.')); }}>{T('Forkast')}</button>}
      </div>}
      {inv.status !== 'DRAFT' && inv.status !== 'DISCARDED' && <div className={`wfbar ${inv.display === 'OVERDUE' ? 'bad' : inv.display === 'PAID' || inv.display === 'CREDITED' ? 'ok' : ''}`}>
        <div className="wftext">{T('Utstedt')} {fmtDate(inv.issue_date)}{inv.issued_by_name ? ` ${T('av')} ${inv.issued_by_name}` : ''}.
          {inv.kind === 'INVOICE' && inv.status === 'ISSUED' && (inv.display === 'PAID' ? <> {T('Betalt i sin helhet.')}</> : <> {T('Forfall')} {fmtDate(inv.due_date)} · {T('åpent')} {money(inv.open)} kr.</>)}
          {inv.status === 'CREDITED' && <> {T('Hele fakturaen er kreditert.')}</>}
          {inv.kind === 'CREDIT' && inv.credits && <> {T('Krediterer faktura')} <a href={`/invoices/${inv.credits.id}`} onClick={go(nav, `/invoices/${inv.credits.id}`)}>{inv.credits.invoice_no}</a>{inv.credit_reason ? ` — ${inv.credit_reason}` : ''}.</>}</div>
      </div>}
      {inv.status === 'DISCARDED' && <div className="warnmsg">{T('Utkastet er forkastet. Deklarasjonene er tilbake i fakturagrunnlaget.')}</div>}
      {err && <div className="err">{T(err)}</div>}{ok && <div className="okmsg">{ok}</div>}
      {inv.warnings.length > 0 && <ul className="issues" style={{ marginBottom: 12 }}>{inv.warnings.map((w: any, n: number) => <li key={n} className="warn">{T(w.msg)}</li>)}</ul>}
      <div className="declgrid">
        <div>
          <div className="panelbox"><h3>{T('Linjer')}</h3>
            <div className="tblwrap"><table className="t">
              <thead><tr>{creditable && <th />}<th>{T('Beskrivelse')}</th><th className="num">{T('Antall')}</th><th className="num">{T('Enhetspris')}</th><th>{T('Mva')}</th><th className="num">{T('Beløp')}</th>{canEdit && <th />}</tr></thead>
              <tbody>{live.map((l: any) => edit?.id === l.id ? <tr key={l.id}>
                <td><input aria-label={T('Beskrivelse')} value={edit.description} onChange={e => setEdit({ ...edit, description: e.target.value })} /></td>
                <td><input aria-label={T('Antall')} inputMode="decimal" value={edit.quantity} onChange={e => setEdit({ ...edit, quantity: e.target.value })} style={{ width: 70 }} /></td>
                <td><input aria-label={T('Enhetspris')} inputMode="decimal" value={edit.unit_price} onChange={e => setEdit({ ...edit, unit_price: e.target.value })} style={{ width: 100 }} /></td>
                <td><select aria-label={T('Mva')} value={edit.vat_code} onChange={e => setEdit({ ...edit, vat_code: e.target.value })} style={{ minWidth: 0 }}>{Object.keys(VAT).map(k => <option key={k} value={k}>{T(VAT[k])}</option>)}</select></td>
                <td /><td className="nowrap"><button className="btn small" type="button" onClick={() => act(() => api(`/invoices/${inv.id}/lines/${l.id}`, { method: 'PUT', body: lineBody(edit) }), T('Linjen er endret.'))}>{T('Lagre')}</button>
                  <button className="linkbtn" type="button" onClick={() => setEdit(null)}>{T('Avbryt')}</button></td></tr>
                : <tr key={l.id}>
                  {creditable && <td>{!l.credited_by_no && <input type="checkbox" aria-label={l.description} checked={sel.has(l.id)} onChange={() => setSel(s => { const n = new Set(s); n.has(l.id) ? n.delete(l.id) : n.add(l.id); return n; })} />}</td>}
                  <td>{l.description}{l.agreed_price != null && <div className="muted">{T(l.price_source === 'AGREEMENT' ? 'Avtalt pris' : 'Listepris')} {money(l.agreed_price)}</div>}
                    {l.credited_by_no && <div className="muted">{T('Kreditert i')} {l.credited_by_no}</div>}
                    {l.price_source === 'AGREEMENT' && l.agreed_price == null && <div className="muted">{T('Pris fra avtalen')}</div>}</td>
                  <td className="num">{Number(l.quantity).toLocaleString(locale())}</td><td className="num nowrap">{money(l.unit_price)}</td><td className="nowrap">{T(VAT[l.vat_code])}</td>
                  <td className="num nowrap">{money(l.amount)}</td>
                  {canEdit && <td className="nowrap"><button className="linkbtn" type="button" onClick={() => setEdit({ id: l.id, description: l.description, quantity: String(Number(l.quantity)), unit_price: String(Number(l.unit_price)), vat_code: l.vat_code })}>{T('Endre')}</button>
                    <button className="linkbtn" type="button" onClick={() => act(() => api(`/invoices/${inv.id}/lines/${l.id}/remove`, { body: { version: inv.version } }), T('Linjen er fjernet.'))}>{T('Fjern')}</button></td>}
                </tr>)}
                {!live.length && <tr><td colSpan={7} className="muted">{T('Ingen linjer.')}</td></tr>}
                {removed.map((l: any) => <tr key={l.id} className="inactive"><td colSpan={creditable ? 5 : 4}><s>{l.description}</s> <span className="muted">· {T('fjernet')}</span></td><td className="num"><s>{money(l.amount)}</s></td>{canEdit && <td />}</tr>)}
              </tbody></table></div>
            {canEdit && (add ? <form className="subform" onSubmit={async e => { e.preventDefault(); if (await act(() => api(`/invoices/${inv.id}/lines`, { body: lineBody(add) }), T('Linjen er lagt til.'))) setAdd(null); }}>
              <div className="formgrid">
                <div><label htmlFor="nl-item">{T('Tjeneste')}</label><select id="nl-item" value={add.item_code} onChange={e => {
                  const it = meta?.priceItems.find((x: any) => x.code === e.target.value);
                  setAdd({ ...add, item_code: e.target.value, ...(it ? { description: it.name_no, unit: it.unit === 'PER_HOUR' ? 'timer' : 'stk', unit_price: String(Number(it.price) || ''), vat_code: it.mva_code } : {}) });
                }}><option value="">{T('Fritekst')}</option>{(meta?.priceItems ?? []).filter((x: any) => x.active && ['PER_HOUR', 'FIXED'].includes(x.unit)).map((x: any) => <option key={x.code} value={x.code}>{T(x.name_no)}</option>)}</select></div>
                <div className="fwide"><label htmlFor="nl-desc">{T('Beskrivelse')}</label><input id="nl-desc" value={add.description} onChange={e => setAdd({ ...add, description: e.target.value })} /></div>
                <div><label htmlFor="nl-qty">{T('Antall')}</label><input id="nl-qty" inputMode="decimal" value={add.quantity} onChange={e => setAdd({ ...add, quantity: e.target.value })} /></div>
                <div><label htmlFor="nl-unit">{T('Enhet')}</label><input id="nl-unit" value={add.unit} onChange={e => setAdd({ ...add, unit: e.target.value })} /></div>
                <div><label htmlFor="nl-price">{T('Enhetspris')}</label><input id="nl-price" inputMode="decimal" value={add.unit_price} onChange={e => setAdd({ ...add, unit_price: e.target.value })} /></div>
                <div><label htmlFor="nl-vat">{T('Mva')}</label><select id="nl-vat" value={add.vat_code} onChange={e => setAdd({ ...add, vat_code: e.target.value })}>{Object.keys(VAT).map(k => <option key={k} value={k}>{T(VAT[k])}</option>)}</select></div>
              </div>
              <div className="row"><button className="btn" type="submit">{T('Legg til')}</button><button className="btn grey" type="button" onClick={() => setAdd(null)}>{T('Avbryt')}</button></div>
            </form> : <button className="btn ghost small" type="button" onClick={() => setAdd({ ...emptyLine })}>{T('+ Legg til linje')}</button>)}
          </div>

          {canEdit && head && <form className="panelbox" onSubmit={e => { e.preventDefault(); act(() => api(`/invoices/${inv.id}`, { method: 'PUT', body: { ...head, version: inv.version } }), T('Lagret.')); }}>
            <h3>{T('På fakturaen')}</h3>
            <div className="formgrid">
              <div><label htmlFor="ih-ref">{T('Deres ref.')}</label><input id="ih-ref" value={head.your_ref} onChange={e => setHead({ ...head, your_ref: e.target.value })} /></div>
              <div><label htmlFor="ih-from">{T('Levert fra')}</label><input id="ih-from" type="date" value={head.delivery_from} onChange={e => setHead({ ...head, delivery_from: e.target.value })} /></div>
              <div><label htmlFor="ih-to">{T('Levert til')}</label><input id="ih-to" type="date" value={head.delivery_to} onChange={e => setHead({ ...head, delivery_to: e.target.value })} /></div>
              <div className="fwide"><label htmlFor="ih-note">{T('Merknad på fakturaen')}</label><textarea id="ih-note" rows={2} value={head.note} onChange={e => setHead({ ...head, note: e.target.value })} /></div>
            </div>
            <div className="row"><button className="btn" type="submit">{T('Lagre')}</button></div>
          </form>}

          {inv.kind === 'INVOICE' && ['ISSUED', 'CREDITED'].includes(inv.status) && <div className="panelbox"><h3>{T('Innbetalinger')}</h3>
            {inv.payments.length > 0 && <div className="tblwrap"><table className="t">
              <thead><tr><th>{T('Dato')}</th><th className="num">{T('Beløp')}</th><th>{T('Måte')}</th><th>{T('Referanse')}</th><th>{T('Registrert av')}</th><th /></tr></thead>
              <tbody>{inv.payments.map((p: any) => <tr key={p.id} className={p.reversed_at ? 'inactive' : ''}>
                <td className="nowrap">{fmtDate(p.paid_date)}</td><td className="num nowrap">{p.reversed_at ? <s>{money(p.amount)}</s> : money(p.amount)}</td>
                <td>{T(METHOD[p.method] ?? p.method)}</td><td>{p.reference ?? ''}{p.note && <div className="muted">{p.note}</div>}</td>
                <td className="muted">{p.created_by_name ?? ''}{p.reversed_at && <div>{T('Reversert')} {fmtDateTime(p.reversed_at)}: {p.reversal_reason}</div>}</td>
                <td>{!p.reversed_at && me.perms.includes('invoice.edit') && <button type="button" className="linkbtn" onClick={() => {
                  const why = window.prompt(T('Hvorfor skal innbetalingen reverseres?'));
                  if (why?.trim()) act(() => api(`/invoices/${inv.id}/payments/${p.id}/reverse`, { body: { reason: why } }), T('Innbetalingen er reversert.'));
                }}>{T('Reverser')}</button>}</td></tr>)}</tbody></table></div>}
            {!inv.payments.length && <p className="muted" style={{ marginTop: 0 }}>{T('Ingen innbetalinger registrert.')}</p>}
            {inv.status === 'ISSUED' && inv.open > 0 && me.perms.includes('invoice.edit') && (pay
              ? <form className="subform" onSubmit={async e => { e.preventDefault(); if (await act(() => api(`/invoices/${inv.id}/payments`, { body: { ...pay, amount: String(pay.amount).replace(',', '.') } }), T('Innbetalingen er registrert.'))) setPay(null); }}>
                <div className="formgrid">
                  <div><label htmlFor="py-amt">{T('Beløp')}</label><input id="py-amt" inputMode="decimal" value={pay.amount} onChange={e => setPay({ ...pay, amount: e.target.value })} /></div>
                  <div><label htmlFor="py-date">{T('Betalt dato')}</label><input id="py-date" type="date" value={pay.paid_date} max={osloToday()} onChange={e => setPay({ ...pay, paid_date: e.target.value })} /></div>
                  <div><label htmlFor="py-m">{T('Måte')}</label><select id="py-m" value={pay.method} onChange={e => setPay({ ...pay, method: e.target.value })}>{Object.keys(METHOD).map(k => <option key={k} value={k}>{T(METHOD[k])}</option>)}</select></div>
                  <div><label htmlFor="py-ref">{T('Referanse')}</label><input id="py-ref" value={pay.reference} onChange={e => setPay({ ...pay, reference: e.target.value })} placeholder={T('f.eks. arkivreferanse')} /></div>
                </div>
                <div className="row"><button className="btn" type="submit">{T('Registrer')}</button><button className="btn grey" type="button" onClick={() => setPay(null)}>{T('Avbryt')}</button></div>
              </form>
              : <button className="btn ghost small" type="button" onClick={() => setPay({ amount: String(inv.open), paid_date: osloToday(), method: 'BANK', reference: '' })}>{T('+ Registrer innbetaling')}</button>)}
            <p className="hint">{T('Innbetalinger registreres for hånd til banken kobles til når OdinAi er i drift. En feil innbetaling reverseres med en årsak; den slettes aldri.')}</p>
          </div>}

          {creditable && <div className="panelbox"><h3>{T('Krediter')}</h3>
            <p className="hint" style={{ marginTop: 0 }}>{T('Velg linjer i tabellen for å kreditere bare dem. Uten valg krediteres alle linjer som ikke er kreditert, og deklarasjonene går tilbake til fakturagrunnlaget.')}</p>
            <div className="row" style={{ marginTop: 0 }}>
              <input aria-label={T('Årsak')} placeholder={T('Årsak (påkrevd)')} value={reason} onChange={e => setReason(e.target.value)} style={{ flex: 1, minWidth: 220 }} />
              <button className="btn danger" type="button" disabled={!reason.trim() || !openLines.length} onClick={credit}>{sel.size ? `${T('Krediter valgte')} (${sel.size})` : T('Krediter hele fakturaen')}</button></div></div>}
        </div>

        <aside className="checkpanel">
          <div className="panelbox"><h3>{T('Beløp')}</h3>
            <dl className="kv small">
              <dt>{T('Sum eksklusiv mva')}</dt><dd className="num">{money(inv.net_total)}</dd>
              {inv.vatSummary.filter((v: any) => v.rate > 0).map((v: any) => <Fragment key={v.code + v.rate}><dt>{T('Mva')} {v.rate} %</dt><dd className="num">{money(v.vat)}</dd></Fragment>)}
              {Number(inv.outlay_total) !== 0 && <><dt>{T('Utlegg (ikke mva-pliktig)')}</dt><dd className="num">{money(inv.outlay_total)}</dd></>}
              {Number(inv.deposit_applied) !== 0 && <><dt>{T('Forskudd')}</dt><dd className="num">{money(-inv.deposit_applied)}</dd></>}
              <dt><b>{T(inv.kind === 'CREDIT' ? 'Å godskrive' : 'Å betale')}</b></dt><dd className="num"><b>{money(inv.kind === 'CREDIT' ? -inv.total : inv.total)}</b></dd>
              {inv.credited > 0 && <><dt>{T('Kreditert')}</dt><dd className="num">{money(-inv.credited)}</dd></>}
              {inv.kind === 'INVOICE' && inv.status === 'ISSUED' && <><dt>{T('Åpent')}</dt><dd className="num">{money(inv.open)}</dd></>}
            </dl></div>
          <div className="panelbox"><h3>{T('Opplysninger')}</h3>
            <dl className="kv small">
              <dt>{T('Klient')}</dt><dd>{inv.client.legal_name} <span className="muted">{inv.client.partner_no}</span></dd>
              {inv.issue_date && <><dt>{T('Fakturadato')}</dt><dd>{fmtDate(inv.issue_date)}</dd></>}
              {inv.due_date && inv.kind === 'INVOICE' && <><dt>{T('Forfall')}</dt><dd>{fmtDate(inv.due_date)}</dd></>}
              {inv.buyer?.street && <><dt>{T('Fakturaadresse')}</dt><dd>{[inv.buyer.street, [inv.buyer.postalCode, inv.buyer.city].filter(Boolean).join(' ')].join(', ')}</dd></>}
              {inv.buyer?.email && <><dt>{T('E-post for faktura')}</dt><dd>{inv.buyer.email}</dd></>}
              {inv.your_ref && <><dt>{T('Deres ref.')}</dt><dd>{inv.your_ref}</dd></>}
              <dt>{T('Levert')}</dt><dd>{fmtDate(inv.delivery_from)}{inv.delivery_to && inv.delivery_to !== inv.delivery_from ? `–${fmtDate(inv.delivery_to)}` : ''}</dd>
            </dl></div>
          {inv.declarations.length > 0 && <div className="panelbox"><h3>{T('Deklarasjoner')}</h3><ul className="comments">
            {inv.declarations.map((d: any) => <li key={d.id} className={d.released_at ? 'muted' : ''}>
              <a href={`/${d.direction === 'EXPORT' ? 'exports' : 'declarations'}/${d.id}`} onClick={go(nav, `/${d.direction === 'EXPORT' ? 'exports' : 'declarations'}/${d.id}`)} className="mono">{d.decl_no}</a> <span className="muted">{fmtDate(d.decl_date)}</span>
              {d.released_at && <span className="muted"> · {T('tatt av')}</span>}
              {canEdit && !d.released_at && <button type="button" className="linkbtn" onClick={() => act(() => api(`/invoices/${inv.id}/declarations/${d.id}/remove`, { body: { version: inv.version } }), T('Deklarasjonen er tatt av utkastet.'))}>{T('Ta av')}</button>}</li>)}</ul></div>}
          {inv.fiken.length > 0 && <div className="panelbox"><h3>Fiken</h3><ul className="comments">
            {inv.fiken.map((j: any) => <li key={j.id}>{T(JOB_KIND[j.kind] ?? j.kind)} {jobPill(j.status)} <span className="muted">{fmtDateTime(j.finished_at ?? j.queued_at)}{j.adapter === 'simulator' ? ` · ${T('simulator')}` : ''}</span>
              {j.last_error && <div className={j.status === 'FAILED' ? 'fmsg err' : 'muted'}>{T(j.last_error)}</div>}
              {j.status === 'FAILED' && canIssue && <button type="button" className="linkbtn" onClick={() => act(async () => { await api(`/invoicing/fiken/${j.id}/retry`, { body: {} }); return api(`/invoices/${inv.id}`); }, T('Sendes på nytt.'))}>{T('Prøv igjen')}</button>}</li>)}</ul></div>}
          {inv.creditNotes.length > 0 && <div className="panelbox"><h3>{T('Kreditnotaer')}</h3><ul className="comments">
            {inv.creditNotes.map((c: any) => <li key={c.id}><a href={`/invoices/${c.id}`} onClick={go(nav, `/invoices/${c.id}`)} className="mono">{c.invoice_no}</a> <span className="muted">{fmtDate(c.issue_date)} · {money(c.total)}</span>
              {c.credit_reason && <div className="muted">{c.credit_reason}</div>}</li>)}</ul></div>}
        </aside>
      </div>
    </section>
  );
}

/* ------------------------------ settings and the price list ------------------------------ */
const COMPANY: [string, string, string?][] = [['name', 'Firmanavn'], ['orgNo', 'Organisasjonsnummer'], ['street', 'Gateadresse'], ['postalCode', 'Postnummer'], ['city', 'Sted'],
  ['email', 'E-post'], ['phone', 'Telefon'], ['web', 'Nettside'], ['bankAccount', 'Kontonummer'], ['iban', 'IBAN'], ['bic', 'BIC']];
export function InvoiceSettings({ me }: { me: Me }) {
  const nav = useNavigate();
  const [s, setS] = useState<any>(null), [items, setItems] = useState<any[]>([]), [nextNo, setNextNo] = useState(''), [err, setErr] = useState(''), [ok, setOk] = useState('');
  const [gaps, setGaps] = useState<string[]>([]), [fk, setFk] = useState<any>(null), [fs, setFs] = useState<any>(null);
  const loadFiken = () => api('/invoicing/fiken').then(o => { setFk(o); setFs(o.settings); }).catch(e => setErr(e.message));
  const load = () => { loadFiken(); return api('/invoicing/meta').then(m => { setS(m.settings); setItems(m.priceItems.map((x: any) => ({ ...x, price: String(Number(x.price)), free_lines: x.free_lines ?? '' }))); setGaps(m.gaps); setNextNo(''); }).catch(e => setErr(e.message)); };
  useEffect(() => { load(); }, []);
  if (!s) return err ? <div className="err">{T(err)}</div> : <p className="muted">{T('Laster …')}</p>;
  const can = me.perms.includes('invoice.issue');
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(''); setOk('');
    try { await api('/invoicing/settings', { method: 'PUT', body: { company: s.company, dueDays: s.dueDays, kid: s.kid, footer: s.footer, ...(nextNo ? { nextNo } : {}) } }); await load(); setOk(T('Lagret.')); }
    catch (x) { setErr((x as Error).message); }
  };
  const saveItem = async (it: any) => {
    setErr(''); setOk('');
    try { await api(`/invoicing/price-items/${it.code}`, { method: 'PUT', body: { price: it.price.replace(',', '.'), free_lines: it.free_lines, mva_code: it.mva_code, name_no: it.name_no, active: it.active } }); await load(); setOk(`${T('Prislisten er lagret')}: ${T(it.name_no)}.`); }
    catch (x) { setErr((x as Error).message); }
  };
  const setItem = (code: string, patch: any) => setItems(items.map(x => (x.code === code ? { ...x, ...patch } : x)));
  const fikenAct = async (fn: () => Promise<any>, msg: string) => { setErr(''); setOk(''); try { const o = await fn(); if (o?.jobs) { setFk(o); setFs(o.settings); } else await loadFiken(); setOk(msg); } catch (x) { setErr((x as Error).message); } };
  return (
    <section>
      <div className="pagehead"><h2>{T('Fakturering › Innstillinger')}</h2></div>
      <Gaps gaps={gaps} nav={nav} />
      {err && <div className="err">{T(err)}</div>}{ok && <div className="okmsg">{ok}</div>}
      <form className="panelbox" onSubmit={save}><h3>{T('Firmaopplysninger på fakturaen')}</h3>
        <div className="formgrid">{COMPANY.map(([k, l]) => <div key={k}><label htmlFor={`co-${k}`}>{T(l)}</label>
          <input id={`co-${k}`} value={s.company[k] ?? ''} disabled={!can} onChange={e => setS({ ...s, company: { ...s.company, [k]: e.target.value } })} /></div>)}
          <label className="chk fcheck"><input type="checkbox" disabled={!can} checked={!!s.company.vatRegistered} onChange={e => setS({ ...s, company: { ...s.company, vatRegistered: e.target.checked } })} /> {T('Registrert i Merverdiavgiftsregisteret')}</label>
        </div>
        <h3 style={{ marginTop: 16 }}>{T('Betaling og nummerserie')}</h3>
        <div className="formgrid">
          <div><label htmlFor="co-due">{T('Betalingsfrist (dager)')}</label><input id="co-due" inputMode="numeric" value={s.dueDays} disabled={!can} onChange={e => setS({ ...s, dueDays: e.target.value })} /></div>
          <div><label htmlFor="co-next">{T('Neste fakturanummer')} ({s.nextNo})</label><input id="co-next" inputMode="numeric" placeholder={T('Bare fremover')} value={nextNo} disabled={!can} onChange={e => setNextNo(e.target.value)} /></div>
          <label className="chk fcheck"><input type="checkbox" disabled={!can} checked={!!s.kid} onChange={e => setS({ ...s, kid: e.target.checked })} /> {T('KID på fakturaene (MOD10)')}</label>
          <div className="fwide"><label htmlFor="co-foot">{T('Bunntekst')}</label><input id="co-foot" value={s.footer ?? ''} disabled={!can} onChange={e => setS({ ...s, footer: e.target.value })} /></div>
        </div>
        <p className="hint">{T('Betalingsfristen på partnerkortet går foran denne. Fakturanumrene er én sammenhengende serie for fakturaer og kreditnotaer; den kan bare flyttes fremover.')}</p>
        {can && <div className="row"><button className="btn" type="submit">{T('Lagre')}</button></div>}
      </form>
      {fk && fs && <form className="panelbox" onSubmit={e => { e.preventDefault(); fikenAct(() => api('/invoicing/settings', { method: 'PUT', body: { fiken: fs } }), T('Lagret.')); }}>
        <h3>Fiken <span className="chip">{fk.adapter === 'live' ? T('Sender til Fiken') : T('Simulator — ingenting sendes')}</span>
          {Number(fk.counts.failed) > 0 && <span className="pill rejected">{fk.counts.failed} {T('feilet')}</span>}{Number(fk.counts.waiting) > 0 && <span className="pill submitted">{fk.counts.waiting} {T('venter')}</span>}</h3>
        <p className="hint" style={{ marginTop: 0 }}>{T('Hver utstedte faktura og kreditnota føres i Fiken som «Annet salg» med OdinAi sitt fakturanummer; innbetalinger føres på salget. Kontoene og mva-typene under må regnskapsføreren bekrefte. API-nøkkelen (FIKEN_TOKEN) ligger i .env og vises aldri her.')}</p>
        {fk.gaps.length > 0 && <div className="warnmsg">{T('Mangler')}: {fk.gaps.map((g: string) => T(g)).join(', ')}.</div>}
        <div className="formgrid">
          <div><label htmlFor="fk-slug">{T('Selskapets navn i Fiken (slug)')}</label><input id="fk-slug" value={fs.companySlug} disabled={!can} placeholder="odin-customs-as" onChange={e => setFs({ ...fs, companySlug: e.target.value })} /></div>
          <div><label htmlFor="fk-pay">{T('Bankkonto for innbetalinger')}</label><input id="fk-pay" value={fs.paymentAccount} disabled={!can} placeholder="1920:10001" onChange={e => setFs({ ...fs, paymentAccount: e.target.value })} /></div>
          <label className="chk fcheck"><input type="checkbox" disabled={!can} checked={!!fs.auto} onChange={e => setFs({ ...fs, auto: e.target.checked })} /> {T('Send til Fiken av seg selv')}</label>
        </div>
        <div className="tblwrap" style={{ marginTop: 10 }}><table className="t small">
          <thead><tr><th>{T('Mva-kode i OdinAi')}</th><th>{T('Konto i Fiken')}</th><th>{T('Mva-type i Fiken')}</th></tr></thead>
          <tbody>{Object.keys(VAT).map(k => <tr key={k}><td>{T(VAT[k])}</td>
            <td><input aria-label={`${T('Konto i Fiken')} ${k}`} value={fs.accounts[k] ?? ''} disabled={!can} onChange={e => setFs({ ...fs, accounts: { ...fs.accounts, [k]: e.target.value } })} style={{ width: 120 }} /></td>
            <td><select aria-label={`${T('Mva-type i Fiken')} ${k}`} value={fs.vatTypes[k] ?? ''} disabled={!can} onChange={e => setFs({ ...fs, vatTypes: { ...fs.vatTypes, [k]: e.target.value } })} style={{ minWidth: 0 }}>
              {['NONE', 'HIGH', 'MEDIUM', 'LOW', 'EXEMPT', 'EXEMPT_IMPORT_EXPORT', 'OUTSIDE', 'EXEMPT_REVERSE', 'RAW_FISH'].map(v => <option key={v} value={v}>{v}</option>)}</select></td></tr>)}</tbody></table></div>
        {can && <div className="row"><button className="btn" type="submit">{T('Lagre')}</button>
          <button className="btn grey" type="button" onClick={() => fikenAct(() => api('/invoicing/fiken/catch-up', { body: {} }), T('Det som manglet, er lagt i køen.'))}>{T('Send det som mangler i Fiken')}</button></div>}
        <h3 style={{ marginTop: 16 }}>{T('Fiken-køen')}</h3>
        <div className="tblwrap"><table className="t small">
          <thead><tr><th>{T('Faktura')}</th><th>{T('Hva')}</th><th>{T('Status')}</th><th>{T('Melding')}</th><th>{T('Tid')}</th>{can && <th />}</tr></thead>
          <tbody>{fk.jobs.slice(0, 50).map((j: any) => <tr key={j.id}>
            <td className="mono"><a href={`/invoices/${j.invoice_id}`} onClick={go(nav, `/invoices/${j.invoice_id}`)}>{j.invoice_no}</a> <span className="muted">{j.client_name}</span></td>
            <td>{T(JOB_KIND[j.kind] ?? j.kind)}</td><td>{jobPill(j.status)}</td><td>{j.last_error ? T(j.last_error) : ''}</td><td className="muted nowrap">{fmtDateTime(j.finished_at ?? j.queued_at)}</td>
            {can && <td className="nowrap">{j.status === 'FAILED' && <button type="button" className="linkbtn" onClick={() => fikenAct(() => api(`/invoicing/fiken/${j.id}/retry`, { body: {} }), T('Sendes på nytt.'))}>{T('Prøv igjen')}</button>}
              {['QUEUED', 'FAILED'].includes(j.status) && <button type="button" className="linkbtn" onClick={() => { const why = window.prompt(T('Hvorfor avbrytes jobben (f.eks. ført for hånd i Fiken)?')); if (why?.trim()) fikenAct(() => api(`/invoicing/fiken/${j.id}/cancel`, { body: { reason: why } }), T('Avbrutt.')); }}>{T('Avbryt')}</button>}</td>}
          </tr>)}{!fk.jobs.length && <tr><td colSpan={6} className="muted">{T('Ingenting sendt ennå.')}</td></tr>}</tbody></table></div>
      </form>}
      <div className="panelbox"><h3>{T('Prisliste')}</h3>
        <p className="hint" style={{ marginTop: 0 }}>{T('Listeprisen gjelder når klienten ikke har en avtalt pris på partnerkortet. Prisene er uten mva. En endring gjelder nye utkast, ikke fakturaer som er laget.')}</p>
        <div className="tblwrap"><table className="t">
          <thead><tr><th>{T('Tjeneste')}</th><th>{T('Enhet')}</th><th className="num">{T('Pris')}</th><th className="num">{T('Inkludert')}</th><th>{T('Mva')}</th><th>{T('Aktiv')}</th>{can && <th />}</tr></thead>
          <tbody>{items.map(it => <tr key={it.code}>
            <td><input aria-label={T('Tjeneste')} value={it.name_no} disabled={!can} onChange={e => setItem(it.code, { name_no: e.target.value })} /><div className="muted mono">{it.code}</div></td>
            <td>{T(UNIT[it.unit] ?? it.unit)}</td>
            <td><input aria-label={T('Pris')} inputMode="decimal" value={it.price} disabled={!can} onChange={e => setItem(it.code, { price: e.target.value })} style={{ width: 90, textAlign: 'right' }} /></td>
            <td>{it.unit === 'PER_LINE' ? <input aria-label={T('Inkludert')} inputMode="numeric" value={it.free_lines} disabled={!can} onChange={e => setItem(it.code, { free_lines: e.target.value })} style={{ width: 60, textAlign: 'right' }} /> : ''}</td>
            <td><select aria-label={T('Mva')} value={it.mva_code} disabled={!can} onChange={e => setItem(it.code, { mva_code: e.target.value })} style={{ minWidth: 0 }}>{Object.keys(VAT).map(k => <option key={k} value={k}>{T(VAT[k])}</option>)}</select></td>
            <td><input type="checkbox" aria-label={T('Aktiv')} checked={!!it.active} disabled={!can} onChange={e => setItem(it.code, { active: e.target.checked })} /></td>
            {can && <td><button className="btn small" type="button" onClick={() => saveItem(it)}>{T('Lagre')}</button></td>}
          </tr>)}</tbody></table></div>
        <p className="hint">{T('Kredittprovisjon er en prosent av toll og avgifter Odin har lagt ut, og tas bare med når Odin betalte. Timer legges til for hånd på et utkast.')}</p>
      </div>
    </section>
  );
}
