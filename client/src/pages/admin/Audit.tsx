import { useEffect, useState } from 'react';
import { api } from '../../api';
import { T, fmtDateTime } from '../../i18n';

interface Row { id: number; at: string; user_name: string | null; action: string; object_type: string | null; object_id: string | null; changes: Record<string, [unknown, unknown]> | null; detail: unknown; ip: string | null }

const ACTIONS: Record<string, string> = {
  USER_SETUP: 'Første administrator opprettet', LOGIN: 'Pålogging', LOGIN_FAILED: 'Mislykket pålogging', USER_LOCKED: 'Konto låst',
  USER_CREATED: 'Bruker opprettet', USER_CHANGED: 'Bruker endret', PASSWORD_CHANGED: 'Passord byttet', PASSWORD_RESET: 'Passord tilbakestilt',
  SETTING_CHANGED: 'Innstilling endret', REFDATA_REFRESH: 'Oppdatering av referansedata startet'
};
const show = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** The audit log: newest first, field by field what changed. Read-only for everyone. */
export function Audit() {
  const [rows, setRows] = useState<Row[]>([]);
  const [action, setAction] = useState('');
  const [more, setMore] = useState(true);
  const load = async (before?: number) => {
    const q = new URLSearchParams({ limit: '100', ...(action ? { action } : {}), ...(before ? { before: String(before) } : {}) });
    const r: Row[] = await api('/admin/audit?' + q);
    setRows(before ? [...rows, ...r] : r); setMore(r.length === 100);
  };
  useEffect(() => { load(); }, [action]);
  return (
    <section>
      <div className="pagehead"><h2>{T('Endringslogg')}</h2></div>
      <div className="filters">
        <select value={action} onChange={e => setAction(e.target.value)} aria-label={T('Hendelse')}>
          <option value="">{T('Alle hendelser')}</option>
          {Object.entries(ACTIONS).map(([k, v]) => <option key={k} value={k}>{T(v)}</option>)}
        </select>
      </div>
      <div className="tblwrap"><table className="t">
        <thead><tr><th>{T('Tidspunkt')}</th><th>{T('Bruker')}</th><th>{T('Hendelse')}</th><th>{T('Gjelder')}</th><th>{T('Endringer')}</th><th>IP</th></tr></thead>
        <tbody>{rows.map(r => <tr key={r.id}>
          <td className="nowrap">{fmtDateTime(r.at)}</td><td>{r.user_name || '—'}</td><td>{T(ACTIONS[r.action] ?? r.action)}</td>
          <td className="muted">{r.object_type ? `${r.object_type} ${String(r.object_id || '').slice(0, 8)}` : ''}</td>
          <td>{r.changes ? Object.entries(r.changes).map(([k, [a, b]]) => <div key={k}><b>{k}</b>: {show(a)} → {show(b)}</div>) : r.detail ? <span className="muted">{show(r.detail)}</span> : ''}</td>
          <td className="muted">{r.ip}</td>
        </tr>)}</tbody>
      </table></div>
      {more && rows.length > 0 && <button className="btn grey" type="button" onClick={() => load(rows.at(-1)!.id)}>{T('Vis eldre')}</button>}
    </section>
  );
}
