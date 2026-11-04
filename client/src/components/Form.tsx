import { useEffect, useState } from 'react';
import { api } from '../api';
import { T } from '../i18n';

/** A field description for the small forms on the partner and product cards. */
export interface FieldSpec {
  k: string; label: string;
  t?: 'text' | 'select' | 'check' | 'date' | 'country' | 'partner' | 'number' | 'textarea';
  opts?: Record<string, string>;          // value -> Norwegian label
  req?: boolean; wide?: boolean; ph?: string; hint?: string;
}

let countryCache: { code: string; name: string }[] | null = null;
export function useCountries() {
  const [c, setC] = useState(countryCache ?? []);
  useEffect(() => { if (!countryCache) api('/refdata/countries').then(r => { countryCache = r; setC(r); }).catch(() => {}); }, []);
  return c;
}

/** Search for a business partner by name / number; calls onPick with the chosen id. */
export function PartnerPicker({ id, value, onPick, exclude, placeholder }: { id: string; value?: string; onPick: (id: string, name: string) => void; exclude?: string; placeholder?: string }) {
  const [q, setQ] = useState(value ?? '');
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => {
    const t = setTimeout(() => { if (q.trim().length >= 2) api('/partners?q=' + encodeURIComponent(q)).then(r => setRows(r.filter((p: any) => p.id !== exclude))).catch(() => {}); }, 250);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <>
      <input id={id} list={id + '-list'} value={q} placeholder={placeholder ?? T('Søk navn eller organisasjonsnummer')} autoComplete="off"
        onChange={e => { setQ(e.target.value); const hit = rows.find(r => `${r.legal_name} · ${r.partner_no}` === e.target.value); if (hit) onPick(hit.id, hit.legal_name); }} />
      <datalist id={id + '-list'}>{rows.map(r => <option key={r.id} value={`${r.legal_name} · ${r.partner_no}`}>{r.org_no || r.eori || ''}</option>)}</datalist>
    </>
  );
}

/** A grid of fields bound to one object. */
export function Fields({ spec, value, onChange, idPrefix }: { spec: FieldSpec[]; value: Record<string, any>; onChange: (v: Record<string, any>) => void; idPrefix: string }) {
  const countries = useCountries();
  const set = (k: string, v: unknown) => onChange({ ...value, [k]: v });
  return (
    <div className="formgrid">
      {spec.map(f => {
        const id = `${idPrefix}-${f.k}`, v = value[f.k] ?? '';
        if (f.t === 'check') return <label key={f.k} className="chk fcheck"><input id={id} type="checkbox" checked={!!value[f.k]} onChange={e => set(f.k, e.target.checked)} /> {T(f.label)}</label>;
        return (
          <div key={f.k} className={f.wide ? 'fwide' : ''}>
            <label htmlFor={id}>{T(f.label)}{f.req ? ' *' : ''}</label>
            {f.t === 'select' ? <select id={id} value={v} onChange={e => set(f.k, e.target.value)}>
                {!f.req && <option value="">—</option>}{Object.entries(f.opts ?? {}).map(([k, l]) => <option key={k} value={k}>{T(l)}</option>)}</select>
              : f.t === 'country' ? <select id={id} value={v} onChange={e => set(f.k, e.target.value)}>
                <option value="">—</option>{countries.map(c => <option key={c.code} value={c.code}>{c.code} – {c.name}</option>)}</select>
              : f.t === 'partner' ? <PartnerPicker id={id} onPick={pid => set(f.k, pid)} />
              : f.t === 'textarea' ? <textarea id={id} value={v} onChange={e => set(f.k, e.target.value)} rows={3} />
              : <input id={id} type={f.t === 'date' ? 'date' : 'text'} inputMode={f.t === 'number' ? 'decimal' : undefined} value={v ?? ''} placeholder={f.ph} onChange={e => set(f.k, e.target.value)} />}
            {f.hint && <p className="hint">{T(f.hint)}</p>}
          </div>
        );
      })}
    </div>
  );
}

/** Server answers carry warnings (yellow) next to the result; errors arrive as thrown messages. */
export function Findings({ warnings, error }: { warnings?: { msg: string }[]; error?: string }) {
  return <>{error && <div className="err" role="alert">{T(error)}</div>}
    {warnings?.map((w, i) => <div key={i} className="warnmsg">{T(w.msg)}</div>)}</>;
}
