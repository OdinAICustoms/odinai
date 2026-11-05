import PDFDocument from 'pdfkit';
import { formatAccount } from './pricing.js';

/**
 * The printed invoice or credit note (A4, Norwegian), with what bokføringsforskriften § 5-1-1 asks for:
 * number, date, seller and buyer with org. no. ("MVA" when VAT registered, "Foretaksregisteret"),
 * delivery period, lines with VAT, VAT per rate, the total, due date, account and KID.
 * A draft prints with a large "UTKAST" mark and no number.
 */
const M = 50, W = 595.28 - 2 * M;
const COLS = { desc: M, qty: M + 270, price: M + 325, vat: M + 400, amount: M + 440 };
const nb = (n: unknown, dec = 2) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return '';
  const [i, d] = Math.abs(v).toFixed(dec).split('.');
  return (v < 0 ? '-' : '') + i.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + (d ? ',' + d : '');
};
const qty = (n: unknown) => { const v = Number(n); return Number.isInteger(v) ? nb(v, 0) : nb(v, 3).replace(/0+$/, '').replace(/,$/, ''); };
const date = (d: unknown) => { const s = String(d ?? ''); return /^\d{4}-\d{2}-\d{2}/.test(s) ? `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(0, 4)}` : ''; };
const org = (o: unknown) => String(o ?? '').replace(/\D/g, '').replace(/^(\d{3})(\d{3})(\d{3})$/, '$1 $2 $3');
const VAT_LABEL: Record<string, string> = { HIGH: '', ZERO: 'fritatt', EXEMPT: 'utenfor', OUTLAY: 'utlegg' };

export function renderInvoice(data: { invoice: any; lines: any[]; vat: { code: string; rate: number; base: number; vat: number }[]; credits: any }, opts: { preview?: boolean } = {}): Promise<Buffer> {
  const { invoice: i, lines, vat, credits } = data;
  const s = i.seller ?? {}, b = i.buyer ?? {};
  const isCredit = i.kind === 'CREDIT';
  const doc = new PDFDocument({ size: 'A4', margins: { top: M, bottom: 70, left: M, right: M }, bufferPages: true,
    info: { Title: `${isCredit ? 'Kreditnota' : 'Faktura'} ${i.invoice_no ?? 'utkast'}`, Author: s.name ?? 'ODIN CUSTOMS AS', Producer: 'OdinAi' } });
  const chunks: Buffer[] = [];
  doc.on('data', c => chunks.push(c));
  const done = new Promise<Buffer>((res, rej) => { doc.on('end', () => res(Buffer.concat(chunks))); doc.on('error', rej); });

  const text = (t: string, x: number, y: number, o: PDFKit.Mixins.TextOptions = {}) => doc.text(t, x, y, { lineBreak: false, ...o });
  const regular = () => doc.font('Helvetica').fillColor('#111'), bold = () => doc.font('Helvetica-Bold').fillColor('#111'), grey = () => doc.font('Helvetica').fillColor('#666');

  /* Seller (left) and the document title with its key facts (right). */
  bold().fontSize(15); text(s.name ?? '', M, M);
  regular().fontSize(9);
  let y = M + 20;
  for (const l of [s.street, [s.postalCode, s.city].filter(Boolean).join(' ')].filter(Boolean)) { text(l, M, y); y += 12; }
  text(`Foretaksregisteret · Org.nr. ${s.vatRegistered ? 'NO ' : ''}${org(s.orgNo)}${s.vatRegistered ? ' MVA' : ''}`, M, y); y += 12;

  bold().fontSize(20); text(isCredit ? 'KREDITNOTA' : 'FAKTURA', M + W - 200, M, { width: 200, align: 'right' });
  const facts: [string, string][] = [
    [isCredit ? 'Kreditnotanr.' : 'Fakturanr.', i.invoice_no ? String(i.invoice_no) : '—'],
    [isCredit ? 'Dato' : 'Fakturadato', date(i.issue_date) || '—'],
    ...(!isCredit ? [['Forfallsdato', date(i.due_date) || '—'] as [string, string]] : []),
    ...(i.kid && !isCredit ? [['KID', i.kid] as [string, string]] : []),
    ['Kundenr.', b.partnerNo ?? ''],
    ...(i.your_ref ? [['Deres ref.', i.your_ref] as [string, string]] : []),
    ...(i.delivery_from ? [['Levert', i.delivery_from === i.delivery_to || !i.delivery_to ? date(i.delivery_from) : `${date(i.delivery_from)}–${date(i.delivery_to)}`] as [string, string]] : [])
  ];
  let fy = M + 30;
  doc.fontSize(9);
  for (const [k, v] of facts) { grey(); text(k, M + W - 200, fy, { width: 90 }); regular(); text(v, M + W - 110, fy, { width: 110, align: 'right' }); fy += 13; }

  /* Buyer. */
  y = Math.max(y + 28, 150);
  grey().fontSize(8); text(isCredit ? 'KREDITERES' : 'FAKTURERES', M, y); y += 12;
  bold().fontSize(11); text(b.name ?? '', M, y, { width: 260, lineBreak: true }); y = doc.y + 2;
  regular().fontSize(9.5);
  for (const l of [b.street, [b.postalCode, b.city].filter(Boolean).join(' '), b.addressCountry && b.addressCountry !== 'NO' ? b.addressCountry : null].filter(Boolean)) { text(l, M, y); y += 12; }
  if (b.orgNo) { text(`Org.nr. ${org(b.orgNo)}`, M, y); y += 12; }
  y = Math.max(y, fy) + 18;

  if (isCredit && credits) {
    regular().fontSize(9.5);
    doc.text(`Krediterer faktura nr. ${credits.invoice_no} av ${date(credits.issue_date)}.${i.credit_reason ? ` Årsak: ${i.credit_reason}` : ''}`, M, y, { width: W });
    y = doc.y + 10;
  }
  if (i.note) { regular().fontSize(9.5); doc.text(i.note, M, y, { width: W }); y = doc.y + 10; }

  /* Lines. */
  const header = (yy: number) => {
    doc.rect(M, yy - 4, W, 18).fill('#eef2f7');
    bold().fontSize(8.5);
    text('Beskrivelse', COLS.desc + 4, yy); text('Antall', COLS.qty, yy, { width: 45, align: 'right' });
    text('Enhetspris', COLS.price, yy, { width: 68, align: 'right' }); text('Mva', COLS.vat, yy, { width: 34, align: 'right' });
    text('Beløp', COLS.amount, yy, { width: W - (COLS.amount - M) - 4, align: 'right' });
    return yy + 20;
  };
  y = header(y);
  for (const l of lines) {
    regular().fontSize(9);
    const h = doc.heightOfString(l.description, { width: COLS.qty - COLS.desc - 14 });
    if (y + h > 842 - 150) { doc.addPage(); y = header(M); }
    doc.text(l.description, COLS.desc + 4, y, { width: COLS.qty - COLS.desc - 14 });
    text(qty(l.quantity), COLS.qty, y, { width: 45, align: 'right' });
    text(nb(l.unit_price), COLS.price, y, { width: 68, align: 'right' });
    text(VAT_LABEL[l.vat_code] || `${nb(l.vat_rate, 0)} %`, COLS.vat, y, { width: 34, align: 'right' });
    text(nb(l.amount), COLS.amount, y, { width: W - (COLS.amount - M) - 4, align: 'right' });
    y += Math.max(h, 11) + 5;
    doc.moveTo(M, y - 2).lineTo(M + W, y - 2).lineWidth(0.3).strokeColor('#d5dbe3').stroke();
  }

  /* Totals and VAT per rate. */
  if (y > 842 - 230) { doc.addPage(); y = M; }
  y += 8;
  const net = Number(i.net_total), out = Number(i.outlay_total), dep = Number(i.deposit_applied);
  const rows: [string, string, boolean?][] = [['Sum eksklusiv mva', nb(net)]];
  for (const v of vat.filter(v => v.code !== 'OUTLAY' && v.rate > 0)) rows.push([`Mva ${nb(v.rate, 0)} % av ${nb(v.base)}`, nb(v.vat)]);
  if (out) rows.push(['Utlegg (ikke mva-pliktig)', nb(out)]);
  if (dep) rows.push([dep > 0 ? 'Forskudd trukket fra' : 'Forskudd tilbakeført', nb(-dep)]);
  rows.push([isCredit ? 'Å godskrive' : 'Å betale (NOK)', nb(isCredit ? -Number(i.total) : i.total), true]);
  for (const [k, v, strong] of rows) {
    (strong ? bold() : regular()).fontSize(strong ? 11 : 9.5);
    if (strong) { doc.moveTo(M + W - 250, y - 3).lineTo(M + W, y - 3).lineWidth(0.8).strokeColor('#111').stroke(); y += 2; }
    text(k, M + W - 250, y, { width: 160 }); text(v, M + W - 90, y, { width: 86, align: 'right' });
    y += strong ? 16 : 13;
  }
  const summary = vat.filter(v => v.code !== 'OUTLAY');
  if (summary.length) {
    let vy = y - rows.length * 13 - 6;
    grey().fontSize(8); text('Mva-sats', M, vy); text('Grunnlag', M + 90, vy, { width: 70, align: 'right' }); text('Mva', M + 165, vy, { width: 60, align: 'right' }); vy += 11;
    for (const v of summary) {
      regular().fontSize(8.5);
      text(v.rate > 0 ? `${nb(v.rate, 0)} %` : v.code === 'ZERO' ? '0 % (fritatt)' : 'Utenfor mva-loven', M, vy, { width: 90 });
      text(nb(v.base), M + 90, vy, { width: 70, align: 'right' }); text(nb(v.vat), M + 165, vy, { width: 60, align: 'right' });
      vy += 11;
    }
  }

  /* How to pay. */
  y += 14;
  doc.rect(M, y, W, isCredit ? 34 : 46).lineWidth(0.6).strokeColor('#8aa0b8').stroke();
  regular().fontSize(9.5);
  if (isCredit) doc.text('Beløpet trekkes fra ved neste innbetaling eller betales tilbake etter avtale.', M + 10, y + 11, { width: W - 20 });
  else if (!i.invoice_no) doc.text('Fakturanummer, forfallsdato og KID gis når fakturaen utstedes.', M + 10, y + 11, { width: W - 20 });
  else {
    bold(); text(`Betales til konto ${formatAccount(s.bankAccount ?? '')}`, M + 10, y + 9);
    regular(); text(`innen ${date(i.due_date) || '—'}`, M + 10, y + 24);
    if (i.kid) { bold(); text(`KID ${i.kid}`, M + W - 210, y + 9, { width: 200, align: 'right' }); regular(); text('Bruk KID ved betaling', M + W - 210, y + 24, { width: 200, align: 'right' }); }
    if (s.iban) { grey().fontSize(8); text(`IBAN ${s.iban}${s.bic ? ` · BIC ${s.bic}` : ''}`, M + 10, y + 35); }
  }

  /* Footer on every page, and the draft mark. */
  const range = doc.bufferedPageRange();
  for (let p = range.start; p < range.start + range.count; p++) {
    doc.switchToPage(p);
    doc.page.margins.bottom = 0;   // the footer sits below the text area; without this pdfkit would start a new page
    const fy2 = 842 - 50;
    doc.moveTo(M, fy2 - 6).lineTo(M + W, fy2 - 6).lineWidth(0.3).strokeColor('#d5dbe3').stroke();
    grey().fontSize(7.5);
    text([s.name, s.email, s.phone, s.web].filter(Boolean).join('  ·  '), M, fy2, { width: W - 60 });
    if (s.footer) text(s.footer, M, fy2 + 10, { width: W - 60 });
    text(`Side ${p - range.start + 1} av ${range.count}`, M + W - 60, fy2, { width: 60, align: 'right' });
    if (opts.preview) {
      doc.save().rotate(-35, { origin: [297, 421] }).font('Helvetica-Bold').fontSize(90).fillColor('#c8102e').fillOpacity(0.12)
        .text('UTKAST', 80, 380, { width: 440, align: 'center', lineBreak: false }).restore();
      doc.fillOpacity(1);
    }
  }
  doc.end();
  return done;
}
