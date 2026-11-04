import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, type Me } from '../../api';
import { T, fmtDateTime, locale } from '../../i18n';

interface DS { id: string; label: string; source: string; rows: number; running: boolean; lastOkAt: string | null;
  last: { status: string; startedAt: string; finishedAt: string | null; rowsWritten: number | null; message: string | null } | null }
const PILL: Record<string, string> = { OK: 'accepted', RUNNING: 'submitted', FAILED: 'rejected', REFUSED: 'rejected' };
const STATUS: Record<string, string> = { OK: 'OK', RUNNING: 'Oppdateres', FAILED: 'Feilet', REFUSED: 'Avvist' };
const nf = (n: number) => n.toLocaleString(locale());
const age = (iso: string | null) => (iso ? (Date.now() - new Date(iso).getTime()) / 3600e3 : Infinity);

/** Status of every dataset loaded from Tolletaten and Posten, refresh, and a tariff lookup. */
export function RefData({ me }: { me: Me }) {
  const [list, setList] = useState<DS[]>([]);
  const [err, setErr] = useState('');
  const timer = useRef<number>();
  const can = me.perms.includes('settings.edit');
  const load = async () => {
    try {
      const l: DS[] = await api('/refdata/status'); setList(l);
      clearTimeout(timer.current);
      if (l.some(d => d.running || d.last?.status === 'RUNNING')) timer.current = window.setTimeout(load, 2000);
    } catch (x) { setErr(T((x as Error).message)); }
  };
  useEffect(() => { load(); return () => clearTimeout(timer.current); }, []);
  const refresh = async (dataset?: string) => {
    setErr('');
    try { await api('/refdata/refresh', { body: dataset ? { dataset } : {} }); setTimeout(load, 400); } catch (x) { setErr(T((x as Error).message)); }
  };

  return (
    <section>
      <div className="pagehead"><h2>{T('Referansedata')}</h2><span className="spacer" />
        {can && <button className="btn" type="button" onClick={() => refresh()} disabled={list.some(d => d.running)}>{T('Oppdater alt nå')}</button>}</div>
      <p className="muted lead">{T('Lastes automatisk hver dag kl. 05.30 fra Tolletatens åpne data (data.toll.no) og Postens postnummerregister. En oppdatering som feiler eller gir langt færre rader enn i dag, endrer ingenting.')}</p>
      {err && <div className="err">{err}</div>}
      <div className="tblwrap"><table className="t">
        <thead><tr><th>{T('Datasett')}</th><th>{T('Kilde')}</th><th className="r">{T('Rader')}</th><th>{T('Sist oppdatert')}</th><th>{T('Siste kjøring')}</th><th /></tr></thead>
        <tbody>{list.map(d => {
          const st = d.running ? 'RUNNING' : d.last?.status;
          return <tr key={d.id}>
            <td><b>{T(d.label)}</b></td><td className="muted">{d.source}</td><td className="r">{nf(d.rows)}</td>
            <td>{d.lastOkAt ? fmtDateTime(d.lastOkAt) : <span className="pill rejected">{T('Aldri lastet')}</span>}
              {d.lastOkAt && age(d.lastOkAt) > 36 && <span className="pill submitted" style={{ marginLeft: 6 }}>{T('Eldre enn ett døgn')}</span>}</td>
            <td>{st ? <span className={`pill ${PILL[st] ?? ''}`}>{T(STATUS[st] ?? st)}</span> : '—'}
              {d.last?.message && <div className="hint" style={{ maxWidth: 420 }}>{T(d.last.message)}</div>}</td>
            <td className="r">{can && <button className="linkbtn" type="button" disabled={d.running} onClick={() => refresh(d.id)}>{T('Oppdater')}</button>}</td>
          </tr>;
        })}</tbody>
      </table></div>
      <TariffLookup />
    </section>
  );
}

function TariffLookup() {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<any[]>([]);
  const [sel, setSel] = useState<any>(null);
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const search = async (e?: FormEvent) => { e?.preventDefault(); setSel(null); setHits(q.trim() ? await api('/refdata/tariff?q=' + encodeURIComponent(q)) : []); };
  const open = async (code: string) => { try { setSel(await api(`/refdata/tariff/${code}?date=${date}`)); } catch { setSel(null); } };
  useEffect(() => { if (sel) open(sel.code); }, [date]);
  const fmt = (v: string | null) => (v == null ? '—' : Number(v).toLocaleString(locale(), { maximumFractionDigits: 4 }));
  return (
    <div className="panelbox">
      <h3>{T('Slå opp i tolltariffen')}</h3>
      <form className="filters" onSubmit={search}>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder={T('Varenummer (f.eks. 2103 90) eller ord (f.eks. sjokolade)')} aria-label={T('Søk i tolltariffen')} style={{ flex: 1, minWidth: 240 }} />
        <input type="date" value={date} onChange={e => setDate(e.target.value)} aria-label={T('Dato')} />
        <button className="btn" type="submit">{T('Søk')}</button>
      </form>
      {!sel && hits.length > 0 && <div className="tblwrap"><table className="t"><tbody>{hits.map(h =>
        <tr key={h.code} className="click" onClick={() => open(h.code)}><td className="mono nowrap">{h.display}</td><td>{h.level === 'Code' ? '' : <span className="chip">{T(h.level)}</span>}{h.path_text || h.text}</td></tr>)}</tbody></table></div>}
      {sel && <div>
        <button className="linkbtn" style={{ marginLeft: 0 }} type="button" onClick={() => setSel(null)}>← {T('Tilbake til treffene')}</button>
        <h3 style={{ marginTop: 10 }}><span className="mono">{sel.display}</span> {sel.text}</h3>
        <p className="muted">{sel.ancestors.map((a: any) => `${a.display} ${a.text ?? ''}`).join(' › ')}{sel.supp_unit ? ` · ${T('Annen enhet')}: ${sel.supp_unit}` : ''}{sel.rtRequired ? ' · RT100' : ''}</p>
        <p className="hint">{T('Tariffteksten er et hjelpemiddel for klassifisering og skal ikke brukes som varebeskrivelse i rubrikk 31.')}</p>
        <div className="grid2">
          <div><b>{T('Satser')} {new Date(date).toLocaleDateString(locale())}</b>
            <div className="tblwrap"><table className="t"><thead><tr><th>{T('Avgift')}</th><th>{T('Landgruppe')}</th><th className="r">{T('Sats')}</th></tr></thead>
              <tbody>{sel.rates.map((r: any) => <tr key={r.duty_code + r.landgruppe}><td>{r.duty_code}</td><td title={r.landgruppe_name}>{r.landgruppe}</td>
                <td className="r">{fmt(r.rate_value)} {r.rate_unit === 'PERCENT' ? '%' : r.unit_text}</td></tr>)}
                {!sel.rates.length && <tr><td colSpan={3} className="muted">{T('Ingen satser på datoen.')}</td></tr>}</tbody></table></div></div>
          <div><b>{T('Restriksjoner')}</b>
            <div className="tblwrap"><table className="t"><thead><tr><th>{T('Type')}</th><th>{T('Gjelder')}</th><th>{T('Landgruppe')}</th></tr></thead>
              <tbody>{sel.restrictions.map((r: any) => <tr key={r.id}><td>{r.restriction_code} {r.restriction_group_text}{r.document_code ? <span className="chip">{r.document_code}</span> : null}</td><td>{r.applies_to}</td><td>{r.landgruppe}</td></tr>)}
                {!sel.restrictions.length && <tr><td colSpan={3} className="muted">{T('Ingen restriksjoner.')}</td></tr>}</tbody></table></div></div>
        </div>
      </div>}
    </div>
  );
}
