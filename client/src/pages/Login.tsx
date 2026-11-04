import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { T, type Lang } from '../i18n';
import { Logo } from '../components/Logo';

/** Sign in; on a new installation the same page creates the first administrator. */
export function Login({ onSignedIn, lang, onLang }: { onSignedIn: () => void; lang: Lang; onLang: (l: Lang) => void }) {
  const [setup, setSetup] = useState<boolean | null>(null);
  const [f, setF] = useState({ name: '', email: '', password: '', password2: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api('/auth/config').then(c => setSetup(c.setupNeeded)).catch(() => setSetup(false)); }, []);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault(); setErr('');
    if (setup && f.password !== f.password2) { setErr(T('Passordene er ikke like.')); return; }
    setBusy(true);
    try {
      if (setup) await api('/auth/setup', { body: { name: f.name, email: f.email, password: f.password } });
      else await api('/auth/login', { body: { email: f.email, password: f.password } });
      onSignedIn();
    } catch (x) { setErr(T((x as Error).message)); } finally { setBusy(false); }
  }

  return (
    <div className="login">
      <form className="loginbox" onSubmit={submit}>
        <div className="loginhead"><Logo size={40} />
          <div className="langsw small">{(['no', 'en'] as Lang[]).map(l => <button key={l} type="button" className={lang === l ? 'on' : ''} onClick={() => onLang(l)}>{l.toUpperCase()}</button>)}</div>
        </div>
        <p className="muted">{setup ? T('Ny installasjon: opprett den første administratoren.') : T('Tolldeklarasjoner med AI — ODIN CUSTOMS AS')}</p>
        {setup && <><label htmlFor="liName">{T('Navn')}</label><input id="liName" value={f.name} onChange={set('name')} required autoComplete="name" /></>}
        <label htmlFor="liEmail">{T('E-post')}</label>
        <input id="liEmail" type="email" value={f.email} onChange={set('email')} required autoComplete="username" />
        <label htmlFor="liPass">{T('Passord')}</label>
        <input id="liPass" type="password" value={f.password} onChange={set('password')} required autoComplete={setup ? 'new-password' : 'current-password'} />
        {setup && <><label htmlFor="liPass2">{T('Gjenta passord')}</label><input id="liPass2" type="password" value={f.password2} onChange={set('password2')} required autoComplete="new-password" />
          <p className="hint">{T('Minst 12 tegn, med både bokstaver og tall.')}</p></>}
        <button className="btn wide" type="submit" disabled={busy || setup === null}>{setup ? T('Opprett administrator') : T('Logg inn')}</button>
        {err && <div className="err" role="alert">{err}</div>}
      </form>
    </div>
  );
}
