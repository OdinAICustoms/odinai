# OdinAi

Customs declarations made from documents, by ODIN CUSTOMS AS (org. no. 931 481 274).
The AI fills in the declaration from the invoice and the built-in business partner and product
registers; a customs specialist checks it; an approver sends it to TVINN.

Requirements and design: the OdinAi requirements document (Claude Docs). Built on this PC first
(phases 0–4, against simulators), then moved to Azure Norway East (phase 5).

## Status

| Phase | Content | State |
|---|---|---|
| 0 | Docker, database, login, roles, audit log, NO/EN, logo | Done (reference data from data.toll.no: next) |
| 1 | Business partners, products, RT permits, data from ODIN LINK | Next |
| 2 | AI import declarations, review, approval, TVINN simulator | |
| 3 | Export and Digitoll | |
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
never committed.

## Rules for the code

- Every write needs a signed-in user with the right permission (`server/src/auth/roles.ts`) and the
  `X-OdinAi: 1` header (protection against cross-site requests).
- Every change is written to the audit log; the log cannot be changed or emptied.
- Screen texts are written in Norwegian through `T()`; add the English text to `client/src/en.ts`.
