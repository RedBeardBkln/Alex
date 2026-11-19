# Alex

Alex is a personal executive assistant. It connects several Google accounts (personal and business), Slack, and a reMarkable tablet, and it handles email, scheduling and the tasks you hand it. It runs at `alex.ericandeva.com`.

**Ground rule:** Alex drafts and proposes, and you approve. Nothing is sent, booked or posted until you click approve.

## Status

| Phase | Scope | Status |
|---|---|---|
| 1 | Sign-in, connecting Google accounts (encrypted tokens), database, deployment | Done |
| 2a | Mail ingestion (Gmail push via Pub/Sub, polling fallback, 30-day backfill) and a read-only combined inbox | **In progress** (branch `phase-2-inbox`) |
| 2b, 2c | Approval queue and replies; AI triage and drafts | Planned |
| 3 | Calendar: free/busy across accounts, proposing times, invites | Planned |
| 4 | Slack | Planned |
| 5 | reMarkable handwriting turned into tasks and meetings | Planned |

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design and [docs/SETUP.md](docs/SETUP.md) to deploy.

## Stack

- Next.js 16 (App Router, TypeScript) on Vercel
- Postgres (Neon) with Drizzle ORM
- Google OAuth through [arctic](https://arcticjs.dev), with PKCE and state checks
- Tokens encrypted with AES-256-GCM at rest
- Claude API, called from the app itself, starting in Phase 2

## Local development

```bash
npm install
cp .env.example .env          # fill in values; generate a key with: npm run gen:key
npm run db:migrate            # apply migrations to DATABASE_URL
npm run dev                   # http://localhost:3000
```

Mail sync runs on a cron in production. Locally it is polling only; trigger it by hand (see [docs/SETUP.md](docs/SETUP.md) section 6):

```bash
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/gmail-sync
```

Checks:

```bash
npm run typecheck
npm test                                   # unit tests
TEST_DATABASE_URL=postgres://... npm test  # also runs the Postgres tests (they wipe that database)
npm run build
```
