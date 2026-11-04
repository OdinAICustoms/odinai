import { useEffect, useState } from 'react';
import { api, type Me } from '../../api';
import { T } from '../../i18n';

export function Settings({ me }: { me: Me }) {
  const [s, setS] = useState<{ four_eyes?: boolean; default_lang?: string }>({});
  const [msg, setMsg] = useState('');
  const can = me.perms.includes('settings.edit');
  useEffect(() => { api('/admin/settings').then(setS); }, []);
  const save = async (patch: object) => {
    try { setS(await api('/admin/settings', { method: 'PUT', body: patch })); setMsg(T('Lagret.')); setTimeout(() => setMsg(''), 1800); }
    catch (x) { setMsg(T((x as Error).message)); }
  };
  return (
    <section>
      <div className="pagehead"><h2>{T('Innstillinger')}</h2>{msg && <span className="okmsg inline">{msg}</span>}</div>
      <div className="panelbox">
        <h3>{T('Godkjenning')}</h3>
        <label className="chk"><input type="checkbox" checked={!!s.four_eyes} disabled={!can} onChange={e => save({ four_eyes: e.target.checked })} />
          {T('Fire øyne: en annen bruker enn den som sendte til godkjenning må godkjenne')}</label>
        <p className="hint">{T('Slå av bare på dager med én person på kontoret. Endringen logges.')}</p>
      </div>
      <div className="panelbox">
        <h3>{T('Språk')}</h3>
        <label htmlFor="sLang">{T('Standardspråk for nye brukere og innloggingssiden')}</label>
        <select id="sLang" value={s.default_lang || 'no'} disabled={!can} onChange={e => save({ default_lang: e.target.value })}>
          <option value="no">Norsk</option><option value="en">English</option>
        </select>
      </div>
    </section>
  );
}
