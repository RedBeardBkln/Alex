# Alex architecture

## Decisions (agreed 2026-11-17)

| Topic | Decision |
|---|---|
| Users | Single owner. Every allowed email signs in as the same owner. Data is still scoped by `user_id` so a second user could be added later. |
| Autonomy | **Draft, then approve.** Every outbound action is queued for approval. |
| AI runtime | Claude API, called from inside the Vercel app. Email content stays in our own database. |
| Hosting | Vercel (Pro) and Neon Postgres, at `alex.ericandeva.com`. |
| Integrations | Several Google accounts (Gmail, Calendar, Drive), Slack, reMarkable (with a Connect subscription). |
| Tasks | Stored in Alex. Google Tasks sync is optional later. |

## Components

1. **Connected accounts** (Phase 1)
   - Table `connected_accounts`: one row per external account, labelled `personal` or `business`.
   - Tokens are encrypted with AES-256-GCM using `ALEX_ENCRYPTION_KEY` and are never sent to the browser.
   - Access tokens refresh automatically.
   - If Google rejects the refresh token (`invalid_grant`), the account is flagged `reauth_required`.
2. **Unified inbox** (Phase 2a: ingestion and a read-only inbox; see "Mail ingestion" below)
   - New mail from each Google account arrives through Gmail push notifications (Pub/Sub), with polling as a fallback.
   - Every message stays tied to its account, so replies always go out from the address that received the email.
3. **Delegation** (Phases 2–3)
   - A typed request becomes a Claude tool-use loop. Its tools are search mail, read thread, check free/busy, draft reply and propose meeting.
   - Read-only tools run directly.
   - Tools that write or send never run directly. They create an **approval item**.
4. **Approval queue** (Phase 2)
   - Each pending action (send email, create or accept an invite, post to Slack) can be approved, edited or rejected.
   - Only an approval runs the action, and everything is recorded in `audit_log`.
5. **Slack** (Phase 4)
   - A Slack app connected by OAuth, using the Events API for messages that mention you.
   - Posting goes through the approval queue.
6. **reMarkable** (Phase 5)
   - Sync uses `rmapi-js`, an unofficial, reverse-engineered client for reMarkable's cloud. It supports sync schema v3 and v4.
   - A cron job checks the root hash and fetches only changed notebooks and pages.
   - Pages are drawn as SVG and converted to PNG. Claude reads the handwriting from the image, and the extracted tasks and meetings go into the approval queue linked to the source page.
   - Risks: reMarkable has no official API, the sync format has changed before (the 2025 schema-v4 break), and the terms of service still need reading. Mitigation: alert on sync errors, and keep a manual email-to-Alex import as a fallback.

## Mail ingestion (Phase 2a)

One-way, read-only sync from Gmail into Postgres. The only Gmail calls that change anything are `users.watch` and `users.stop`, which configure push notifications. Nothing is sent, labelled, archived or marked read.

**Tables** (`drizzle/0001_mail_ingestion.sql`). Every row carries `user_id` and the receiving `account_id`, and is deleted with the account (ON DELETE CASCADE).

| Table | Purpose |
|---|---|
| `mail_sync_state` | One row per Google account: the history cursor (`history_id`, stored as text because Gmail ids are uint64), watch expiry, backfill or resync phase and page token, a per-account lease, and the last content-free error. |
| `mail_fetch_queue` | Message ids waiting to be fetched, unique per account. `needs_classify` means the labels aren't known yet. Parked rows (repeated permanent failures) sit at year 9999. |
| `mail_threads` | One row per Gmail thread per account. `in_inbox` and `has_unread` are derived from the stored messages' labels and recomputed in the same transaction as every change. |
| `mail_messages` | Headers (including Message-ID, In-Reply-To and References for replies in 2b), the full header list, text and raw HTML bodies, current `label_ids`, and the ingest-time rendering (`render_kind`, `rendered_html`, `rendered_html_remote`, `rendered_text`, `sanitizer_version`, …). |
| `mail_attachments` | Attachment metadata only: filename, type, size and Gmail attachment id. Attachment content is never downloaded. |

**Endpoints**

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/gmail/push` | Pub/Sub OIDC token: Google signature, issuer, `PUBSUB_PUSH_AUDIENCE`, `PUBSUB_PUSH_SERVICE_ACCOUNT`, `email_verified` | Records the push and answers 204, then syncs that account in `after()`. The notification's historyId is never used as the cursor. |
| `GET /api/cron/gmail-sync` (every 5 min) | `Authorization: Bearer $CRON_SECRET` | For every account: setup if needed, watch renewal within 24 h of expiry, history sync, backfill or resync listing, and fetching within a 240 s budget. |
| `GET /api/cron/gmail-watch` (daily 06:17 UTC) | same | Renews every active account's watch (Gmail watches expire after 7 days). |

**Sync algorithm** (`src/lib/gmail/sync.ts`)

1. **Setup** (on connect, or the first cron run for an existing account): store the `getProfile` historyId as the cursor *before* listing, register `users.watch` on INBOX, and start a 30-day backfill.
2. **Backfill**, resumable across runs: list INBOX `after:<epoch seconds>`, then list SENT over the same window and keep only messages in threads Alex already knows (list results carry threadId, so this costs no extra calls). Then fetch everything queued.
3. **History sync** on every run: `history.list` from the cursor with all four history types and no label filter. Added messages are queued (INBOX, or SENT in a known thread; DRAFT, SPAM and TRASH are never stored). Label changes and deletions update stored messages directly, with no Gmail fetch. Because history messages usually carry only id and threadId, an unknown new message gets one `format=minimal` get to read its labels first. The cursor moves only after the last page has been applied.
4. **Expired cursor** (history.list 404): take a new cursor from `getProfile`, re-list INBOX and SENT from `max(last sync - 1 day, now - 30 days)`, and refresh the labels of stored messages in that window. Older stored messages keep their last-known labels.
5. **Fetching**: history and resync rows first, then backfill inbox, then backfill sent. One `format=full` get per message, then MIME parsing (`src/lib/gmail/mime.ts`). A text body part that Gmail returns by attachment id is fetched with `messages.attachments.get`; that is the only use of that endpoint. A sent message whose thread isn't stored yet is deferred for a minute at a time (`deferred_at`/`defer_count` on the queue row). While an inbox message for that thread is still queued, the wait uses up no attempts, so a reply behind a long backfill or resync isn't lost; deferred sent messages never count as that inbox message, so two can't wait on each other. With no queued inbox message, or after 1,440 deferrals (counted only while the account actually syncs), it gets 5 tries and is then dropped. 429 and 5xx back off (30 s doubling, capped at 1 h) and stop the account for that run; a row is parked after 24 transient failures (about a day), and after 5 other failures, so a message Gmail never serves can't hold a backfill open. Gmail ids are checked against `[A-Za-z0-9_-]` before any URL is built. Push-triggered syncs are debounced per account (5 s). Calls are paced at about 4,800 quota units per minute per account.
6. **Concurrency**: a per-account lease row (`lease_until`, database clock) means two runs never sync the same account at once. Cron delivery can be duplicated, so every step is idempotent.
7. **Reauth**: accounts that aren't `active` get no Gmail calls. A rejected refresh token stops only that account.

**Audit log** (lifecycle and errors only, never content, addresses or tokens): `mail.watch_registered`, `mail.watch_renewed`, `mail.watch_failed`, `mail.watch_stopped`, `mail.backfill_started`, `mail.backfill_completed`, `mail.resync`, `mail.sync_error` (on the first failure after a success, or when the error changes), `mail.sync_skipped_reauth` (once per transition), `mail.rerender_progress {rendered, remaining}` (a cron re-render run that rendered something), and `mail.render_worker_unavailable` (once per process when the render worker can't be started).

**Account and login audit entries** hold no email address (`src/lib/audit-details.ts`): `login` has no detail (`user_id` identifies the owner), `login.denied {domain}` keeps only the refused address's domain, `account.connected {label}` (the account is the entry's `account_id`), `account.label_changed {label}`, and `account.disconnected {accountId, provider, label}` (the row is already deleted, so its uuid goes in `detail`). Entries written before this change are left as they are; `docs/SETUP.md` §7 has an optional manual SQL to remove their addresses.

**Rendering email HTML** (`src/lib/email-html.ts`, `src/lib/email-css.ts`, `src/lib/email/`): bodies are stored raw and sanitized **once, at ingest**, into stored render columns (see "When and where it runs" below).

- **HTML structure:** `sanitize-html` with a tag and attribute allowlist.
  - Scripts, frames, forms, `on*` handlers, `javascript:`/`data:` links and `<link>`/`<meta>`/`<base>` are removed.
  - The HTML `background` attribute is removed in both modes.
  - `<img src/srcset>` is the only image path: `data:` always, absolute `https:` only with "Show remote images".
- **CSS is parsed, not filtered.** Style elements and style attributes are tokenized and parsed with `@csstools/css-tokenizer` and `@csstools/css-parser-algorithms` (a CSS Syntax Level 3 implementation). They are mapped onto an allowlist of properties, value types and selectors, and **regenerated** by our own serializer from decoded values. No original CSS text passes through.
  - Every `url()` (in any form, `data:` included) and every at-rule except `@media` is dropped, in both modes, so CSS can never load anything.
  - Kept: colours, a colour-only `background` (a mixed shorthand keeps only its colour), fonts by name, text, box, sizing, `display`, `float`, `position: static|relative|absolute` with offsets and `z-index`, table and list properties, and simple selectors.
  - Dropped: custom properties, `var()`, `calc()`, gradients, vendor and `mso-*` properties, pseudo-elements and functional pseudo-classes.
  - Every output is checked in production against a restricted character set and re-tokenized (no url, bad-string, comment, function other than `rgb`/`rgba`/`hsl`/`hsla`, or at-rule other than `@media`). If the check fails, that CSS is dropped.
- **Caps and the final check:** 128 KB of CSS per style block or attribute and 128 KB per message (UTF-16 code units; owner decision, Round 7), 100 parse errors and a nesting depth of 32. Over a cap, that CSS is dropped and the message still renders. A final structural check requires that no `<style>` text contains `<` and that every tag is on the allowlist; otherwise the message is shown as plain text.

**When and where it runs (Revision 4, "sanitize at ingest"):** the sanitizer runs once per message, during hydration in the sync job (cron, post-push and post-connect), and never on a page view.

- **Routing** (`src/lib/email/render.ts`, all linear and Alex's own code on the main thread):
  - no HTML body gives `render_kind = 'none'`
  - a body over 256 KiB (262,144 UTF-16 code units) gives plain text, reason `too_large`
  - nesting deeper than 512 (a linear pre-scan, `src/lib/email/plain-text.ts`) gives plain text, reason `too_deep`, without ever reaching the HTML parser
  - everything else goes to the render worker
- **The render worker:** a `worker_threads` worker running `sanitize-html` + the CSS allowlist, one per process, reused, with jobs run in order.
  - Each job (both variants) has a hard **2,000 ms** wall-clock limit. Past it, the worker is terminated and respawned for the next job, and the message is stored as plain text with reason `timeout`.
  - A crash gives `crash` and a structural-check failure gives `postcheck`. A missing or non-starting worker gives `worker_unavailable`, with no sanitizer version so it is retried later, plus one `mail.render_worker_unavailable` audit per process.
  - The worker heap is capped at 256 MB.
  - The worker is prebundled by esbuild (`scripts/build-render-worker.mjs`, run by `prebuild` and `pretest`; `npm run dev` runs `scripts/dev.mjs`, which rebuilds it in esbuild watch mode) to `.alex-build/render-worker.mjs`, which is gitignored and included in the sync, push and connect functions with `outputFileTracingIncludes`.
- **Hydrate budget:** a row is only started when at least 7 s (the render limit plus margin) of the run's 240 s budget remains.
- **Plain text** is produced by Alex's own single-pass scanner. It uses the message's text part if there is one, otherwise the HTML with tags, comments and script/style contents dropped. Output is capped at 256 Ki characters and shown as React text, never as HTML.
- **Stored:** the render columns on `mail_messages`:
  - `render_kind` (`html`, `text` or `none`), `render_reason`
  - `rendered_html` (default variant) and `rendered_html_remote` (https `<img>` kept; NULL when identical, and the "Show remote images" link only appears when it exists)
  - `rendered_text`, `render_truncated`, `sanitizer_version`, `rendered_at`
  
  The raw `body_html` stays as the source for re-rendering.
- **Versioning:** `src/lib/email/version.ts` holds `SANITIZER_VERSION` and `MIN_DISPLAYABLE_SANITIZER_VERSION`. A test pins a hash of the sanitizer source files, so any change forces a version decision.
  - Each 5-minute cron run re-renders stored messages whose version is missing or lower (newest first, in batches of 25, within the budget) and records `mail.rerender_progress {rendered, remaining}`.
  - Stored HTML below the minimum displayable version is not shown; the text body or "being prepared" is shown instead.
- **The page** (`/inbox/[threadId]`) only reads the stored columns (never `body_html`). A test checks that its import graph doesn't reach the sanitizer, its CSS module, the renderer or the scanner.
- **The iframe:** the stored HTML is wrapped by `src/lib/email/shell.ts` in an `<iframe sandbox="allow-popups allow-popups-to-escape-sandbox">` (no scripts, no same origin) with a meta CSP of `default-src 'none'; img-src data:; style-src 'unsafe-inline'`. A per-message "Show remote images" link (not saved) switches to the stored remote variant and widens `img-src` to `https:` for that message only.

## Security model

- **Sign-in:** Google OIDC with PKCE and a state cookie. Only emails in `ALEX_ALLOWED_EMAILS` can sign in.
- **Sessions:** random 256-bit token in an httpOnly cookie. Only its SHA-256 is stored, and it expires after 30 days.
- **Mutations:** Server Actions, which have Next.js's built-in origin check.
- **Disconnecting an account** stops Gmail notifications (best-effort), revokes the grant at Google, then deletes the stored tokens and all of that account's stored mail.
- **Least privilege:** `drive.file` instead of full Drive access. `gmail.modify` is needed to draft and send. (Google's client library lists `gmail.modify` as an accepted scope for `messages.send` and `drafts.send`.)
- **Indexing:** the app sends `noindex` metadata and denies framing.
- **Machine endpoints:** the Pub/Sub push endpoint verifies Google's OIDC token and fails closed (503) when its settings are missing. The cron endpoints require `CRON_SECRET` and fail closed (401) when it's missing. A push is only a trigger: Alex always fetches from Gmail itself.
- **External email HTML** is sanitized and rendered in a sandboxed iframe, with remote content blocked by default (see "Mail ingestion").
