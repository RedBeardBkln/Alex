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
2. **Unified inbox** (Phase 2)
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

## Security model

- **Sign-in:** Google OIDC with PKCE and a state cookie. Only emails in `ALEX_ALLOWED_EMAILS` can sign in.
- **Sessions:** random 256-bit token in an httpOnly cookie. Only its SHA-256 is stored, and it expires after 30 days.
- **Mutations:** Server Actions, which have Next.js's built-in origin check.
- **Disconnecting an account** revokes the grant at Google, then deletes the stored tokens.
- **Least privilege:** `drive.file` instead of full Drive access. `gmail.modify` is needed to draft and send. (Google's client library lists `gmail.modify` as an accepted scope for `messages.send` and `drafts.send`.)
- **Indexing:** the app sends `noindex` metadata and denies framing.
