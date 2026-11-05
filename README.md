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
| 4 | Invoicing (prices per client, KID, bank API, Fiken) | |
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
