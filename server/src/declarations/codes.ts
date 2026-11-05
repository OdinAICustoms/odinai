/**
 * Code lists for the import declaration (SAD boxes), from Tolletaten's "Innførselsdeklarasjon steg for
 * steg" and ODIN LINK 2.37 (src/sad.js, public/app.js). Labels are Norwegian; the screens translate.
 * Lists that Tolletaten publish as open data (offices, procedures, quotas, box 44 reference codes) live
 * in the reference data instead (src/refdata).
 */

/** Box 1 column 1 is "EU" when dispatched from an EU/EFTA/EEA country, otherwise "IM"; never a free choice. */
export const EU_EFTA_EEA = ['AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU', 'IE',
  'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK', 'IS', 'LI', 'CH'];
export const box1Column1 = (dispatch: string | null | undefined) =>
  dispatch ? (EU_EFTA_EEA.includes(dispatch.toUpperCase()) ? 'EU' : 'IM') : null;

/** Box 1 column 2: type of expedition. */
export const DECL_TYPES: Record<string, string> = {
  '4': 'Overgang til fri disponering', '5': 'Midlertidig innførsel', '6': 'Gjeninnførsel', '7': 'Innlegg på tollager'
};

export const INCOTERMS = ['EXW', 'FCA', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP', 'FAS', 'FOB', 'CFR', 'CIF'];

/** Box 24. */
export const TRANSACTION_TYPES: Record<string, string> = {
  '01': 'Kjøp mot vederlag, finansiell leasing',
  '02': 'Gratis erstatningsleveranser',
  '03': 'Gaver og andre leveranser uten kostnad',
  '04': 'Midlertidig innførsel for betalt bearbeiding',
  '05': 'Gjeninnførsel etter betalt bearbeiding',
  '06': 'Midlertidig innførsel for/gjeninnførsel etter reparasjon, leie, lån eller operasjonell leasing',
  '08': 'Bygg og anlegg, inkludert delsendinger',
  '09': 'Annet',
  '10': 'Varer i retur'
};

/** Box 25. Box 21 (active means of transport) is not given for rail, post or fixed installations. */
export const TRANSPORT_MODES: Record<string, string> = {
  '1': 'Sjøtransport', '2': 'Jernbanetransport', '3': 'Veitransport', '4': 'Lufttransport', '5': 'Post',
  '7': 'Faste transportinnretninger', '8': 'Transport på innlands vannvei', '9': 'Egen fremdrift'
};
export const NO_ACTIVE_MEANS = ['2', '5', '7'];

/** Box 36. Only A, B, C, G and P claim a preferential rate (each its own legal basis). */
export const PREFERENCES: Record<string, string> = {
  N: 'Ikke opprinnelsesstatus, preferanse kreves ikke',
  J: 'Opprinnelse kreves, bevis foreligger ikke ved fortolling',
  A: 'EØS-avtalen (alle EU-land og Island)',
  B: 'Bilateral handelsavtale EF–Norge',
  C: 'EFTA-konvensjonen (Sveits inkl. Liechtenstein, Island)',
  G: 'Norsk GSP-ordning',
  P: 'Andre frihandelsavtaler (f.eks. Marokko, Chile)'
};
export const PREF_CLAIM_CODES = ['A', 'B', 'C', 'G', 'P'];
/** Proof of origin at item level (SER), or the older document codes. */
export const PREF_PROOF_DOCS = ['SER', 'U045', 'N954', 'Y923'];

/** Box 43. */
export const VALUATION_METHODS: Record<string, string> = {
  '1': 'Varens transaksjonsverdi (§ 6-3)', '2': 'Transaksjonsverdien av identisk vare (§ 6-4)',
  '3': 'Transaksjonsverdien av lignende vare (§ 6-5)', '4': 'Salgspris i Norge (§ 6-7)',
  '5': 'Utregnet tollverdi (§ 6-8)', '6': 'Alternativ tollverdi (§ 6-9)'
};

/** Box 48. */
export const PAYMENT_METHODS: Record<string, string> = { TOLLKREDITT: 'Tollkreditt', DAGSOPPGJOR: 'Dagsoppgjør', KONTANT: 'Kontant' };

/** Box 44, shipment-wide: invoice, packing list, CMR. */
export const DECL_DOC_CODES: Record<string, string> = { N380: 'Handelsfaktura', N271: 'Pakkliste', N730: 'Fraktbrev (CMR)' };

/** Box 44, per goods item: code, short name, what to enter as reference (ODIN LINK, from Tolletaten's guide). */
export const ITEM_DOC_CODES: [string, string, string][] = [
  ['B3', 'Alkohol — bevilling/registrering', 'Oppgi B3 og varemottakers org.nr. (f.eks. B3 123456789).'],
  ['B4', 'Teknisk etanol — registrering', 'Oppgi B4 og varemottakers org.nr.'],
  ['CE', 'CE-godkjenning fritidsfartøy', 'Oppgi CIN-nummer som referanse.'],
  ['FD', 'Fangstdokumentasjon', 'Fangstdokumentnummer.'],
  ['I1', 'Innførselslisens (UD)', 'Innførselslisens fra Utenriksdepartementet.'],
  ['L3', 'Tillatelse innførsel legemidler', 'Tillatelsens nummer.'],
  ['N2', 'Analyserapport for ris', 'Analyserapportens nummer.'],
  ['MR', 'Tillatelse Miljødirektoratet', 'Oppgi MR og org.nr.'],
  ['P2', 'Plantesunnhetssertifikat', 'Sertifikatets nummer.'],
  ['P3', 'Plantesunnhet — forhåndsvarslet', 'Forhåndsvarslet Mattilsynet, i tillegg til plantesunnhetssertifikat.'],
  ['V3', 'Våpen — tillatelse', 'Tillatelse fra Politiet eller DSB.'],
  ['V5', 'Varslet Mattilsynet', 'Varslet tilsynsmyndighet (Mattilsynet).'],
  ['VT', 'Tillatelse Mattilsynet', 'Tillatelsens nummer; for en CHED-forsendelse CHED-nummeret (f.eks. CHEDP.NO.2026.0012345).'],
  ['S6', 'Såvarer — tillatelse', 'Tillatelsens nummer.'],
  ['S1', 'DSA — radioaktive kilder', 'Tillatelse fra DSA.'],
  ['S3', 'DSA — sterke laserpekere', 'Tillatelse fra DSA.'],
  ['TB', 'Tobakksbevilling', 'Tobakksbevillingsnummer (Helsedirektoratet).'],
  ['K5', 'Kulturminner — utførselstillatelse', 'Utførselstillatelse fra opprinnelseslandet.'],
  ['W1', 'CITES — utførselstillatelse', 'CITES-tillatelse nr.'],
  ['AFB', 'Avgiftsfri bruk', 'Tillatelse til avgiftsfri bruk.'],
  ['UND', 'Individuelt unntaksdokument', 'Årstall/journalnummer fra Tolletaten.'],
  ['USK', 'Tollnedsettelse Landbruksdirektoratet', 'INDXXXXXXX.'],
  ['GEN', 'Generelt unntaksdokument', '"S" og journalnummer (f.eks. S2001/1234).'],
  ['KVT', 'Automatisk kvotetildeling', '"T" og kvotens nummer (f.eks. T01012).'],
  ['FOR', 'Foreløpig deklarasjon', 'Tillatelsens nummer.'],
  ['VEC', 'VOEC-forsendelse (nødløsning)', 'Kun privatpersoner, inntil 3000 kr per varelinje.'],
  ['SER', 'Opprinnelsessertifikat / fakturaerklæring', 'Dokumentets nummer eller "fakturaerklæring".'],
  ['FLY', 'Fritak — sivil luftfart', 'Hjemmel.'],
  ['MIL', 'Fritak — militær luftfart', 'Hjemmel.'],
  ['BOK', 'Fritak — bøker', 'mval. § 6-4 og fmva. § 6-4-3.'],
  ['UNI', 'Fritak — universiteter/høyskoler', 'Tollavgiftsforskriften § 6-4-2.'],
  ['I2', 'Generell tollfritakskode', 'Tollavgiftsforskriften kap. 6.'],
  ['M2', 'Generell mva-fritakskode', 'Hjemmel (mval. kap. 7).'],
  ['HST', 'Sikkerhetsstillelse — hest', 'Referanse til sikkerhetsstillelsen.'],
  ['DEL', 'Delsendinger', 'Vareførselsforskriften § 4-1-1 (4).'],
  ['CIT', 'CITES-arter/-produkter', 'CITES-tillatelse nr.'],
  ['TSM', 'Omlasting CHED (transhipment)', 'CHED-identifikasjonsnummer.'],
  ['TXT', 'Fritekst', 'Årsak/hjemmel ved midlertidig innførsel; ved gjeninnførsel art, mengde, verdi og bearbeiding.'],
  ['DOK', 'Referanse til annen deklarasjon', 'Deklarasjonen som skal skrives av.']
];
/** CHED reference: VT at item level, or the older CHED document codes. */
export const CHED_DOCS = ['VT', 'C678', 'C085', 'C640'];

/** Procedures where nothing is charged when declared: 5xxx temporary import / processing, 7xxx warehouse. */
export const SUSPENSIVE = ['5', '7'];

/** Partner roles that fit each party box (src/partners/rules.ts). */
export const BOX_ROLES: Record<'exporter_id' | 'importer_id' | 'declarant_id', { box: string; roles: string[] }> = {
  exporter_id: { box: '2', roles: ['EXP', 'CNR'] },
  importer_id: { box: '8', roles: ['IMP', 'CON'] },
  declarant_id: { box: '14', roles: ['DEC', 'REP'] }
};

export const STATUSES = ['DRAFT', 'SUBMITTED', 'RETURNED', 'APPROVED', 'SENT', 'ACCEPTED', 'REJECTED', 'CANCELLED'] as const;
/** Only these can be edited; everything after submit is frozen until it comes back (returned, recalled, rejected by TVINN). */
export const EDITABLE = ['DRAFT', 'RETURNED', 'REJECTED'];
