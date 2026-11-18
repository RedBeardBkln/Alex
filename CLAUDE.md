# Alex

Alex is a single-owner personal executive assistant (Next.js 16 App Router, TypeScript, Postgres on Neon via Drizzle, Google OAuth via `arctic`, Tailwind v4, Vitest), deployed on Vercel at https://alex.ericandeva.com. Start with `README.md`, `docs/ARCHITECTURE.md`, `docs/SETUP.md`, `src/db/schema.ts` and `src/lib/`.

Commands: `npm run typecheck`, `npm test`, `npm run build`, `npm run db:generate`, `npm run db:migrate`.

## Rules that bind everyone (main session and every agent)

**Draft, then approve.** Alex never sends an email, creates or accepts an invite, or posts anywhere without the owner's explicit approval in the approval queue. Tools that write or send only create approval items; only an approved item executes. Every proposal, approval, rejection, execution and failure is recorded in `audit_log`. No change may add a path around this.

**Working preferences.**
- Ask clarifying questions before giving detailed answers or making significant decisions.
- Never fabricate data, facts or opinions. If something can't be verified, say so plainly.
- Be honest, not agreeable: say when something is a bad idea or won't work.
- Double-check your work. Accuracy matters more than speed.
- Plan first and get the owner's approval before large changes. Work in phases, one PR per phase.
- Don't commit or push unless the owner asks. Never push to `main`. Never put secrets in the repo, and never ask the owner to paste secrets into chat.

**Decisions already made** (don't revisit unless the owner asks): see "Decisions" in `docs/ARCHITECTURE.md`. In particular, the AI runs in the app through the Claude API (`@anthropic-ai/sdk`, model `claude-opus-5-5`), and SDK and Google API usage must be checked against official docs, not guessed.

**Safety.**
- `TEST_DATABASE_URL` tests drop and recreate the schema. Never point it, or `DATABASE_URL` during development, at production.
- Never save secrets, tokens, email addresses, message content or other personal data to agent memory or pipeline files.

## Agent workflow

Every build (each phase, feature and fix) goes through the project agents in `.claude/agents/`, run with `/pipeline <task>`:

1. **planner**: writes `00-request.md` and `01-plan.md` (scope, out of scope, risks, acceptance criteria, test expectations).
2. **Owner approval**: the pipeline stops, shows the plan, and waits. Approval is recorded in `01a-approval.md`. No code is written before it exists.
3. **coder**: implements exactly the approved plan, runs typecheck/test/build, writes `02-implementation.md`. The coder also updates docs (`README.md`, `docs/`, `.env.example`) when behaviour, setup or env vars change.
4. **tester**: tries to break it, adds tests, writes `03-test-report.md` (PASS/FAIL). FAIL goes back to the coder, at most 3 rounds.
5. **reviewer**: reads the real diff, writes `04-review.md` (APPROVED/CHANGES_REQUESTED), routes back to the coder or planner. The reviewer is no longer the last stage, despite what its own file says; security review follows.
6. **security-reviewer**: writes `05-security-review.md` (SECURE/CHANGES_REQUESTED). A fix goes back through tester, reviewer and security-reviewer. A re-plan goes back to owner approval.
7. **Owner**: commits and opens the PR. No agent commits, pushes or opens a PR.

Artifacts live in `.claude/pipeline/<task-slug>/` and agent memory in `.claude/agent-memory/<agent>/`. Both are gitignored.

**Every agent must report what it verified and what it didn't**: the commands it actually ran with their real results, the files it actually read, and anything it could not check (for example live Google, Slack or reMarkable behaviour) and why. Nothing unverified may be described as working.
