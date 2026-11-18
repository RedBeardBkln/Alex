# Handoff: continuing Alex in Claude Code (Windows / PowerShell)

## Part 1: Run these in PowerShell yourself

You need Git, Node.js 22 LTS or newer, and Claude Code. Check that they're installed:

```powershell
git --version
node -v
claude --version
```

If one is missing, install it with these commands:

```powershell
winget install --id Git.Git -e
winget install --id OpenJS.NodeJS.LTS -e
npm install -g @anthropic-ai/claude-code
```

Close and reopen PowerShell afterwards so the new commands are found.

Then get the code and start Claude Code:

```powershell
cd $HOME
git clone https://github.com/RedBeardBkln/alex.git
cd alex
git checkout ccr-3d9e4f7e-vongjt
npm install
claude --add-dir "D:\Repos\_agent-team-staging"
```

`--add-dir` gives Claude Code access to your agent-team staging folder, which sits outside this project, so it can read the agents there and copy them in.

## Part 2: Paste this into Claude Code as your first message

```text
You are taking over development of "Alex", my personal executive assistant web app. Read this whole message before doing anything.

## How I want you to work
- Ask clarifying questions before giving detailed answers or making significant decisions.
- Never fabricate data, facts or opinions. If you can't verify something, say so plainly.
- Be honest, not agreeable: tell me when something is a bad idea or won't work.
- Double-check your work. Accuracy matters more than speed.
- Plan first and get my approval before large changes. Work in phases, one PR per phase.
- Don't commit or push unless I ask. Never push to main. Never put secrets in the repo, and never ask me to paste secrets into chat.

## Project facts
- Repo: https://github.com/RedBeardBkln/alex (this folder). Single-owner app: I'm the only user.
- Hosted on Vercel (Pro plan) at https://alex.ericandeva.com, a subdomain of ericandeva.com.
- Stack: Next.js 16 (App Router, TypeScript), Postgres on Neon via Drizzle ORM, Google OAuth via the `arctic` library, Tailwind v4, Vitest.
- Read these first: README.md, docs/ARCHITECTURE.md, docs/SETUP.md, src/db/schema.ts, src/lib/*.

## Decisions already made (don't revisit unless I ask)
1. Autonomy is "draft, then approve". Alex never sends an email, creates or accepts an invite, or posts anywhere without my explicit approval in an approval queue. Every action goes in audit_log.
2. The AI runs inside the Vercel app through the Claude API (Anthropic TypeScript SDK, @anthropic-ai/sdk), not Managed Agents, so email content stays in my database. Use model `claude-opus-5-5` unless I say otherwise. Check SDK usage against the official docs, and don't guess API shapes.
3. Integrations: several Google accounts (Gmail, Calendar, Drive) labelled personal or business; Slack; and my reMarkable tablet (I have a Connect subscription). Tasks are stored inside Alex.
4. Google OAuth scopes: gmail.modify, calendar.readonly, calendar.events, drive.file. These were checked against the per-method scope lists in Google's official client libraries. The Google OAuth app is External and in "Testing" status, so refresh tokens expire 7 days after consent. The app already shows a "reconnect by" date for this.
5. The Google OAuth client is NOT marked "Use this client for an AI-powered agent". Alex calls the Gmail and Calendar REST APIs directly, not Google's Workspace MCP servers, and this client also handles my human sign-in. If we ever use Google's MCP servers, create a separate client with that box checked.
6. Neon on Vercel is connected with no custom prefix. The app reads `DATABASE_URL`, which should be the pooled connection string.

## Current state
- Phase 1 is done and open as draft PR #1 (https://github.com/RedBeardBkln/alex/pull/1), on branch `ccr-3d9e4f7e-vongjt`, not yet merged. It includes:
  - Google sign-in restricted to ALEX_ALLOWED_EMAILS.
  - Connecting multiple Google accounts.
  - AES-256-GCM token encryption.
  - Automatic token refresh, with reauth flagging on invalid_grant.
  - An accounts page with test connection, relabel and disconnect (which revokes the grant at Google).
  - Audit log, /api/health and security headers.
  - 21 tests, 7 of which need a Postgres database through TEST_DATABASE_URL and are skipped without it.
- What was verified: typecheck, build, all tests against a local Postgres, and manual checks of redirects and the UI.
- NOT yet verified: a real Google sign-in or account connection.
- My setup progress:
  - Google OAuth client created, with redirect URIs added.
  - Neon added in Vercel.
  - Still to confirm: Vercel environment variables, `npm run db:migrate` against production, the `alex` CNAME record, and a first real sign-in.
  - Walk me through any of these I haven't finished, following docs/SETUP.md.

## Remaining phases (see docs/ARCHITECTURE.md)
- Phase 2:
  - Unified inbox across all Google accounts. Use Gmail push through Pub/Sub, with polling as a fallback.
  - AI triage and reply drafts.
  - The approval queue (approve, edit or reject, then execute, then audit).
  - Replies always go out from the account that received the email.
- Phase 3: calendar. Free/busy across all accounts, proposing times, sending invites through the approval queue.
- Phase 4: Slack. A Slack app with OAuth and the Events API. Posting goes through the approval queue.
- Phase 5: reMarkable. Research (done 2026-11-17) found:
  - No official reMarkable cloud API. Use the unofficial `rmapi-js` (TypeScript, actively maintained, supports sync schema v3/v4; v14.4.2 released 2026-11-15).
  - Auth: an 8-character code from my.remarkable.com/device/desktop/connect, exchanged for a device token, which then yields a session token.
  - Detect changes by polling the root hash, then fetch only the changed notebooks and pages.
  - Draw the strokes to SVG and convert to PNG (rmapi-js parses .rm v6 but doesn't render). Claude vision reads the handwriting.
  - Extracted tasks and meetings go to the approval queue, linked to the source page.
  - Risks: reverse-engineered and has broken before (the 2025 schema-v4 change); the terms of service haven't been read yet. Alert me on sync errors, and keep an email-to-Alex import as a fallback.

## My agent team
I keep a set of Claude Code agents in D:\Repos\_agent-team-staging. I want them added to this project, so that every new build (each phase, feature and fix) goes through those agents rather than being done ad hoc. You don't know what's in that folder yet, so don't assume anything:
1. Inspect: list everything in D:\Repos\_agent-team-staging recursively and read each file. Report back with:
   - each agent's name, its role (from its description) and the tools and model it declares
   - any other pieces besides agents (skills, slash commands, hooks, settings.json, a CLAUDE.md or a workflow document), and what each one does
   - any file that isn't a valid Claude Code agent definition (Markdown with YAML frontmatter that has at least `name` and `description`)
   - anything that must not go into this repo: secrets, API keys, tokens, absolute paths specific to my machine, or references to other projects
2. Propose: say where each item goes in this project. Project agents go in `.claude/agents/`, skills in `.claude/skills/`, commands in `.claude/commands/`, and hooks or settings in `.claude/settings.json`. Describe the build workflow they imply, meaning which agent handles planning, implementation, testing, review, security and docs, and in what order. Point out gaps or overlaps. Wait for my approval.
3. Install, after I approve: copy the approved files into this project. Don't change their content unless I agree to an edit. Keep the originals in the staging folder; copy, don't move.
4. Wire it up: create or update a `CLAUDE.md` at the project root with an "Agent workflow" section. It should state the approved order of agents for each build, make the "draft, then approve" rule and my working preferences above binding on every agent, and require each agent to report what it verified and what it didn't.
5. Verify: run `/agents` and confirm every copied agent is listed and loads without errors. Report anything that failed to load.
6. Commit: put these files in one commit on branch `ccr-3d9e4f7e-vongjt`, but only when I say so, and after showing me `git diff --stat`.

## Your first steps
1. Read the files listed above and run `npm run typecheck`, `npm test` and `npm run build` to confirm a clean baseline on Windows. Report the results exactly.
2. Do the "My agent team" steps 1–2 (inspect and propose), and wait for my approval before installing.
3. Ask me where I am in docs/SETUP.md and help me finish deployment and a first real sign-in.
4. Then propose a detailed Phase 2 plan, built around the approved agent workflow (data model, API routes, UI, Claude prompt and tool design, tests). Wait for my approval before writing code.
```

## Notes

- **Postgres-backed tests.** To run all 21 tests on Windows, you need a Postgres database you can wipe. Set `$env:TEST_DATABASE_URL = "postgres://..."` before running `npm test`. Never point it at production: the tests drop and recreate the schema.
- **Local development.** Create `.env` from `.env.example`. For `DATABASE_URL`, use a separate Neon branch or a local database, not production.
