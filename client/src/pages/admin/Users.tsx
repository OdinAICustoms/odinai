import { useEffect, useState, type FormEvent } from 'react';
import { api, type Me } from '../../api';
import { T, fmtDateTime, getLang } from '../../i18n';

interface User { id: string; email: string; name: string; roles: string[]; active: boolean; must_change: boolean; last_login_at: string | null; locked_until: string | null }
type Roles = Record<string, { label: { no: string; en: string } }>;

export function Users({ me }: { me: Me }) {
  const [list, setList] = useState<User[]>([]);
  const [roles, setRoles] = useState<Roles>({});
  const [edit, setEdit] = useState<Partial<User> | null>(null);
  const [temp, setTemp] = useState<{ email: string; pw: string } | null>(null);
  const [err, setErr] = useState('');
  const load = async () => setList(await api('/admin/users'));
  useEffect(() => { load(); api('/auth/config').then(c => setRoles(c.roles)); }, []);
  const roleName = (r: string) => roles[r]?.label[getLang()] ?? r;

  async function save(e: FormEvent) {
    e.preventDefault(); setErr('');
    try {
      if (edit!.id) await api(`/admin/users/${edit!.id}`, { method: 'PUT', body: { name: edit!.name, roles: edit!.roles, active: edit!.active } });
      else { const r = await api('/admin/users', { body: { name: edit!.name, email: edit!.email, roles: edit!.roles } }); setTemp({ email: r.user.email, pw: r.temporaryPassword }); }
      setEdit(null); load();
    } catch (x) { setErr(T((x as Error).message)); }
  }
  async function reset(u: User) {
    try { const r = await api(`/admin/users/${u.id}/reset-password`, { body: {} }); setTemp({ email: u.email, pw: r.temporaryPassword }); load(); }
    catch (x) { setErr(T((x as Error).message)); }
  }
  const toggleRole = (r: string) => setEdit(e => ({ ...e!, roles: e!.roles!.includes(r) ? e!.roles!.filter(x => x !== r) : [...e!.roles!, r] }));

  return (
    <section>
      <div className="pagehead"><h2>{T('Brukere')}</h2><span className="spacer" />
        <button className="btn add" type="button" onClick={() => { setErr(''); setEdit({ name: '', email: '', roles: ['specialist'], active: true }); }}>{T('+ Ny bruker')}</button></div>
      {temp && <div className="panelbox okbox" role="status">
        <b>{T('Midlertidig passord for')} {temp.email}</b>
        <div className="temppw">{temp.pw}</div>
        <p className="hint">{T('Vises bare nå. Gi det til brukeren på en trygg måte; det må byttes ved første pålogging.')}</p>
        <button className="btn grey small" type="button" onClick={() => setTemp(null)}>{T('Lukk')}</button>
      </div>}
      {edit && <form className="panelbox" onSubmit={save}>
        <h3>{edit.id ? T('Endre bruker') : T('Ny bruker')}</h3>
        <div className="grid2">
          <div><label htmlFor="uName">{T('Navn')}</label><input id="uName" value={edit.name} onChange={e => setEdit({ ...edit, name: e.target.value })} required /></div>
          <div><label htmlFor="uEmail">{T('E-post')}</label><input id="uEmail" type="email" value={edit.email} disabled={!!edit.id} onChange={e => setEdit({ ...edit, email: e.target.value })} required /></div>
        </div>
        <fieldset className="roles"><legend>{T('Roller')}</legend>
          {Object.keys(roles).map(r => <label key={r} className="chk"><input type="checkbox" checked={edit.roles!.includes(r)} onChange={() => toggleRole(r)} /> {roleName(r)}</label>)}
        </fieldset>
        {edit.id && edit.id !== me.id && <label className="chk"><input type="checkbox" checked={edit.active} onChange={e => setEdit({ ...edit, active: e.target.checked })} /> {T('Aktiv')}</label>}
        <div className="row"><button className="btn" type="submit" disabled={!edit.roles!.length}>{T('Lagre')}</button>
          <button className="btn grey" type="button" onClick={() => setEdit(null)}>{T('Avbryt')}</button></div>
        {err && <div className="err">{err}</div>}
      </form>}
      {!edit && err && <div className="err">{err}</div>}
      <div className="tblwrap"><table className="t">
        <thead><tr><th>{T('Navn')}</th><th>{T('E-post')}</th><th>{T('Roller')}</th><th>{T('Sist pålogget')}</th><th>{T('Status')}</th><th /></tr></thead>
        <tbody>{list.map(u => <tr key={u.id} className={u.active ? '' : 'inactive'}>
          <td><b>{u.name}</b>{u.id === me.id && <span className="muted"> ({T('deg')})</span>}</td><td>{u.email}</td>
          <td>{u.roles.map(r => <span key={r} className="chip">{roleName(r)}</span>)}</td>
          <td>{fmtDateTime(u.last_login_at) || '—'}</td>
          <td>{!u.active ? <span className="pill cancelled">{T('Inaktiv')}</span> : u.locked_until && new Date(u.locked_until) > new Date() ? <span className="pill rejected">{T('Låst')}</span>
            : u.must_change ? <span className="pill submitted">{T('Må bytte passord')}</span> : <span className="pill accepted">{T('Aktiv')}</span>}</td>
          <td className="r"><button className="linkbtn" type="button" onClick={() => { setErr(''); setEdit(u); }}>{T('Endre')}</button>
            {u.id !== me.id && <button className="linkbtn" type="button" onClick={() => reset(u)}>{T('Nytt passord')}</button>}</td>
        </tr>)}</tbody>
      </table></div>
    </section>
  );
}
