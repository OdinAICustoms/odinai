import { useRef, useState } from 'react';
import { api } from '../api';
import { T, fmtDateTime } from '../i18n';

const toB64 = (f: File) => new Promise<string>((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(',')[1] ?? '');
  r.onerror = rej; r.readAsDataURL(f);
});

/** Choose a file and upload it to `path` (base64 in JSON, as the server expects). */
export function Upload({ label, path, docCode, onDone }: { label: string; path: string; docCode?: string; onDone: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false), [err, setErr] = useState('');
  const pick = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true); setErr('');
    try { await api(path, { body: { filename: f.name, mime: f.type || null, docCode, contentBase64: await toB64(f) } }); onDone(); }
    catch (x) { setErr((x as Error).message); } finally { setBusy(false); if (ref.current) ref.current.value = ''; }
  };
  return (
    <span className="upload">
      <label className="btn ghost small">{busy ? T('Laster opp …') : T(label)}<input ref={ref} type="file" hidden onChange={e => pick(e.target.files?.[0])} /></label>
      {err && <span className="bad"> {T(err)}</span>}
    </span>
  );
}

export function DocList({ docs, can, onChange }: { docs: any[]; can: boolean; onChange: () => void }) {
  if (!docs.length) return null;
  return (
    <ul className="doclist">{docs.map(x => <li key={x.id}>
      <a href={`/api/documents/${x.id}?inline=1`} target="_blank" rel="noopener noreferrer">📄 {x.filename}</a>
      <span className="muted"> {x.doc_code ? `${x.doc_code} · ` : ''}{Math.max(1, Math.round(x.size_bytes / 1024))} kB · {fmtDateTime(x.uploaded_at)}{x.uploaded_by_name ? ` · ${x.uploaded_by_name}` : ''}</span>
      {can && <button className="linkbtn" type="button" onClick={async () => { await api(`/documents/${x.id}/remove`, { body: {} }); onChange(); }}>{T('Fjern')}</button>}
    </li>)}</ul>
  );
}
