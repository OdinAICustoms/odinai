import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { T } from '../i18n';
import { Logo } from '../components/Logo';

export function ChangePassword({ forced, onDone, onCancel }: { forced?: boolean; onDone: () => void; onCancel?: () => void }) {
  const [f, setF] = useState({ current: '', next: '', next2: '' });
  const [err, setErr] = useState(''), [ok, setOk] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault(); setErr('');
    if (f.next !== f.next2) { setErr(T('Passordene er ikke like.')); return; }
    try { await api('/auth/password', { body: { current: f.current, next: f.next } }); setOk(true); setTimeout(onDone, 900); }
    catch (x) { setErr(T((x as Error).message)); }
  }
  const form = (
    <form className={forced ? 'loginbox' : 'panelbox narrow'} onSubmit={submit}>
      {forced && <div className="loginhead"><Logo size={40} /></div>}
      <h2>{T('Bytt passord')}</h2>
      {forced && <p className="muted">{T('Du må velge et nytt passord før du fortsetter.')}</p>}
      <label htmlFor="pwCur">{T(forced ? 'Midlertidig passord' : 'Nåværende passord')}</label>
      <input id="pwCur" type="password" value={f.current} onChange={e => setF({ ...f, current: e.target.value })} required autoComplete="current-password" />
      <label htmlFor="pwNew">{T('Nytt passord')}</label>
      <input id="pwNew" type="password" value={f.next} onChange={e => setF({ ...f, next: e.target.value })} required autoComplete="new-password" />
      <label htmlFor="pwNew2">{T('Gjenta nytt passord')}</label>
      <input id="pwNew2" type="password" value={f.next2} onChange={e => setF({ ...f, next2: e.target.value })} required autoComplete="new-password" />
      <p className="hint">{T('Minst 12 tegn, med både bokstaver og tall. Andre pålogginger avsluttes.')}</p>
      <div className="row">
        <button className="btn" type="submit">{T('Lagre nytt passord')}</button>
        {onCancel && <button className="btn grey" type="button" onClick={onCancel}>{T('Avbryt')}</button>}
      </div>
      {err && <div className="err" role="alert">{err}</div>}
      {ok && <div className="okmsg">{T('Passordet er endret.')}</div>}
    </form>
  );
  return forced ? <div className="login">{form}</div> : form;
}
