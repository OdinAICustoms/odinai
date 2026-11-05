import * as R from './pricing.js';

/**
 * EHF = Peppol BIS Billing 3.0 (UBL 2.1), the Norwegian rules included (anskaffelser.dev, EHF Billing 3.0).
 * Built from the frozen invoice (seller, buyer, lines); amounts are positive on a credit note.
 *  * Parties by organisation number: EndpointID and legal CompanyID with scheme 0192 (Brønnøysund).
 *  * NO-R-002: a seller in Foretaksregisteret has a second PartyTaxScheme "Foretaksregisteret" / TAX.
 *  * VAT categories: S (25 %), Z (fritatt, mval. kap. 6), E (unntatt) — and outlays (utlegg) as E with
 *    the reason "Utlegg", because O (outside scope) may not be mixed with other categories (BR-O-*).
 *    Have the access point validate the first real invoice; the category for outlays is a convention.
 *  * Without VAT registration every line is O ("Ikke mva-registrert").
 *  * Sending goes through an access point (phase 5); until then the XML is made and downloaded.
 */
const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const amt = (n: unknown) => Math.abs(Number(n) || 0).toFixed(2);
const signed = (n: unknown) => (Number(n) || 0).toFixed(2);
const digits = (s: unknown) => String(s ?? '').replace(/\D/g, '');
const UNIT: Record<string, string> = { stk: 'EA', timer: 'HUR', time: 'HUR', t: 'HUR' };

export function category(code: string, rate: number, sellerVat: boolean) {
  if (!sellerVat) return { id: 'O', percent: null as number | null, reason: 'Ikke mva-registrert' };
  if (code === 'HIGH' && rate > 0) return { id: 'S', percent: rate, reason: null };
  if (code === 'ZERO') return { id: 'Z', percent: 0, reason: null };
  if (code === 'OUTLAY') return { id: 'E', percent: 0, reason: 'Utlegg' };
  return { id: 'E', percent: 0, reason: 'Unntatt merverdiavgift' };
}
const taxCategory = (tag: string, c: ReturnType<typeof category>, withReason: boolean) =>
  `<cac:${tag}><cbc:ID>${c.id}</cbc:ID>${c.percent !== null ? `<cbc:Percent>${c.percent}</cbc:Percent>` : ''}` +
  `${withReason && c.reason ? `<cbc:TaxExemptionReason>${esc(c.reason)}</cbc:TaxExemptionReason>` : ''}<cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:${tag}>`;

function party(p: any, seller: boolean) {
  const org = digits(p.orgNo);
  const addr = `<cac:PostalAddress>${p.street ? `<cbc:StreetName>${esc(p.street)}</cbc:StreetName>` : ''}${p.city ? `<cbc:CityName>${esc(p.city)}</cbc:CityName>` : ''}` +
    `${p.postalCode ? `<cbc:PostalZone>${esc(p.postalCode)}</cbc:PostalZone>` : ''}<cac:Country><cbc:IdentificationCode>${esc(p.addressCountry ?? p.country ?? 'NO')}</cbc:IdentificationCode></cac:Country></cac:PostalAddress>`;
  const tax = seller && p.vatRegistered ? `<cac:PartyTaxScheme><cbc:CompanyID>NO${org}MVA</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>` : '';
  const foretak = seller ? '<cac:PartyTaxScheme><cbc:CompanyID>Foretaksregisteret</cbc:CompanyID><cac:TaxScheme><cbc:ID>TAX</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>' : '';
  const contact = seller && (p.email || p.phone) ? `<cac:Contact>${p.phone ? `<cbc:Telephone>${esc(p.phone)}</cbc:Telephone>` : ''}${p.email ? `<cbc:ElectronicMail>${esc(p.email)}</cbc:ElectronicMail>` : ''}</cac:Contact>` : '';
  return `<cac:Party><cbc:EndpointID schemeID="0192">${org}</cbc:EndpointID><cac:PartyName><cbc:Name>${esc(p.name)}</cbc:Name></cac:PartyName>${addr}${tax}${foretak}` +
    `<cac:PartyLegalEntity><cbc:RegistrationName>${esc(p.name)}</cbc:RegistrationName><cbc:CompanyID schemeID="0192">${org}</cbc:CompanyID></cac:PartyLegalEntity>${contact}</cac:Party>`;
}

/** What stops an EHF from being made (shown on the card, never worked around). */
export function ehfGaps(inv: any) {
  const out: string[] = [];
  if (!['ISSUED', 'CREDITED'].includes(inv.status)) out.push('fakturaen er ikke utstedt');
  if (!/^\d{9}$/.test(digits(inv.buyer?.orgNo)) || (inv.buyer?.country && inv.buyer.country !== 'NO')) out.push('klienten har ikke norsk organisasjonsnummer');
  if (!inv.buyer?.street || !inv.buyer?.city) out.push('klienten mangler adresse');
  return out;
}

export function buildEhf(data: { invoice: any; lines: any[]; credits: any }) {
  const { invoice: i, lines, credits } = data;
  const s = i.seller ?? {}, b = i.buyer ?? {};
  const credit = i.kind === 'CREDIT';
  const root = credit ? 'CreditNote' : 'Invoice';
  const sellerVat = !!s.vatRegistered;
  const vat = R.vatSummary(lines);
  const taxTotal = vat.reduce((t, v) => t + v.vat, 0);
  const net = lines.reduce((t, l) => t + Number(l.amount), 0);
  const deposit = Number(i.deposit_applied) || 0;
  const subtotals = vat.map(v => { const c = category(v.code, v.rate, sellerVat); return { c, base: v.base, vat: v.vat }; })
    // Lines with the same category and rate are one subtotal (outlays and other E lines carry different reasons, kept apart).
    .reduce((acc: { c: ReturnType<typeof category>; base: number; vat: number }[], x) => {
      const same = acc.find(a => a.c.id === x.c.id && a.c.percent === x.c.percent && a.c.reason === x.c.reason);
      if (same) { same.base = R.r2(same.base + x.base); same.vat = R.r2(same.vat + x.vat); } else acc.push({ ...x });
      return acc;
    }, []);
  const lineXml = lines.map((l, n) => {
    const c = category(l.vat_code, Number(l.vat_rate), sellerVat);
    const q = Math.abs(Number(l.quantity));
    return `<cac:${root}Line><cbc:ID>${n + 1}</cbc:ID><cbc:${credit ? 'Credited' : 'Invoiced'}Quantity unitCode="${UNIT[String(l.unit ?? 'stk').toLowerCase()] ?? 'EA'}">${q}</cbc:${credit ? 'Credited' : 'Invoiced'}Quantity>` +
      `<cbc:LineExtensionAmount currencyID="NOK">${credit ? amt(l.amount) : signed(l.amount)}</cbc:LineExtensionAmount>` +
      `<cac:Item><cbc:Name>${esc(String(l.description).slice(0, 250))}</cbc:Name>${taxCategory('ClassifiedTaxCategory', c, false)}</cac:Item>` +
      `<cac:Price><cbc:PriceAmount currencyID="NOK">${amt(l.unit_price)}</cbc:PriceAmount></cac:Price></cac:${root}Line>`;
  }).join('');
  const total = (n: number) => (credit ? amt(n) : signed(n));
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<${root} xmlns="urn:oasis:names:specification:ubl:schema:xsd:${root}-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">` +
    '<cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0</cbc:CustomizationID>' +
    '<cbc:ProfileID>urn:fdc:peppol.eu:2017:poacc:billing:01:1.0</cbc:ProfileID>' +
    `<cbc:ID>${esc(i.invoice_no)}</cbc:ID><cbc:IssueDate>${i.issue_date}</cbc:IssueDate>` +
    (credit ? '<cbc:CreditNoteTypeCode>381</cbc:CreditNoteTypeCode>' : `${i.due_date ? `<cbc:DueDate>${i.due_date}</cbc:DueDate>` : ''}<cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>`) +
    `${i.note || (credit && i.credit_reason) ? `<cbc:Note>${esc([credit ? i.credit_reason : null, i.note].filter(Boolean).join(' — '))}</cbc:Note>` : ''}` +
    `<cbc:DocumentCurrencyCode>NOK</cbc:DocumentCurrencyCode><cbc:BuyerReference>${esc(i.your_ref || b.partnerNo || 'N/A')}</cbc:BuyerReference>` +
    (i.delivery_from ? `<cac:InvoicePeriod><cbc:StartDate>${i.delivery_from}</cbc:StartDate><cbc:EndDate>${i.delivery_to ?? i.delivery_from}</cbc:EndDate></cac:InvoicePeriod>` : '') +
    (credit && credits ? `<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>${esc(credits.invoice_no)}</cbc:ID><cbc:IssueDate>${credits.issue_date}</cbc:IssueDate></cac:InvoiceDocumentReference></cac:BillingReference>` : '') +
    `<cac:AccountingSupplierParty>${party(s, true)}</cac:AccountingSupplierParty><cac:AccountingCustomerParty>${party(b, false)}</cac:AccountingCustomerParty>` +
    (!credit ? `<cac:PaymentMeans><cbc:PaymentMeansCode>30</cbc:PaymentMeansCode>${i.kid ? `<cbc:PaymentID>${i.kid}</cbc:PaymentID>` : ''}` +
      `<cac:PayeeFinancialAccount><cbc:ID>${digits(s.bankAccount)}</cbc:ID></cac:PayeeFinancialAccount></cac:PaymentMeans>` +
      `<cac:PaymentTerms><cbc:Note>${esc(`Betales innen ${i.due_date ?? ''}${i.kid ? `, KID ${i.kid}` : ''}`)}</cbc:Note></cac:PaymentTerms>` : '') +
    `<cac:TaxTotal><cbc:TaxAmount currencyID="NOK">${total(taxTotal)}</cbc:TaxAmount>` +
    subtotals.map(x => `<cac:TaxSubtotal><cbc:TaxableAmount currencyID="NOK">${total(x.base)}</cbc:TaxableAmount><cbc:TaxAmount currencyID="NOK">${total(x.vat)}</cbc:TaxAmount>${taxCategory('TaxCategory', x.c, true)}</cac:TaxSubtotal>`).join('') +
    '</cac:TaxTotal>' +
    `<cac:LegalMonetaryTotal><cbc:LineExtensionAmount currencyID="NOK">${total(net)}</cbc:LineExtensionAmount><cbc:TaxExclusiveAmount currencyID="NOK">${total(net)}</cbc:TaxExclusiveAmount>` +
    `<cbc:TaxInclusiveAmount currencyID="NOK">${total(net + taxTotal)}</cbc:TaxInclusiveAmount>${deposit ? `<cbc:PrepaidAmount currencyID="NOK">${amt(deposit)}</cbc:PrepaidAmount>` : ''}` +
    `<cbc:PayableAmount currencyID="NOK">${total(R.r2(net + taxTotal - deposit))}</cbc:PayableAmount></cac:LegalMonetaryTotal>` +
    lineXml + `</${root}>\n`;
  return xml;
}
