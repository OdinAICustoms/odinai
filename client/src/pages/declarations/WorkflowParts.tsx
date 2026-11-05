import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type Me } from '../../api';
import { T, fmtDateTime } from '../../i18n';

const RESULT: Record<string, [string, string]> = { ACCEPTED: ['Akseptert', 'accepted'], STAT_CHECK: ['Statistisk kontroll', 'submitted'], REJECTED: ['Avvist', 'rejected'] };

/** What can happen next: submit, approve / return / recall, the queue, and TVINN's answer. */
export function WorkflowBar({ d, me, act, onReload, dirty }: { d: any; me: Me; act: (fn: () => Promise<any>, msg?: string) => Promise<any>; onReload: () => void; dirty: boolean }) {
  const [reason, setReason] = useState(''), [returning, setReturning] = useState(false);
  const v = d.versions?.[0];
  const job = d.queue?.[0];
  const inFlight = ['APPROVED', 'SENT'].includes(d.status) && job && ['QUEUED', 'SENDING'].includes(job.status);
  useEffect(() => { if (!inFlight) return; const t = setInterval(onReload, 1500); return () => clearInterval(t); }, [inFlight]);
  const canEdit = me.perms.includes('declaration.edit'), canApprove = me.perms.includes('declaration.approve');
  const open = (d.reviews ?? []).filter((r: any) => r.status === 'OPEN').length;
  const ownSubmit = v?.submitted_by === me.id;

  if (d.status === 'CANCELLED') return null;
  if (d.editable) {
    const blocked = !d.check.ok ? `${d.check.errors} ${T('feil må rettes før innsending.')}` : open ? `${open} ${T('kontrollpunkter må avklares før innsending.')}` : dirty ? T('Lagre endringene først.') : '';
    return <div className={`wfbar ${d.status === 'REJECTED' ? 'bad' : d.status === 'RETURNED' ? 'warn' : ''}`}>
      <div className="wftext">
        {d.status === 'RETURNED' && v?.decision_reason && <div><b>{T('Returnert')}:</b> {T(v.decision_reason)} <span className="muted">({v.decided_by_name}, {fmtDateTime(v.decided_at)})</span></div>}
        {d.status === 'REJECTED' && v?.answer && <><div><b>{T('Avvist av TVINN')}</b> · {T('versjon')} {v.version_no} · {fmtDateTime(v.answered_at)}</div>
          <ul className="tvinnerr">{v.answer.errors.map((e: any) => <li key={e.seq}>{e.number && <span className="chip mono">{e.number}</span>} <span className="boxno">{e.box}</span>{T(e.msg)}</li>)}</ul></>}
        {d.status === 'DRAFT' && <span>{T('Utkast')}{d.current_version ? ` · ${T('versjon')} ${d.current_version + 1}` : ''}. {blocked || T('Klar til å sendes til godkjenning.')}</span>}
        {d.status !== 'DRAFT' && blocked && <div className="muted">{blocked}</div>}
      </div>
      {canEdit && <button className="btn" type="button" disabled={!!blocked} onClick={() => act(() => api(`/declarations/${d.id}/submit`, { body: { version: d.version } }), T('Sendt til godkjenning.'))}>
        {T('Send til godkjenning')}</button>}
    </div>;
  }
  if (d.status === 'SUBMITTED') return <div className="wfbar warn">
    <div className="wftext"><b>{T('Venter på godkjenning')}</b> · {T('versjon')} {v?.version_no} · {T('sendt av')} {v?.submitted_by_name}, {fmtDateTime(v?.submitted_at)}
      {canApprove && ownSubmit && d.workflow?.fourEyes && <div className="muted">{T('Fire øyne: en annen godkjenner må godkjenne denne deklarasjonen.')}</div>}
      {returning && <div className="row"><input aria-label={T('Årsak')} placeholder={T('Hvorfor returneres den? (påkrevd)')} value={reason} onChange={e => setReason(e.target.value)} style={{ flex: 1, minWidth: 260 }} />
        <button className="btn danger" type="button" disabled={!reason.trim()} onClick={async () => { if (await act(() => api(`/declarations/${d.id}/return`, { body: { reason } }), T('Returnert til tollspesialisten.'))) { setReturning(false); setReason(''); } }}>{T('Returner')}</button>
        <button className="btn grey" type="button" onClick={() => setReturning(false)}>{T('Avbryt')}</button></div>}
    </div>
    {canApprove && !returning && <>
      <button className="btn add" type="button" disabled={ownSubmit && d.workflow?.fourEyes} onClick={() => act(() => api(`/declarations/${d.id}/approve`, { body: {} }), T('Godkjent og lagt i sendekøen.'))}>{T('Godkjenn og send')}</button>
      <button className="btn grey" type="button" onClick={() => setReturning(true)}>{T('Returner')}</button></>}
    {canEdit && ownSubmit && !returning && <button className="btn grey" type="button" onClick={() => act(() => api(`/declarations/${d.id}/recall`, { body: {} }), T('Trukket tilbake.'))}>{T('Trekk tilbake')}</button>}
  </div>;
  if (['APPROVED', 'SENT'].includes(d.status)) return <div className={`wfbar ${job?.status === 'FAILED' ? 'bad' : 'warn'}`}>
    <div className="wftext"><b>{job?.status === 'FAILED' ? T('Sendingen feilet') : d.status === 'SENT' ? T('Sendes til TVINN …') : T('Godkjent — i sendekøen')}</b>
      {' '}· {T('versjon')} {v?.version_no} · {T('godkjent av')} {v?.decided_by_name}
      {job?.last_error && <div className={job.status === 'FAILED' ? 'bad' : 'muted'}>{T(job.last_error)}</div>}
      {job?.status === 'FAILED' && <div className="muted">{T('Se Sendekø for å prøve igjen eller avbryte.')}</div>}</div>
  </div>;
  if (d.status === 'ACCEPTED') {
    const r = RESULT[v?.result] ?? RESULT.ACCEPTED;
    return <div className={`wfbar ${v?.result === 'STAT_CHECK' ? 'warn' : 'ok'}`}>
      <div className="wftext"><div><span className={`pill ${r[1]}`}>{T(r[0])}</span> <b>{T(v?.answer?.decision ?? '')}</b> · {fmtDateTime(v?.answered_at)}</div>
        <dl className="kv small" style={{ marginTop: 6 }}><dt>MRN</dt><dd className="mono">{d.mrn}</dd><dt>{T('Ekspedisjonsnummer')}</dt><dd className="mono">{d.tvinn_no}</dd>
          <dt>{T('Deklarasjons-ID')}</dt><dd className="mono">{v?.tvinn_id}</dd></dl>
        {v?.answer?.text && <p className="hint">{T(v.answer.text)}</p>}</div>
    </div>;
  }
  return null;
}

/** Versions sent, TVINN's answers, and the comments between specialist and approver. */
export function HistoryPanel({ d, act }: { d: any; act: (fn: () => Promise<any>, msg?: string) => Promise<any> }) {
  const [text, setText] = useState('');
  if (!d.versions?.length && !d.comments?.length && d.status === 'DRAFT') return <div className="panelbox"><h3>{T('Kommentarer')}</h3><CommentBox d={d} text={text} setText={setText} act={act} /></div>;
  return (
    <div className="panelbox" id="sec-history" tabIndex={-1}>
      <h3>{T('Versjoner og TVINN-svar')}</h3>
      {d.versions?.length ? <div className="tblwrap"><table className="t small">
        <thead><tr><th>{T('Versjon')}</th><th>{T('Sendt til godkjenning')}</th><th>{T('Godkjenning')}</th><th>{T('TVINN-svar')}</th><th>MRN</th><th /></tr></thead>
        <tbody>{d.versions.map((v: any) => <tr key={v.id}>
          <td>{v.version_no}</td><td>{v.submitted_by_name} · {fmtDateTime(v.submitted_at)}</td>
          <td>{v.decision ? <>{T(v.decision === 'APPROVED' ? 'Godkjent' : 'Returnert')} · {v.decided_by_name}{v.decision_reason ? <div className="muted">{T(v.decision_reason)}</div> : null}</> : <span className="muted">{T('Venter')}</span>}</td>
          <td>{v.result ? <span className={`pill ${RESULT[v.result]?.[1] ?? ''}`}>{T(RESULT[v.result]?.[0] ?? v.result)}</span> : '—'}{v.answer?.simulator && <span className="muted"> {T('simulator')}</span>}</td>
          <td className="mono">{v.mrn ?? ''}</td>
          <td>{v.has_message && <a href={`/api/declarations/${d.id}/versions/${v.version_no}/message`} target="_blank" rel="noopener noreferrer">EDIFACT</a>}</td>
        </tr>)}</tbody></table></div> : <p className="muted">{T('Ikke sendt til godkjenning ennå.')}</p>}
      <h3 style={{ marginTop: 12 }}>{T('Kommentarer')}</h3>
      <CommentBox d={d} text={text} setText={setText} act={act} />
    </div>
  );
}

function CommentBox({ d, text, setText, act }: { d: any; text: string; setText: (s: string) => void; act: (fn: () => Promise<any>, msg?: string) => Promise<any> }) {
  return <>
    <ul className="comments">{(d.comments ?? []).map((c: any) => <li key={c.id}><b>{c.user_name}</b> <span className="muted">{fmtDateTime(c.created_at)}</span><div>{T(c.text)}</div></li>)}</ul>
    <div className="row" style={{ marginTop: 6 }}>
      <input aria-label={T('Ny kommentar')} placeholder={T('Skriv en kommentar til tollspesialist eller godkjenner')} value={text} onChange={e => setText(e.target.value)} style={{ flex: 1, minWidth: 240 }} />
      <button className="btn ghost small" type="button" disabled={!text.trim()} onClick={async () => { if (await act(() => api(`/declarations/${d.id}/comments`, { body: { text } }))) setText(''); }}>{T('Legg til')}</button>
    </div>
  </>;
}

const QSTATUS: Record<string, [string, string]> = { QUEUED: ['I kø', 'submitted'], SENDING: ['Sendes', 'submitted'], DONE: ['Sendt', 'accepted'], FAILED: ['Feilet', 'rejected'], CANCELLED: ['Avbrutt', 'cancelled'] };

/** AI-deklarasjoner › Sendekø: every sending to TVINN; failed ones can be tried again or cancelled. */
export function SendQueue({ me }: { me: Me }) {
  const nav = useNavigate();
  const [rows, setRows] = useState<any[]>([]), [err, setErr] = useState('');
  const load = () => api('/send-queue').then(setRows).catch(e => setErr(e.message));
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, []);
  const can = me.perms.includes('declaration.approve');
  const run = async (fn: () => Promise<any>) => { setErr(''); try { setRows(await fn()); } catch (x) { setErr((x as Error).message); } };
  return (
    <section>
      <div className="pagehead"><h2>{T('Sendekø til TVINN')}</h2></div>
      <p className="hint">{T('Godkjente deklarasjoner sendes én om gangen. Et avslag fra TVINN er et svar, ikke en feil. En sending som ikke får svar, prøves igjen etter 10 sekunder, 1 minutt og 5 minutter, og blir deretter liggende som feilet.')}</p>
      {err && <div className="err">{T(err)}</div>}
      <div className="tblwrap"><table className="t">
        <thead><tr><th>{T('Deklarasjon')}</th><th>{T('Versjon')}</th><th>{T('Status')}</th><th>{T('Forsøk')}</th><th>{T('Kanal')}</th><th>{T('Lagt i kø')}</th><th>{T('Ferdig')}</th><th>{T('Feil')}</th>{can && <th />}</tr></thead>
        <tbody>{rows.map(j => <tr key={j.id}>
          <td className="mono"><a href={`/declarations/${j.declaration_id}`} onClick={e => { e.preventDefault(); nav(`/declarations/${j.declaration_id}`); }}>{j.decl_no}</a></td>
          <td>{j.version_no}</td><td><span className={`pill ${QSTATUS[j.status]?.[1] ?? ''}`}>{T(QSTATUS[j.status]?.[0] ?? j.status)}</span></td><td>{j.attempts}</td>
          <td>{j.adapter === 'simulator' ? T('Simulator') : 'EDIFACT'}</td><td className="nowrap">{fmtDateTime(j.queued_at)}{j.queued_by_name ? ` · ${j.queued_by_name}` : ''}</td>
          <td className="nowrap">{fmtDateTime(j.finished_at)}</td><td className="muted">{j.last_error ? T(j.last_error) : ''}</td>
          {can && <td className="nowrap">{j.status === 'FAILED' && <button className="linkbtn" type="button" onClick={() => run(() => api(`/send-queue/${j.id}/retry`, { body: {} }))}>{T('Prøv igjen')}</button>}
            {['FAILED', 'QUEUED'].includes(j.status) && <button className="linkbtn" type="button" onClick={() => { const r = window.prompt(T('Hvorfor avbrytes sendingen?')); if (r !== null) run(() => api(`/send-queue/${j.id}/cancel`, { body: { reason: r } })); }}>{T('Avbryt')}</button>}</td>}
        </tr>)}
        {!rows.length && <tr><td colSpan={9} className="muted">{T('Ingen sendinger ennå.')}</td></tr>}</tbody>
      </table></div>
    </section>
  );
}
