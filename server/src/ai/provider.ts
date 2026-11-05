import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

/**
 * The AI behind one internal interface (requirements: "the provider can be changed without touching the
 * screens"). Documents go to Anthropic's Claude API with a fixed, versioned prompt; only the fixed structure
 * below is accepted, and it is checked again here before anything is used. Nothing is guessed: commodity
 * codes only when printed, and every line carries the AI's own confidence.
 *
 * Settings (.env): ANTHROPIC_API_KEY (required for AI intake), AI_MODEL (default claude-opus-5-5),
 * AI_EFFORT (default high).
 */
export const PROMPT_VERSION = 'odinai-intake-2026-11-v1';
export const DEFAULT_MODEL = 'claude-opus-5-5';

export interface IntakeFile { filename: string; mime: string | null; buffer: Buffer; docCode?: string | null }

const s = z.string().nullable();
const n = z.number().nullable();
const party = z.object({ name: s, street: s, postal_code: s, city: s, country: s, org_no: s, vat_no: s, eori: s });
export const Extraction = z.object({
  documents: z.array(z.object({ index: z.number().int(), kind: z.string(), number: s, date: s })),
  supplier: party,
  buyer: party,
  invoice_no: s, invoice_date: s, currency: s, incoterms: s, incoterms_place: s,
  invoice_total: n, freight: n, insurance: n, discount: n,
  total_gross_kg: n, total_net_kg: n, packages: n, package_kind: s,
  dispatch_country: s, origin_country: s,
  transport_mode: s, transport_identity: s, transport_nationality: s, container_numbers: s,
  export_declaration_ref: s, transit_ref: s, ched_ref: s,
  lines: z.array(z.object({
    article_no: s, gtin: s, description: z.string(), quantity: n, unit: s, unit_price: n, line_total: n,
    gross_kg: n, net_kg: n, packages: n, origin: s, hs_code: s, confidence: z.number(), document_index: n, page: n
  })),
  remarks: z.array(z.string())
});
export type Extraction = z.infer<typeof Extraction>;

/* JSON Schema for structured output: every property required, null where the document does not say. */
const str = { type: ['string', 'null'] }, num = { type: ['number', 'null'] };
const obj = (props: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required: Object.keys(props), properties: props });
const PARTY = obj({ name: str, street: str, postal_code: str, city: str, country: str, org_no: str, vat_no: str, eori: str });
export const SCHEMA = obj({
  documents: { type: 'array', items: obj({ index: { type: 'integer' }, kind: { type: 'string', enum: ['INVOICE', 'PACKING_LIST', 'EXPORT_DECLARATION', 'T1', 'CMR', 'BILL_OF_LADING', 'CERTIFICATE', 'CHED', 'OTHER'] }, number: str, date: str }) },
  supplier: PARTY, buyer: PARTY,
  invoice_no: str, invoice_date: str, currency: str, incoterms: str, incoterms_place: str,
  invoice_total: num, freight: num, insurance: num, discount: num,
  total_gross_kg: num, total_net_kg: num, packages: num, package_kind: str,
  dispatch_country: str, origin_country: str,
  transport_mode: { type: ['string', 'null'], enum: ['SEA', 'RAIL', 'ROAD', 'AIR', 'POST', null] }, transport_identity: str, transport_nationality: str, container_numbers: str,
  export_declaration_ref: str, transit_ref: str, ched_ref: str,
  lines: { type: 'array', items: obj({ article_no: str, gtin: str, description: { type: 'string' }, quantity: num, unit: str, unit_price: num, line_total: num,
    gross_kg: num, net_kg: num, packages: num, origin: str, hs_code: str, confidence: { type: 'number' }, document_index: num, page: num }) },
  remarks: { type: 'array', items: { type: 'string' } }
});

export const PROMPT = `You read the commercial documents of one shipment (invoice, packing list, export declaration, T1 transit document, CMR or bill of lading, certificates) for a Norwegian import customs declaration made by ODIN CUSTOMS AS. The documents are numbered in the order given, starting at 1.

Return the shipment as the JSON structure requested. Rules:
- The goods lines come from the commercial invoice: one entry per printed goods line, in document order. Never merge, split, sum or invent lines. Use the packing list only to fill weights and packages for the same lines (match by article number or description); do not add lines from it.
- Lines printed with no quantity and no amount (not delivered) are still listed, with quantity null.
- Copy numbers exactly as printed, as plain numbers with a dot as decimal separator. line_total is the printed line amount; leave it null if only unit price and quantity are printed.
- hs_code only when a commodity / HS / tariff code is printed for that line (digits only). Never classify goods yourself.
- origin and countries as ISO 3166 alpha-2 codes, only when printed or clearly stated (e.g. "Country of origin: India", "Made in Germany").
- currency as an ISO 4217 code. Dates as YYYY-MM-DD.
- supplier is the seller/exporter; buyer is the consignee/importer in Norway. org_no only for a Norwegian organisation number (9 digits).
- freight, insurance and discount only when shown separately from the goods lines on the invoice.
- export_declaration_ref: the MRN or number of the export declaration; transit_ref: the T1 MRN; ched_ref: a CHED number if one is shown.
- confidence 0 to 1 per line: how sure you are that the line was read correctly (lower for poor scans, handwriting, cut-off text).
- remarks: short notes on anything unclear, contradictory between documents, or missing that a customs specialist should check. Leave out bank details, payment terms and VAT summaries.
Use null for anything the documents do not state.`;

export interface ExtractResult { data: Extraction; model: string; usage: Record<string, unknown> | null }
export interface Provider { configured(): boolean; model(): string; extract(files: IntakeFile[]): Promise<ExtractResult> }

/** Turn a stored file into a content block the model can read; anything else is refused before sending. */
function block(f: IntakeFile, i: number): Anthropic.Beta.BetaContentBlockParam[] {
  const mime = (f.mime ?? '').toLowerCase();
  const label: Anthropic.Beta.BetaTextBlockParam = { type: 'text', text: `Document ${i + 1}: ${f.filename}${f.docCode ? ` (${f.docCode})` : ''}` };
  if (mime === 'application/pdf' || /\.pdf$/i.test(f.filename))
    return [label, { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.buffer.toString('base64') } }];
  if (['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mime))
    return [label, { type: 'image', source: { type: 'base64', media_type: mime as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp', data: f.buffer.toString('base64') } }];
  if (mime.startsWith('text/') || /\.(csv|txt)$/i.test(f.filename))
    return [label, { type: 'text', text: f.buffer.toString('utf8') }];
  throw Object.assign(new Error(`${f.filename}: filtypen kan ikke leses av AI-tjenesten (PDF, bilde eller tekst/CSV).`), { status: 415 });
}

export const anthropicProvider: Provider = {
  configured: () => !!process.env.ANTHROPIC_API_KEY,
  model: () => process.env.AI_MODEL || DEFAULT_MODEL,
  async extract(files) {
    const client = new Anthropic({ maxRetries: 2 });
    const content = files.flatMap(block);
    content.push({ type: 'text', text: 'Read these documents and return the shipment.' });
    const effort = (process.env.AI_EFFORT || 'high') as 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    // Streaming, so a long invoice never hits an HTTP timeout; the server-side fallback keeps a false
    // positive from a safety classifier from stopping the intake.
    const stream = client.beta.messages.stream({
      model: this.model(),
      max_tokens: 64000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort, format: { type: 'json_schema', schema: SCHEMA } },
      system: PROMPT,
      messages: [{ role: 'user', content }]
    });
    const msg = await stream.finalMessage();
    if (msg.stop_reason === 'refusal') throw new Error('AI-tjenesten avviste dokumentene. Fyll ut deklarasjonen manuelt.');
    if (msg.stop_reason === 'max_tokens') throw new Error('Dokumentene er for lange for ett AI-kall. Del dem opp (f.eks. faktura og pakkliste hver for seg).');
    const text = msg.content.map(b => (b.type === 'text' ? b.text : '')).join('');
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { throw new Error('AI-svaret var ikke gyldig JSON. Ingenting er fylt inn.'); }
    const parsed = Extraction.safeParse(raw);
    if (!parsed.success) throw new Error(`AI-svaret hadde ikke riktig struktur (${parsed.error.issues[0]?.path.join('.')}). Ingenting er fylt inn.`);
    return { data: parsed.data, model: msg.model, usage: msg.usage as unknown as Record<string, unknown> };
  }
};

let current: Provider = anthropicProvider;
export const provider = () => current;
/** Tests replace the provider; never used in production code. */
export const setProvider = (p: Provider | null) => { current = p ?? anthropicProvider; };
