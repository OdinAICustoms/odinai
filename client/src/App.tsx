import { useCallback, useEffect, useState } from 'react';
import { BrowserRouter, Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { api, type Me } from './api';
import { T, getLang, setLang, type Lang } from './i18n';
import { Logo } from './components/Logo';
import { Login } from './pages/Login';
import { ChangePassword } from './pages/ChangePassword';
import { Upcoming } from './pages/Upcoming';
import { Users } from './pages/admin/Users';
import { Audit } from './pages/admin/Audit';
import { Settings } from './pages/admin/Settings';

/** The modules in the dark-blue band; each lists its functions for the light-blue band. */
const MODULES = [
  { path: '/ai', label: 'AI-deklarasjoner', icon: 'doc', phase: 2, sub: [] as [string, string][] },
  { path: '/partners', label: 'Forretningspartnere', icon: 'org', phase: 1, sub: [] },
  { path: '/products', label: 'Produkter', icon: 'box', phase: 1, sub: [] },
  { path: '/invoicing', label: 'Fakturering', icon: 'bill', phase: 4, sub: [] },
  { path: '/admin', label: 'Administrasjon', icon: 'lock', perm: 'users.manage', sub: [['/admin/users', 'Brukere'], ['/admin/audit', 'Endringslogg'], ['/admin/settings', 'Innstillinger']] as [string, string][] }
];

export default function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [, rerender] = useState(0);
  const load = useCallback(async () => {
    try {
      const m = await api<Me>('/auth/me');
      if (m.lang !== getLang()) setLang(m.lang);
      setMe(m);
    } catch { setMe(null); }
  }, []);
  useEffect(() => {
    load();
    const out = () => setMe(null), pw = () => setMe(m => (m ? { ...m, mustChange: true } : m));
    window.addEventListener('odinai:signed-out', out); window.addEventListener('odinai:pw-change', pw);
    return () => { window.removeEventListener('odinai:signed-out', out); window.removeEventListener('odinai:pw-change', pw); };
  }, [load]);

  const changeLang = async (l: Lang) => {
    setLang(l); rerender(n => n + 1);
    if (me) { try { await api('/me/lang', { method: 'PUT', body: { lang: l } }); setMe({ ...me, lang: l }); } catch { /* kept locally */ } }
  };

  if (me === undefined) return <div className="boot"><Logo size={40} /></div>;
  if (me === null) return <Login onSignedIn={load} lang={getLang()} onLang={changeLang} />;
  if (me.mustChange) return <ChangePassword forced onDone={load} />;
  return (
    <BrowserRouter>
      <Shell me={me} onLang={changeLang} onSignOut={async () => { await api('/auth/logout', { body: {} }).catch(() => {}); setMe(null); }} />
    </BrowserRouter>
  );
}

function Shell({ me, onLang, onSignOut }: { me: Me; onLang: (l: Lang) => void; onSignOut: () => void }) {
  const loc = useLocation();
  const mods = MODULES.filter(m => !m.perm || me.perms.includes(m.perm) || (m.path === '/admin' && me.perms.includes('audit.read')));
  const active = mods.find(m => loc.pathname.startsWith(m.path));
  const [pw, setPw] = useState(false);
  return (
    <div className="app">
      <header className="topbar">
        <div className="tb1">
          <Logo />
          <span className="lsep" /><span className="lsub">{T('Tolldeklarasjoner med AI')}</span>
          <div className="right">
            <span className="chip green">{T('Lokal versjon')}</span>
            <span className="who">{me.name}</span>
            <div className="langsw" role="group" aria-label={T('Språk')}>
              {(['no', 'en'] as Lang[]).map(l => <button key={l} type="button" className={getLang() === l ? 'on' : ''} onClick={() => onLang(l)}>{l.toUpperCase()}</button>)}
            </div>
            <button type="button" className="linkbtn" onClick={() => setPw(true)}>{T('Bytt passord')}</button>
            <button type="button" className="linkbtn" onClick={onSignOut}>{T('Logg ut')}</button>
          </div>
        </div>
        <nav className="tb2" aria-label={T('Moduler')}>
          {mods.map(m => <NavLink key={m.path} to={m.sub[0]?.[0] ?? m.path} className={() => `nav i-${m.icon}${active === m ? ' active' : ''}`}>{T(m.label)}</NavLink>)}
        </nav>
        <div className="tb3">
          {active?.sub.map(([p, l]) => <NavLink key={p} to={p} className={({ isActive }) => (isActive ? 'on' : '')}>{T(l)}</NavLink>)}
        </div>
      </header>
      <main className="page">
        {pw ? <ChangePassword onDone={() => setPw(false)} onCancel={() => setPw(false)} /> : (
          <Routes>
            <Route path="/" element={<Navigate to="/ai" replace />} />
            {MODULES.filter(m => m.phase).map(m => <Route key={m.path} path={m.path + '/*'} element={<Upcoming title={m.label} phase={m.phase!} />} />)}
            <Route path="/admin" element={<Navigate to={me.perms.includes('users.manage') ? '/admin/users' : '/admin/audit'} replace />} />
            <Route path="/admin/users" element={<Users me={me} />} />
            <Route path="/admin/audit" element={<Audit />} />
            <Route path="/admin/settings" element={<Settings me={me} />} />
            <Route path="*" element={<Navigate to="/ai" replace />} />
          </Routes>
        )}
      </main>
    </div>
  );
}
