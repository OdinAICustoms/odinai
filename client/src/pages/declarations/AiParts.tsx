import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '../../api';
import { T, fmtDateTime } from '../../i18n';
import { Findings, PartnerPicker } from '../../components/Form';

const toB64 = (f: File) => new Promise<string>((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(',')[1] ?? '');
  r.onerror = rej; r.readAsDataURL(f);
});
const KINDS: [string, string][] = [['N380', 'Faktura'], ['N271', 'Pakkliste'], ['EXP', 'Utførselsdeklarasjon'], ['T1', 'Transittdokument (T1)'], ['N730', 'Fraktbrev / CMR'], ['', 'Annet']];
const guess = (name: string) => (/pakk|packing|pack[-_ ]?list|\bpl\b/i.test(name) ? 'N271' : /cmr|fraktbrev|waybill|\bbl\b|lading/i.test(name) ? 'N730'
  : /\bt1\b|transit/i.test(name) ? 'T1' : /export|eksport|utf(ø|o)rsel|\bead\b/i.test(name) ? 'EXP' : /ched|coa|certific|sertifikat|\beia\b|\bhc\b/i.test(name) ? '' : 'N380');

/** New declaration from documents: the AI reads them in the background, the editor shows the result. */
export function NewFromDocuments({ onDone, onCancel }: { onDone: (id: string) => void; onCancel: () => void }) {
  const [ai, setAi] = useState<{ configured: boolean; model: string } | null>(null);
  const [files, setFiles] = useState<{ file: File; code: string }[]>([]);
  const [importer, setImporter] = useState(''), [ref, setRef] = useState(''), [busy, setBusy] = useState(false), [err, setErr] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { api('/ai/status').then(setAi).catch(() => setAi({ configured: false, model: '' })); }, []);
  const save = async (e: FormEvent) => {
    e.preventDefault(); setErr(''); setBusy(true);
    try {
      const body = { importer_id: importer || undefined, own_ref: ref || undefined,
        files: await Promise.all(files.map(async f => ({ filename: f.file.name, mime: f.file.type || null, docCode: f.code || undefined, contentBase64: await toB64(f.file) }))) };
      const r = await api('/declarations/ai', { body });
      onDone(r.id);
    } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  };
  if (ai && !ai.configured) return <div className="panelbox"><h3>{T('Ny deklarasjon fra dokumenter')}</h3>
    <div className="warnmsg">{T('AI-tjenesten er ikke satt opp. Legg inn ANTHROPIC_API_KEY i .env-filen i C:\\OdinAI og start OdinAi på nytt.')}</div>
    <div className="row"><button className="btn grey" type="button" onClick={onCancel}>{T('Lukk')}</button></div></div>;
  return (
    <form className="panelbox" onSubmit={save}>
      <h3>{T('Ny deklarasjon fra dokumenter')}</h3>
      <p className="hint" style={{ marginTop: 0 }}>{T('Last opp faktura, pakkliste og eventuelt utførselsdeklarasjon eller T1 for samme sending. AI-en leser dem, og utkastet bygges fra Forretningspartner og Produktregisteret først. Alt du må se på, blir kontrollpunkter.')}</p>
      <div className="formgrid">
        <div><label htmlFor="ai-imp">{T('Mottaker / importør (rubrikk 8)')}</label><PartnerPicker id="ai-imp" onPick={id => setImporter(id)} placeholder={T('Valgfritt — ellers fra fakturaen')} /></div>
        <div><label htmlFor="ai-ref">{T('Egen referanse (rubrikk 7)')}</label><input id="ai-ref" value={ref} onChange={e => setRef(e.target.value)} placeholder={T('Valgfritt — ellers fakturanummeret')} /></div>
      </div>
      <label>{T('Dokumenter')}</label>
      <div className="docrows">
        {files.map((f, i) => <div key={i} className="docrow">
          <span className="mono">📄 {f.file.name} <span className="muted">{Math.max(1, Math.round(f.file.size / 1024))} kB</span></span>
          <select aria-label={T('Dokumenttype')} value={f.code} onChange={e => setFiles(files.map((x, n) => (n === i ? { ...x, code: e.target.value } : x)))}>
            {KINDS.map(([k, l]) => <option key={k} value={k}>{T(l)}</option>)}</select>
          <span />
          <button type="button" className="linkbtn" onClick={() => setFiles(files.filter((_, n) => n !== i))}>{T('Fjern')}</button>
        </div>)}
        <label className="btn ghost small" style={{ justifySelf: 'start' }}>{T('+ Velg filer')}
          <input ref={input} type="file" multiple hidden accept="application/pdf,image/jpeg,image/png,image/webp,text/csv,text/plain"
            onChange={e => { setFiles([...files, ...[...(e.target.files ?? [])].map(file => ({ file, code: guess(file.name) }))]); if (input.current) input.current.value = ''; }} /></label>
      </div>
      <p className="hint">{T('PDF, bilde (JPG, PNG) eller CSV. Dokumentene lagres på deklarasjonen og sendes til AI-tjenesten bare hvis klienten ikke har reservert seg.')}{ai ? ` ${T('Modell')}: ${ai.model}.` : ''}</p>
      <div className="row"><button className="btn add" type="submit" disabled={!files.length || busy}>{busy ? T('Laster opp …') : T('Les dokumentene og lag utkast')}</button>
        <button className="btn grey" type="button" onClick={onCancel}>{T('Avbryt')}</button></div>
      <Findings error={err} />
    </form>
  );
}

const SOURCE: Record<string, string> = { PRODUCT: 'produktregisteret', INVOICE: 'fakturaen', DOCUMENT: 'dokumentene', NONE: 'mangler' };
/** Where a goods item's values came from (AI intake). */
export function ItemSource({ s }: { s: any }) {
  if (!s?.fields) return null;
  const f = s.fields;
  return <p className="hint aisource">🤖 {T('Lest av AI')}{s.document ? ` · ${T('dokument')} ${s.document}${s.page ? `, ${T('side')} ${s.page}` : ''}` : ''} · {T('sikkerhet')} {Math.round((s.confidence ?? 0) * 100)} % ·{' '}
    {T('beskrivelse fra')} {T(SOURCE[f.description] ?? f.description)}, {T('varenummer fra')} {T(SOURCE[f.code] ?? f.code)}, {T('opprinnelse fra')} {T(SOURCE[f.origin] ?? f.origin)}
    {s.read?.hs_code ? ` · ${T('fakturaen viser varenummer')} ${s.read.hs_code}` : ''}</p>;
}

/** The AI reading of this declaration: status, a new run, and the review points to clear. */
export function AiPanel({ d, can, act, onReload, onGoto }: { d: any; can: boolean; act: (fn: () => Promise<any>, msg?: string) => Promise<any>; onReload: () => void; onGoto: (line: number | null, box?: string) => void }) {
  const last = d.intakes?.[0];
  const busy = last && ['QUEUED', 'RUNNING'].includes(last.status);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [showCleared, setShowCleared] = useState(false);
  useEffect(() => { if (!busy) return; const t = setInterval(onReload, 2500); return () => clearInterval(t); }, [busy]);
  const open = (d.reviews ?? []).filter((r: any) => r.status === 'OPEN');
  const cleared = (d.reviews ?? []).filter((r: any) => r.status === 'CLEARED');
  const canRun = can && d.direction !== 'EXPORT' && d.ai?.configured && !busy && !d.items.length && d.documents.length > 0;
  if (!last && !canRun) return null;
  return (
    <div className="panelbox aipanel" id="sec-ai" tabIndex={-1}>
      <div className="row" style={{ marginTop: 0, alignItems: 'center' }}>
        <h3 style={{ margin: 0 }}>🤖 {T('AI-lesing')}</h3>
        {last && <span className={`pill ${last.status === 'DONE' ? 'accepted' : last.status === 'FAILED' ? 'rejected' : 'submitted'}`}>
          {T(({ QUEUED: 'I kø', RUNNING: 'Leser dokumentene …', DONE: 'Ferdig', FAILED: 'Feilet' } as Record<string, string>)[last.status])}</span>}
        {last && <span className="muted">{last.documents} {T('dokumenter')} · {last.model} · {fmtDateTime(last.finished_at ?? last.started_at ?? last.created_at)}</span>}
        <span className="spacer" />
        {canRun && <button className="btn add small" type="button" onClick={() => act(() => api(`/declarations/${d.id}/ai`, { body: {} }), T('AI-lesingen er startet.'))}>
          {last ? T('Les dokumentene på nytt') : T('Les dokumentene med AI')}</button>}
      </div>
      {busy && <p className="hint">{T('Dokumentene leses i bakgrunnen. Det tar vanligvis et halvt til to minutter; siden oppdateres av seg selv.')}</p>}
      {last?.status === 'FAILED' && <div className="err">{T(last.error ?? 'AI-lesingen feilet.')}</div>}
      {open.length > 0 && <>
        <p className="hint">{open.length} {T('kontrollpunkter må avklares før innsending.')}</p>
        <ul className="reviews">{open.map((r: any) => <li key={r.id}>
          <div className="rmsg">{r.line_no ? <button type="button" className="linkbtn" onClick={() => onGoto(r.line_no)}><span className="boxno">{r.line_no}</span></button>
            : r.data?.box ? <button type="button" className="linkbtn" onClick={() => onGoto(null, r.data.box)}><span className="boxno">{r.data.box}</span></button> : null}{T(r.msg)}</div>
          {can && <div className="ractions">
            {r.kind === 'PARTY_UNKNOWN' && <button type="button" className="btn ghost small" onClick={() => act(() => api(`/declarations/${d.id}/reviews/${r.id}/create-partner`, { body: {} }), T('Partneren er opprettet og satt inn.'))}>{T('Opprett partner')}</button>}
            <input aria-label={T('Merknad')} placeholder={T('Merknad (valgfri)')} value={notes[r.id] ?? ''} onChange={e => setNotes({ ...notes, [r.id]: e.target.value })} />
            <button type="button" className="btn small" onClick={() => act(() => api(`/declarations/${d.id}/reviews/${r.id}/clear`, { body: { note: notes[r.id] ?? '' } }))}>{T('Avklart')}</button>
          </div>}
        </li>)}</ul>
      </>}
      {last?.status === 'DONE' && !open.length && <div className="okmsg">{T('Alle kontrollpunkter er avklart.')}</div>}
      {cleared.length > 0 && <p className="hint"><button type="button" className="linkbtn" onClick={() => setShowCleared(!showCleared)}>{showCleared ? T('Skjul avklarte') : `${T('Vis avklarte')} (${cleared.length})`}</button></p>}
      {showCleared && <ul className="reviews done">{cleared.map((r: any) => <li key={r.id}><div className="rmsg">{T(r.msg)}</div>
        <div className="ractions muted">{r.cleared_by_name} · {fmtDateTime(r.cleared_at)}{r.clear_note ? ` · ${r.clear_note}` : ''}
          {can && <button type="button" className="linkbtn" onClick={() => act(() => api(`/declarations/${d.id}/reviews/${r.id}/reopen`, { body: {} }))}>{T('Åpne igjen')}</button>}</div></li>)}</ul>}
    </div>
  );
}
