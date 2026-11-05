# OdinAi

Customs declarations made from documents, by ODIN CUSTOMS AS (org. no. 931 481 274).
The AI fills in the declaration from the invoice and the built-in business partner and product
registers; a customs specialist checks it; an approver sends it to TVINN.

Requirements and design: the OdinAi requirements document (Claude Docs). Built on this PC first
(phases 0–4, against simulators), then moved to Azure Norway East (phase 5).

## Status

| Phase | Content | State |
|---|---|---|
| 0 | Docker, database, login, roles, audit log, NO/EN, logo, daily reference data | Done |
| 1 | Business partners, products, RT permits, data from ODIN LINK | Done (move: `npm run import:odinlink -w server`, dry run unless `-- --commit`) |
| 2 | AI import declarations, review, approval, TVINN simulator | Done: declaration, calculation (checked against two accepted Proteria declarations), AI intake, four-eyes approval, TVINN simulator and send queue. Left for later: release e-mail to the client (needs SMTP) and the real AI trial |
| 3 | Export and Digitoll | Done: export declarations, Digitoll road (transport, master, house) on the simulator |
| 4 | Invoicing (prices per client, KID, bank API, Fiken) | Done: invoice basis, drafts, issuing with number series and KID, credit notes, PDF, payments by hand, EHF (XML), Fiken (simulator). Waits for go-live: bank integration, EHF sending through an access point, the live Fiken token |
| 5 | Online, Tolletaten test period, go-live | |

## Run it on this PC

Needs Node.js 22.12+ (24 recommended) and Docker Desktop running.

```
npm install
npm run dev
```

`npm run dev` starts the database (Docker), applies new migrations, and runs the server on
http://localhost:3200 and the screens on **http://localhost:5200**. On the first visit the login page
creates the first administrator.

Other commands: `npm test` (server tests on a separate test database), `npm run typecheck`,
`npm run build`, `docker compose --profile app up -d --build` (the built app in Docker on port 3200).

Settings are in `.env` (copy `.env.example`); it is never committed.

## AI reading of documents

AI-deklarasjoner › Innførsel › «+ Ny fra dokumenter»: invoice, packing list, export declaration or T1 are
stored on a new draft and read in the background by Anthropic's Claude API (`server/src/ai`), with a fixed,
versioned prompt and a fixed output structure. The draft is built from the registers first (partners by
org. no. / EORI / name, products by GTIN and article numbers); what the AI read alone, and anything unclear,
becomes a review point to clear. Every goods item keeps the source of its values. A client marked
«Reservert mot AI-behandling» on the partner card is never sent. Needs `ANTHROPIC_API_KEY` in `.env`
(optional `AI_MODEL`, default `claude-opus-5-5`, and `AI_EFFORT`, default `high`).

## Invoicing

Fakturering › Til fakturering lists every declaration accepted by Tolletaten that is not on a live invoice,
per client, with the proposed lines (`server/src/invoicing`). Prices come from the partner card (the agreed
price on the declaration date), else the price list (Fakturering › Innstillinger). Duty and levies are
recharged as outlays only when Odin paid them (box 48: Odin's own credit account, dagsoppgjør or cash);
import VAT is never recharged. A missing price or an unknown payer is a warning, never a guess.

A draft has no number and can be edited. Issuing takes the next number from one unbroken series (shared with
credit notes), sets the KID (client number + invoice number + MOD10), the due date and the PDF, and freezes the
invoice — the database refuses changes and deletes. A credit note credits whole lines; when every line is
credited, the declarations go back to the basis. Fill in the company details and account number under
Fakturering › Innstillinger before the first invoice is issued.

Until the bank is connected (at go-live), payments are registered by hand on the invoice; a wrong one is
reversed with a reason, never deleted. Every issued invoice and credit note can be downloaded as EHF
(Peppol BIS Billing 3.0); sending goes through an access point from go-live. Invoices, credit notes and
payments are sent to Fiken as "Annet salg" through an outbox (`server/src/invoicing/fiken.ts`):
`FIKEN_ADAPTER=simulator` by default, `live` with `FIKEN_TOKEN` in `.env` and the company slug, accounts
and VAT types under Fakturering › Innstillinger (to be confirmed by the accountant).

## Reference data

Loaded every day at 05:30 (and at start-up when missing or older than a day) from Tolletaten's
open data and Posten; Administrasjon › Referansedata shows the status and refreshes on demand.

| Dataset | Source | Rows (Nov 2026) |
|---|---|---|
| Customs tariff | data.toll.no `varenummer` + `tolltariffstruktur` | 7,445 codes + 1,369 chapters/headings |
| Duty rates TL1 | `tollavgiftssats` | about 298,000 lines |
| RT100 | `raavaretollavgiftssats` | 1,963 lines, 53 codes |
| Country groups | `landgruppe` + `medlemsland` | 151 groups, 250 countries |
| Import restrictions | `innfoerselsrestriksjon` | 9,396 lines |
| TVINN error codes | `feilmelding` | 354 |
| Customs exchange rates | `valutakurs` | 45 currencies |
| Postal codes | bring.no postnummerregister | 5,112 |

A load runs in one transaction: if it fails, or would leave less than half of today's rows, the
old data stays. `REFRESH_SCHEDULE=off` in `.env` switches the schedule off; `REFRESH_AT=05:30` moves it.
Office codes, procedure codes, VAT and levies, quotas and the export datasets are added in the phase
that first uses them.

## Where things are

```
server/            API (TypeScript, Express, PostgreSQL)
  migrations/      database changes, applied in order, never edited after they ran
  src/auth/        sessions, passwords, roles and permissions, the request guard
  src/admin/       users, settings, audit log
  src/audit.ts     the append-only audit log (field by field)
  test/            automated tests (vitest + supertest)
client/            screens (React + Vite)
  src/i18n.ts, en.ts   Norwegian base texts, English translations
```

Real client documents for testing live in `C:\OdinAI-testdata`, outside this folder, so they are
never committed. `C:\OdinAI-testdata\proteria` holds the two declarations accepted by Tolletaten that the
calculation is tested against (`server/test/proteria.test.ts`, skipped when the folder is missing).

## Rules for the code

- Every write needs a signed-in user with the right permission (`server/src/auth/roles.ts`) and the
  `X-OdinAi: 1` header (protection against cross-site requests).
- Every change is written to the audit log; the log cannot be changed or emptied.
- Screen texts are written in Norwegian through `T()`; add the English text to `client/src/en.ts`.
