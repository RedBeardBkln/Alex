# Alex

Alex is a personal executive assistant. It connects several Google accounts (personal and business), Slack, and a reMarkable tablet, and it handles email, scheduling and the tasks you hand it. It runs at `alex.ericandeva.com`.

**Ground rule:** Alex drafts and proposes, and you approve. Nothing is sent, booked or posted until you click approve.

## Status

| Phase | Scope | Status |
|---|---|---|
| 1 | Sign-in, connecting Google accounts (encrypted tokens), database, deployment | Done |
| 2a | Mail ingestion (Gmail push via Pub/Sub, polling fallback, 30-day backfill) and a combined inbox | Done |
| 2b | Approval queue and replies (plain text, sent only after you approve) | Done |
| 2c | AI triage (Haiku 5.5, advisory) and reply drafts on request (Opus 5.5), sent only after you approve; daily cost caps | Done |
| 2d | Composing new plain-text emails: you pick the account and type every recipient, tick each recipient to approve, with a daily cap on first-time recipients | Done |
| Phase 2 follow-ups | Three hardening batches after 2a–2d (approval and AI safety, link warnings, bounded link checks) | Done |
| 0 | Google OAuth publishing: public About, Privacy and Terms pages, and the app published unverified with every account reconnected ([SETUP §13](docs/SETUP.md)) | Done |
| H1 | Link-warning hardening (percent-encoded links inside links and other gaps) and docs fixes | Done |
| T | Tasks: to-dos with deadlines, "Add task" from a thread, in-app reminders | Planned |
| H2 | AI and approval hardening, and older nits | Planned |
| C1 | Calendar, read side (formerly Phase 3): free/busy across accounts, agenda, pending invites, finding slots, proposing times in a reply | Planned |
| C2 | Calendar, write side: creating events with invites and answering invites, only through the approval queue | Planned |
| D | Delegation assistant: a typed request runs a Claude tool-use loop over Alex's data | Planned |
| S | Slack (formerly Phase 4): mentions, and replies through the approval queue | Planned |
| R | reMarkable (formerly Phase 5): handwriting turned into suggested tasks and proposed meetings | Planned |
| H3 | Sanitizer and dev-tooling nits | Planned |

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design and [docs/SETUP.md](docs/SETUP.md) to deploy.

## Stack

- Next.js 16 (App Router, TypeScript) on Vercel
- Postgres (Neon) with Drizzle ORM
- Google OAuth through [arctic](https://arcticjs.dev), with PKCE and state checks
- Tokens encrypted with AES-256-GCM at rest
- Claude API (`@anthropic-ai/sdk`), called from the app itself (Phase 2c: triage and reply drafts; optional, see [docs/SETUP.md](docs/SETUP.md) section 11)

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
