import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type Me } from '../../api';
import { T, fmtDateTime, locale } from '../../i18n';
import { Findings, PartnerPicker } from '../../components/Form';

/** Status → Norwegian label and pill colour. */
export const DSTATUS: Record<string, [string, string]> = {
  DRAFT: ['Utkast', 'info'], SUBMITTED: ['Til godkjenning', 'submitted'], RETURNED: ['Returnert', 'rejected'], APPROVED: ['Godkjent', 'submitted'],
  SENT: ['Sendt', 'submitted'], ACCEPTED: ['Akseptert', 'accepted'], REJECTED: ['Avvist', 'rejected'], CANCELLED: ['Kansellert', 'cancelled']
};
export const dPill = (s: string) => <span className={`pill ${DSTATUS[s]?.[1] ?? ''}`}>{T(DSTATUS[s]?.[0] ?? s)}</span>;
export const fmtDate = (v: string | null | undefined) => (v ? new Date(v + 'T00:00:00').toLocaleDateString(locale()) : '');
export const fmtAmount = (v: unknown, digits = 2) => (v == null || v === '' ? '' : Number(v).toLocaleString(locale(), { minimumFractionDigits: digits, maximumFractionDigits: digits }));

const VIEWS: [string, string, string][] = [['open', 'Under arbeid', 'DRAFT,RETURNED'], ['waiting', 'Til godkjenning', 'SUBMITTED,APPROVED'], ['sent', 'Sendt og besvart', 'SENT,ACCEPTED,REJECTED'], ['all', 'Alle', '']];

export function DeclarationList({ me }: { me: Me }) {
  const nav = useNavigate();
  const [rows, setRows] = useState<any[]>([]);
  const [view, setView] = useState('open');
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    const status = VIEWS.find(v => v[0] === view)![2];
    const p = new URLSearchParams({ ...(status ? { status } : { all: '1' }), ...(q.trim() ? { q: q.trim() } : {}) });
    const t = setTimeout(() => api('/declarations?' + p).then(setRows).catch(() => setRows([])), 200);
    return () => clearTimeout(t);
  }, [view, q]);
  return (
    <section>
      <div className="pagehead"><h2>{T('Innførselsdeklarasjoner')}</h2><span className="spacer" />
        {me.perms.includes('declaration.edit') && <button className="btn add" type="button" onClick={() => setAdding(true)}>{T('+ Ny deklarasjon')}</button>}</div>
      {adding && <NewDeclaration onDone={id => nav(`/declarations/${id}`)} onCancel={() => setAdding(false)} />}
      <div className="tabs" role="tablist">{VIEWS.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={view === k} className={view === k ? 'on' : ''} onClick={() => setView(k)}>{T(l)}</button>)}</div>
      <div className="filters"><input value={q} onChange={e => setQ(e.target.value)} placeholder={T('Søk deklarasjonsnr., referanse, part, varebeskrivelse, varenummer')} aria-label={T('Søk')} style={{ flex: 1, minWidth: 260 }} /></div>
      <div className="tblwrap"><table className="t">
        <thead><tr><th>{T('Deklarasjon')}</th><th>{T('Status')}</th><th>{T('Dato')}</th><th>{T('Klient')}</th><th>{T('Avsender')}</th><th>{T('Referanse')}</th>
          <th className="num">{T('Vareposter')}</th><th className="num">{T('Fakturabeløp')}</th><th>{T('Sist endret')}</th></tr></thead>
        <tbody>{rows.map(d => <tr key={d.id} className="click" onClick={() => nav(`/declarations/${d.id}`)}>
          <td className="mono nowrap"><b>{d.decl_no}</b>{d.created_from === 'AI' && <span className="pill info" style={{ marginLeft: 6 }}>AI</span>}</td>
          <td>{dPill(d.status)}</td><td className="nowrap">{fmtDate(d.decl_date)}</td><td>{d.client_name ?? d.importer_name ?? <span className="muted">—</span>}</td>
          <td>{d.exporter_name ?? <span className="muted">—</span>}</td><td className="muted">{d.own_ref}</td><td className="num">{d.item_count}</td>
          <td className="num nowrap">{d.invoice_total != null ? `${fmtAmount(d.invoice_total)} ${d.currency ?? ''}` : ''}</td>
          <td className="muted nowrap">{fmtDateTime(d.updated_at)}{d.updated_by_name ? ` · ${d.updated_by_name}` : ''}</td>
        </tr>)}
        {!rows.length && <tr><td colSpan={9} className="muted">{T('Ingen deklarasjoner.')}</td></tr>}</tbody>
      </table></div>
    </section>
  );
}

function NewDeclaration({ onDone, onCancel }: { onDone: (id: string) => void; onCancel: () => void }) {
  const [importer, setImporter] = useState(''), [ref, setRef] = useState(''), [err, setErr] = useState('');
  const save = async (e: FormEvent) => {
    e.preventDefault(); setErr('');
    try { const r = await api('/declarations', { body: { importer_id: importer || undefined, own_ref: ref || undefined } }); onDone(r.id); } catch (x) { setErr((x as Error).message); }
  };
  return (
    <form className="panelbox" onSubmit={save}>
      <h3>{T('Ny innførselsdeklarasjon')}</h3>
      <div className="formgrid">
        <div><label htmlFor="nd-imp">{T('Mottaker / importør (rubrikk 8)')}</label><PartnerPicker id="nd-imp" onPick={id => setImporter(id)} /></div>
        <div><label htmlFor="nd-ref">{T('Egen referanse (rubrikk 7)')}</label><input id="nd-ref" value={ref} onChange={e => setRef(e.target.value)} /></div>
      </div>
      <p className="hint">{T('Odin fylles inn som deklarant (rubrikk 14), dagens dato i rubrikk 54 og deklarasjonstype 4. Alt kan endres i deklarasjonen.')}</p>
      <div className="row"><button className="btn add" type="submit">{T('Opprett utkast')}</button><button className="btn grey" type="button" onClick={onCancel}>{T('Avbryt')}</button></div>
      <Findings error={err} />
    </form>
  );
}
