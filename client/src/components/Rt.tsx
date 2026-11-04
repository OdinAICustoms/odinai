import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { T, locale } from '../i18n';
import { Fields, Findings, PartnerPicker } from './Form';
import { DocList, Upload } from './Docs';

/** RT permits: the same records and the same panel on the product card, the client card and the RT list. */
export const RT_STATUS: Record<string, [string, string]> = {
  VALID: ['Gyldig', 'accepted'], EXPIRING: ['Utløper snart', 'submitted'], EXPIRED: ['Utløpt', 'rejected'],
  NOT_YET_VALID: ['Ikke gyldig ennå', 'info'], INACTIVE: ['Trukket tilbake', 'cancelled']
};
export const rtPill = (s: string) => <span className={`pill ${RT_STATUS[s]?.[1] ?? ''}`}>{T(RT_STATUS[s]?.[0] ?? s)}</span>;
const d = (v: string | null) => (v ? new Date(v + 'T00:00:00').toLocaleDateString(locale()) : '');
const kr = (v: string | null) => (v == null ? '—' : Number(v).toLocaleString(locale(), { minimumFractionDigits: 2, maximumFractionDigits: 4 }));
const code = (c: string | null) => (c && c.length === 8 ? `${c.slice(0, 4)} ${c.slice(4, 6)} ${c.slice(6)}` : c ?? '');

/** One permit: both variants, holder, validity, case, decision letter, checks. */
export function RtPermitView({ r, can, onChange, showProduct = true, showHolder = true }: { r: any; can: boolean; onChange: () => void; showProduct?: boolean; showHolder?: boolean }) {
  const nav = useNavigate();
  const [edit, setEdit] = useState<Record<string, any> | null>(null);
  const [err, setErr] = useState(''), [warn, setWarn] = useState<any[]>([]);
  const [withdraw, setWithdraw] = useState<string | null>(null);
  const run = async (fn: () => Promise<any>) => { setErr(''); try { const x = await fn(); setWarn(x?.warnings ?? []); onChange(); return true; } catch (e) { setErr((e as Error).message); return false; } };
  return (
    <div className={`rtperm ${r.status === 'INACTIVE' || r.status === 'EXPIRED' ? 'old' : ''}`}>
      <div className="rthead"><b className="mono">{r.permit_no}</b> {rtPill(r.status)} <span className="muted">{d(r.valid_from)} – {d(r.valid_to)}</span>
        {r.case_ref && <span className="muted"> · {T('sak')} {r.case_ref}</span>}<span className="spacer" />
        {can && r.status !== 'INACTIVE' && !edit && <><button className="linkbtn" type="button" onClick={() => setEdit({ ...r })}>{T('Rett skrivefeil')}</button>
          <button className="linkbtn" type="button" onClick={() => setWithdraw('')}>{T('Trekk tilbake')}</button></>}</div>
      <div className="variants">
        <div className="variant"><span className="v">TALL · {T('skriv')} {r.skriv_tall || '—'}</span><b>{kr(r.rate_tall)}</b><span className="muted">kr/kg</span></div>
        <div className="variant"><span className="v">TOES · {T('skriv')} {r.skriv_toes || '—'}</span><b>{kr(r.rate_toes)}</b><span className="muted">kr/kg</span></div>
        <dl className="kv small">
          {showProduct && <><dt>{T('Produkt')}</dt><dd>{r.product_id ? <a href={`/products/${r.product_id}`} onClick={e => { e.preventDefault(); nav(`/products/${r.product_id}?tab=rt`); }}>{r.product_no} {r.product_label}</a> : <span className="bad">{T('Ikke knyttet til et produkt')}</span>}</dd></>}
          <dt>{T('I vedtaksbrevet')}</dt><dd>{r.product_name}{r.tariff_code ? ` · ${code(r.tariff_code)}` : ''}</dd>
          {showHolder && <><dt>{T('Innehaver')}</dt><dd>{r.holder_id ? <a href={`/partners/${r.holder_id}`} onClick={e => { e.preventDefault(); nav(`/partners/${r.holder_id}?tab=rt`); }}>{r.holder_label}</a> : r.holder_name}{r.holder_org_no ? ` · ${T('org.nr.')} ${r.holder_org_no}` : ''}</dd></>}
          {r.notes && <><dt>{T('Merknad')}</dt><dd>{r.notes}</dd></>}
        </dl>
      </div>
      {r.warnings.map((w: any) => <div key={w.code} className="warnmsg">{T(w.msg)}</div>)}
      <div className="rtdocs"><DocList docs={r.documents} can={can} onChange={onChange} />
        {can && <Upload label="+ Last opp vedtaksbrev" path={`/rt-permits/${r.id}/documents`} onDone={onChange} />}</div>
      {!r.product_id && can && <div className="row"><button className="btn small add" type="button" onClick={() => run(() => api(`/rt-permits/${r.id}/create-product`, { body: {} }))}>{T('Opprett produkt fra tillatelsen')}</button></div>}
      {withdraw !== null && <div className="subform"><label htmlFor={`wd-${r.id}`}>{T('Hvorfor trekkes tillatelsen tilbake?')}</label>
        <input id={`wd-${r.id}`} value={withdraw} onChange={e => setWithdraw(e.target.value)} />
        <div className="row"><button className="btn danger" type="button" onClick={async () => { if (await run(() => api(`/rt-permits/${r.id}/withdraw`, { body: { reason: withdraw } }))) setWithdraw(null); }}>{T('Trekk tilbake')}</button>
          <button className="btn grey" type="button" onClick={() => setWithdraw(null)}>{T('Avbryt')}</button></div></div>}
      {edit && <form className="subform" onSubmit={async (e: FormEvent) => { e.preventDefault(); if (await run(() => api(`/rt-permits/${r.id}`, { method: 'PUT', body: edit }))) setEdit(null); }}>
        <p className="hint">{T('Bare for å rette en skrivefeil. Et nytt vedtak registreres som en ny tillatelse.')}</p>
        <RtFields v={edit} set={setEdit} idp={`e-${r.id}`} />
        <div className="row"><button className="btn" type="submit">{T('Lagre')}</button><button className="btn grey" type="button" onClick={() => setEdit(null)}>{T('Avbryt')}</button></div></form>}
      <Findings warnings={warn.filter(w => !r.warnings.some((x: any) => x.code === w.code))} error={err} />
    </div>
  );
}

export function RtFields({ v, set, idp, holder }: { v: Record<string, any>; set: (v: Record<string, any>) => void; idp: string; holder?: boolean }) {
  return (
    <>
      {holder && <div className="formgrid"><div className="fwide"><label htmlFor={`${idp}-holder`}>{T('Innehaver (klienten vedtaket er gitt til)')} *</label>
        <PartnerPicker id={`${idp}-holder`} onPick={id => set({ ...v, holder_id: id })} /></div></div>}
      <Fields idPrefix={idp} value={v} onChange={set} spec={[
        { k: 'product_name', label: 'Produktnavn i vedtaksbrevet', wide: true }, { k: 'tariff_code', label: 'Varenummer' }, { k: 'case_ref', label: 'Saksnummer' },
        { k: 'skriv_tall', label: 'Skrivnummer TALL' }, { k: 'rate_tall', label: 'Sats TALL (kr/kg)', t: 'number' },
        { k: 'skriv_toes', label: 'Skrivnummer TOES' }, { k: 'rate_toes', label: 'Sats TOES (kr/kg)', t: 'number' },
        { k: 'valid_from', label: 'Gyldig fra', t: 'date', req: true }, { k: 'valid_to', label: 'Gyldig til', t: 'date', req: true },
        { k: 'holder_org_no', label: 'Innehaverens org.nr. i vedtaksbrevet', hint: 'Tomt = hentes fra partnerkortet.' }, { k: 'notes', label: 'Merknad', wide: true }]} />
    </>
  );
}

/** Register a decision for a product (prefilled from the newest permit when it is a renewal). */
export function NewRtPermit({ productId, onDone }: { productId: string; onDone: () => void }) {
  const [v, setV] = useState<Record<string, any> | null>(null);
  const [err, setErr] = useState('');
  const start = async () => {
    const r = await api(`/products/${productId}/rt-renewal`);
    setV(r.product_id ? r : { product_id: productId, valid_from: new Date().toISOString().slice(0, 10) });
  };
  if (!v) return <button className="btn add small" type="button" onClick={start}>{T('+ Registrer RT-vedtak')}</button>;
  return (
    <form className="subform" onSubmit={async e => { e.preventDefault(); setErr(''); try { await api('/rt-permits', { body: v }); setV(null); onDone(); } catch (x) { setErr((x as Error).message); } }}>
      <h3>{v.rate_tall != null || v.rate_toes != null ? T('Nytt vedtak (fornyelse) — kontroller satsene mot det nye brevet') : T('Nytt RT-vedtak')}</h3>
      <p className="hint">{T('Ett vedtaksbrev gjelder ett produkt. Innehaveren er produktets klient; en tillatelse kan ikke overføres til et annet firma.')}</p>
      <RtFields v={v} set={setV} idp="nrt" />
      <div className="row"><button className="btn add" type="submit">{T('Lagre tillatelsen')}</button><button className="btn grey" type="button" onClick={() => setV(null)}>{T('Avbryt')}</button></div>
      <Findings error={err} />
    </form>
  );
}
