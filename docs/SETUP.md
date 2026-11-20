# Deploying Alex

This guide sets up one Google OAuth client, a Neon Postgres database and a Vercel project, and serves the app at `alex.ericandeva.com`.

> Google's and Vercel's consoles change often. The menu names below were accurate when this guide was written, but they may have moved.

## 1. Google Cloud project

1. Go to https://console.cloud.google.com and create a project, for example `alex`.
2. Under **APIs & Services → Library**, enable **Gmail API**, **Google Calendar API** and **Google Drive API**.
3. Under **Google Auth Platform**, which some older consoles call **OAuth consent screen**, set:
   - **Audience:** user type **External**, publishing status **Testing**.
   - **Test users:** add *every* Google account you'll sign in with or connect. While the app is in Testing, only listed test users can complete the Google sign-in.
   - **Data access / scopes:** add these:
     - `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`
     - `https://www.googleapis.com/auth/gmail.modify`
     - `https://www.googleapis.com/auth/calendar.readonly`
     - `https://www.googleapis.com/auth/calendar.events`
     - `https://www.googleapis.com/auth/drive.file`
4. Under **Clients**, create an OAuth client of type **Web application** with these **Authorized redirect URIs**:
   - `https://alex.ericandeva.com/api/auth/google/callback`
   - `https://alex.ericandeva.com/api/accounts/google/callback`
   - `http://localhost:3000/api/auth/google/callback` (local development)
   - `http://localhost:3000/api/accounts/google/callback` (local development)
5. Copy the **client ID** and **client secret**.

**About Testing status:** while the app is in Testing, Google expires each account's refresh token 7 days after you grant consent. Alex shows a "reconnect by" date on each account, and reconnecting takes one click. Removing that limit for Gmail access means publishing the app and passing Google's verification, which includes a paid third-party security assessment for restricted scopes such as `gmail.modify`.

A business account on Google Workspace has another option. You can create a separate OAuth client in that Workspace's own Cloud project, with user type **Internal**. It isn't subject to the 7-day limit, but it only works for accounts in that domain. Alex doesn't support more than one OAuth client yet. Ask if you want it.

## 2. Database (Neon on Vercel)

1. In Vercel, open **Storage** (or the Marketplace), add **Neon Postgres**, and connect it to the project.
2. Make sure the project has a `DATABASE_URL` environment variable containing the **pooled** connection string.
3. From your machine, apply the schema:
   ```bash
   DATABASE_URL='<the pooled connection string>' npm run db:migrate
   ```
   Repeat this whenever a PR adds files under `drizzle/`.

## 3. Vercel project

1. Import `RedBeardBkln/alex` into Vercel. The framework preset is Next.js, and the defaults are fine.
2. Set these environment variables for Production:

   | Name | Value |
   |---|---|
   | `DATABASE_URL` | Pooled Neon connection string (step 2) |
   | `APP_URL` | `https://alex.ericandeva.com` |
   | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | From step 1 |
   | `ALEX_ALLOWED_EMAILS` | Comma-separated Google emails allowed to sign in, e.g. your personal and business addresses |
   | `ALEX_ENCRYPTION_KEY` | Output of `npm run gen:key`. Back it up somewhere safe: if it's lost, every account has to be reconnected. |
   | `GOOGLE_OAUTH_TESTING_MODE` | `true` while the Google app is in Testing |

3. Deploy.

## 4. Subdomain

1. In the Vercel project, go to **Settings → Domains**, add `alex.ericandeva.com`, and note the DNS record Vercel shows. It's usually a `CNAME` for `alex`.
2. Add that record wherever DNS for `ericandeva.com` is managed. This doesn't change the main site.
3. Wait until Vercel shows the domain as valid; it issues the HTTPS certificate on its own.

## 5. First run

1. Open `https://alex.ericandeva.com` and choose **Sign in with Google** with an address listed in `ALEX_ALLOWED_EMAILS`.
2. Click **Connect personal Google account** or **Connect business Google account** for each account, and leave every permission ticked.
3. Click **Test connection** on each account to confirm Gmail and Calendar respond.
4. To check the deployment itself, open `/api/health`. It returns `{"ok":true}` when the database is reachable.

## 6. Mail ingestion (Phase 2a)

Alex pulls INBOX mail from every connected Google account into its database: first a 30-day backfill per account, then only new mail. Gmail push notifications arrive through Google Cloud Pub/Sub, and a cron job polls every 5 minutes as a fallback. Ingestion only reads mail. It never sends, labels, archives or marks anything read. (Replies are sent only after you approve them in the queue; see section 9.)

Mail ingestion works with polling alone. Without the Pub/Sub steps below, new mail shows up within about 5 minutes instead of within seconds.

### 6.0 Database migration (do this first)

**Run this before merging the Phase 2 branch to `main`, because merging deploys to production.** Without the new tables, the Accounts page, the Inbox and the cron jobs fail as soon as the new code is live. The migration only adds tables (`drizzle/0001_mail_ingestion.sql`); it doesn't change Phase 1 tables, so it is safe to apply while the current version is still running.

```bash
DATABASE_URL='<the pooled connection string>' npm run db:migrate
```

### 6.1 Pub/Sub topic (Google Cloud Console)

Do all of this in the **same Google Cloud project as the OAuth client**. Gmail rejects a topic in a different project.

1. Under **APIs & Services → Library**, enable the **Cloud Pub/Sub API**.
2. Go to **Pub/Sub → Topics → Create topic**. Name it, for example, `gmail-push`, and untick "Add a default subscription". The full name is `projects/<PROJECT_ID>/topics/gmail-push`.
3. Open the topic, go to **Permissions → Add principal**, enter `gmail-api-push@system.gserviceaccount.com`, and give it the role **Pub/Sub Publisher**. This is Google's own service account that delivers Gmail notifications.

### 6.2 Push authentication

Pub/Sub signs every push request with an OIDC token for a service account you choose. Alex checks the token's signature, issuer, audience and service-account email, and rejects anything else.

1. Go to **IAM & Admin → Service Accounts → Create service account**, for example `alex-pubsub-push`. It needs no roles. Its email looks like `alex-pubsub-push@<PROJECT_ID>.iam.gserviceaccount.com`.
2. Under **IAM & Admin → IAM**, tick "Include Google-provided role grants", and make sure `service-<PROJECT_NUMBER>@gcp-sa-pubsub.iam.gserviceaccount.com` has **Service Account Token Creator**. Grant it if it's missing.
3. Whoever creates the subscription in the next step needs permission to act as that service account (`iam.serviceAccounts.actAs`, included in **Service Account User**). Project owners already have it.

### 6.3 Push subscription

1. Go to **Pub/Sub → Subscriptions → Create subscription** and set:
   - **Topic:** `gmail-push`
   - **Delivery type:** Push
   - **Endpoint URL:** `https://alex.ericandeva.com/api/gmail/push`
   - **Enable authentication:** ticked, with the service account from 6.2
   - **Audience:** set it explicitly to `https://alex.ericandeva.com/api/gmail/push`
   - Leave payload unwrapping off (wrapped delivery, the default).
2. The equivalent `gcloud` command is:
   ```bash
   gcloud pubsub subscriptions create gmail-push-alex \
     --topic=gmail-push \
     --push-endpoint=https://alex.ericandeva.com/api/gmail/push \
     --push-auth-service-account=alex-pubsub-push@<PROJECT_ID>.iam.gserviceaccount.com \
     --push-auth-token-audience=https://alex.ericandeva.com/api/gmail/push
   ```

### 6.4 Vercel environment variables

Add these for Production after the migration in 6.0, then **redeploy**. Vercel reads `CRON_SECRET` when it builds the cron jobs, so a redeploy is required after setting or changing it.

| Name | Value |
|---|---|
| `GMAIL_PUBSUB_TOPIC` | `projects/<PROJECT_ID>/topics/gmail-push` |
| `PUBSUB_PUSH_AUDIENCE` | `https://alex.ericandeva.com/api/gmail/push` (exactly the audience from 6.3) |
| `PUBSUB_PUSH_SERVICE_ACCOUNT` | The service account email from 6.2 |
| `CRON_SECRET` | Letters and digits only, at least 16 characters. Generate one with `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"` |

If `PUBSUB_PUSH_AUDIENCE` or `PUBSUB_PUSH_SERVICE_ACCOUNT` is missing, the push endpoint answers 503. If `GMAIL_PUBSUB_TOPIC` is missing, Alex doesn't register a Gmail watch, so no notifications are sent. In both cases mail still arrives through the 5-minute poll. If `CRON_SECRET` is missing or too short, the cron endpoints answer 401 and nothing syncs, so set it first.

### 6.5 Database migration

Done first, in step 6.0.

### 6.6 Check it's running

1. In the Vercel project, open **Settings → Cron Jobs** and check both jobs are listed: `/api/cron/gmail-sync` every 5 minutes and `/api/cron/gmail-watch` daily at 06:17 UTC.
2. The cron routes run for up to 300 seconds (`maxDuration = 300`), which needs fluid compute on the Pro plan. To check what a deployment was given, run `vercel inspect <deployment-url> --json` and look for a function timeout of 300.
3. Open the Accounts page. Each Google account shows its mail status: the backfill phase and progress, the last sync time and any error. The accounts that were already connected start their backfill on the next cron run. A busy account takes about an hour.
4. Open **Inbox** in the top bar.

### 6.7 Local development

Local development uses polling only, because Pub/Sub can't reach `localhost`. Leave the three Pub/Sub variables empty, set a `CRON_SECRET` in `.env`, and trigger a sync by hand:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/gmail-sync
```

Email HTML is rendered at ingest in a background worker. Its bundle, `.alex-build/render-worker.mjs`, is built automatically by `npm run build` and `npm test` (or by hand with `npm run build:worker`). `npm run dev` (`scripts/dev.mjs`) builds it, rebuilds it whenever a file it includes changes (the log shows `render worker rebundled`) and starts `next dev`. A worker that is already running keeps the old code until it is replaced, so restart `npm run dev` to test a sanitizer edit end to end; flags after `--` are passed to `next dev`, for example `npm run dev -- --port 3001`. If it is missing, HTML mail is stored as plain text and re-rendered by a later cron run once the worker is available.

Disconnecting an account stops its Gmail notifications and deletes all of its stored mail.

### 6.8 After merging: check the render worker in production

No preview check is needed, and none of these steps involves Preview environment variables: don't copy production secrets into Preview.

After the merge deploy, wait for the first `gmail-sync` cron run (at most 5 minutes). In the Vercel project's **Logs**, find the line `gmail-sync renders` for that run. It lists content-free counts by kind and reason, printed by Node as, for example, `gmail-sync renders { html: 12, none: 3 }`. Vercel's log viewer may show the object differently (not verified); the check is to find the `gmail-sync renders` prefix and look for `html`. At least one `html` entry means the render worker is running in production. The line only appears when a run processed mail, so if there's none yet, send one of your connected addresses a short HTML email and check the next run.

If you only see `text:worker_unavailable`, the worker bundle didn't reach the function. Check that the build log shows `render worker bundled` (from `prebuild`).

**Fail-safe:** nothing is lost while the worker is missing or broken.
- HTML mail is stored and shown as plain text in the meantime, flagged "still being prepared".
- Those rows are stored without a sanitizer version, so the re-render step of a later cron run converts them to HTML once the worker works.
- `mail.render_worker_unavailable` is recorded once in the audit log.

## 7. Optional: remove email addresses from old audit entries

Since phase-2a-followups, the `login`, `login.denied`, `account.connected` and `account.disconnected` audit entries no longer store an email address (`login.denied` keeps only the domain). Entries written before that still have an `email` key in `detail`. Nothing changes them automatically, and no migration touches them.

Removing the addresses from those old entries is **optional, manual and destructive**: it permanently changes the historical record, and it can't be undone. It's your call. If you do it, run it yourself against the production database (for example in the Neon SQL editor), never from a script or an agent.

1. Count the entries that still hold an address. This only reads:

   ```sql
   SELECT action, count(*) AS entries
   FROM audit_log
   WHERE action IN ('login', 'login.denied', 'account.connected', 'account.disconnected')
     AND detail ? 'email'
   GROUP BY action
   ORDER BY action;
   ```

2. Remove the `email` key from exactly those entries, inside a transaction:

   ```sql
   BEGIN;

   UPDATE audit_log
   SET detail = detail - 'email'
   WHERE action IN ('login', 'login.denied', 'account.connected', 'account.disconnected')
     AND detail ? 'email';
   ```

3. The `UPDATE` reports how many rows it changed. If that equals the total from step 1, run `COMMIT;`. Otherwise run `ROLLBACK;`, and nothing is changed.

Only the `email` key is removed; every other field and every other entry is kept.

## 8. Approval queue (Phase 2b): database migration

**Run this before merging Phase 2b to `main`, because merging deploys to production.** Without the new table, the app layout (the Queue badge), the queue pages and the cron's reconcile step fail as soon as the new code is live. The migration only adds three enum types and the `approval_items` table with its indexes (`drizzle/0002_approval_queue.sql`). It doesn't change any existing table, so it is safe to apply while the current version is still running. Apply 0001 first if it isn't applied yet (section 6.0); `npm run db:migrate` applies whatever is missing, in order.

```bash
DATABASE_URL='<the pooled connection string>' npm run db:migrate
```

No new environment variables and no new Google scopes are needed: `gmail.modify`, which every connected account already granted, is one of the scopes `messages.send` accepts.

## 9. Using the approval queue

- Open a thread in **Inbox** and click **Reply** or **Reply all**. The reply always goes out from the account that received the thread; the form shows it, and it can't be changed. Recipients are plain addresses, one per line. **Save for approval** creates a pending item; nothing is sent.
- **Queue** (top bar; the badge counts pending items and items needing attention) lists pending, needs-attention (not sent, outcome unknown) and done items.
- On an item, check the From account, every recipient, the subject and the whole message, read any warnings, then click **Approve and send**. If new messages arrived in the thread since you wrote the reply, tick "I've seen the new messages" first.
- **Not sent** (for example the account needs reconnecting, or Gmail refused it): edit it or click **Approve and send again**. Each attempt needs your click.
- **Outcome unknown** (Gmail didn't confirm, for example a timeout): Alex never resends it on its own. It looks for the message in Gmail on every 5-minute cron run and on **Check again**. If it can't be found after 30 minutes, check Gmail's Sent folder yourself, then use **Mark as not sent** if it really isn't there, and approve it again if you still want to send it.
- **New email (Phase 2d):** click **Compose** (top bar, or the button on Inbox).
  - **Pick the account to send from.** None is preselected; accounts that need reconnecting can't be picked.
  - Type the To and Cc addresses yourself: plain addresses, one per line, no names. An internationalised domain must be typed in its `xn--` form. There is no Bcc. The subject and the message can't be empty. **Save for approval** creates a pending item; nothing is sent.
  - On the item, **tick the box next to every recipient**, then click **Approve and send**. Alex refuses to send unless every recipient is ticked. Check any "First time" badge (an address Alex hasn't seen in your mail) and any internationalised-domain warning.
  - **Daily limit on first-time recipients:** at most `EMAIL_NEW_RECIPIENTS_PER_DAY` (default 10) first-time recipients can be approved per UTC day, across new emails **and replies**. In a reply, addresses already on the message you're replying to don't count (unless that message is in Spam or Trash), so only recipients you add count. Disconnecting an account doesn't reset the day's count. When the limit is reached the item stays pending ("Today's limit … resets at 00:00 UTC"); wait until then, or raise the value in Vercel (section 12.2) and redeploy. An item with more first-time recipients than the whole daily limit says so ("This email has N first-time recipients; the daily limit is X…") and can never be approved as it is: remove some recipients, or raise the limit. There is no override button.
  - The account can't be changed by editing: cancel and compose again. After it is sent, the conversation appears in Alex at the next sync (up to 5 minutes), linked from the queue item as **Open the conversation**. It isn't listed in Inbox until someone replies.

## 10. Live send check (on production, right after merging Phase 2b)

**Where and when (owner decision, 2026-11-19):** you run this check yourself on production (`https://alex.ericandeva.com`), right after the Phase 2 merge has deployed and migration 0002 is applied (section 8), **before any reply is sent to anyone else**.

- No preview deployment is used for it, and none is needed.
- No production secrets are copied anywhere (not into Preview, a local `.env` or chat).
- The first approved send goes **only to another of your own connected accounts**. Until every step below has passed, don't approve a reply to a third party.

The automated tests use a fake Gmail, so these behaviours of the real Gmail API are **not verified** until you run this check:

1. Pick two of your own connected accounts (A and B). Using Gmail itself, send a short plain-text email from B to A **with a non-ASCII character in its subject**, for example `Café test`. Wait for it to appear in Alex's Inbox under account A (within seconds with push, at most 5 minutes with the cron).
2. In Alex, open that thread, click **Reply**, type a short message and save it. **Keep the default subject** (`Re: Café test`) unchanged: changing it could itself break threading, and the default already tests the non-ASCII encoding.
3. On the queue item, check the screen shows From = account A, To = **only** account B's address (no Cc), the subject and the full text. Click **Approve and send**. Expect "Sent." and a Gmail message id.
4. In Gmail, check:
   1. In account B's inbox, the reply is in the same conversation as the original. In account A's Sent folder, it is in the same conversation too.
   2. The reply's From is account A's address.
   3. In account B, open the reply and choose **Show original**. Its `Message-ID` equals the one Alex generated. To see the one Alex generated, run this read-only query yourself in the Neon SQL editor: `SELECT message_id_header FROM approval_items ORDER BY created_at DESC LIMIT 1;`. (If Gmail replaced it, automatic reconciliation of "Outcome unknown" items can only work through ingestion, and you would resolve the rest by hand.)
   4. The non-ASCII subject displays correctly in both accounts.
5. The sent reply appears in the thread in Alex at the next 5-minute cron run. Gmail's push watch covers INBOX only, so no push notification arrives for the SENT copy.
6. Optional: click **Approve and send** again on the same item (or reload and resubmit the form). Expect "This item changed or was already handled", and no second email in Gmail.

Report the result of each step to the tester; until then the pipeline records these as "not verified live".

### 10.1 New message check (Phase 2d)

Run this on production right after the Phase 2 merge has deployed and migration 0004 is applied (section 12.1), **after the reply steps above have passed and before any new message to a third party**. Same rules as above: no preview deployment, no secrets copied anywhere, and the first new message goes only to another of your own connected accounts.

1. Click **Compose**. Check that **no account is preselected**. Pick account A and type **only account B's address** in To. Use a **unique** subject with a non-ASCII character, for example `Café compose test <today's date>`, and a short body. Save.
2. On the queue item, check:
   - From is A, the To list is exactly B, there is no Cc, and it says "No Bcc".
   - B has **no** "First time" badge (it is one of your own accounts).
   - Approval is refused until B's box is ticked. Optionally, approve without ticking it (if your browser lets you) and expect "Tick every recipient… Nothing was sent."
   - Tick the box and click **Approve and send**. Expect "Sent." and a Gmail message id.
3. In Gmail, check:
   - B receives it as a **new** conversation, not grouped into an older one.
   - Its From is A's address.
   - **Show original**: the `Message-ID` equals `message_id_header` (the same read-only SQL as step 4.3 above), and there is no `In-Reply-To` or `References` header.
   - The subject displays correctly.
   - A's Sent folder has it.
4. In Alex:
   - The message appears in Inbox under account B (normal ingestion).
   - Within about 5 minutes, the queue item shows **Open the conversation** for account A, and that thread opens with the sent message.
   - The conversation is **not** listed in Inbox under account A (it is sent-only until a reply arrives).
   - The queue item stays "Sent".
5. Optional cap check, **only to an address you control that is not a connected account**:
   - Set `EMAIL_NEW_RECIPIENTS_PER_DAY=0` in Vercel (Production), redeploy, compose to that address and open the queue item. Before approving, it already shows the warning "This email has 1 first-time recipient; the daily limit is 0, so it can't be sent as it is, on any day…". Tick the box and approve it anyway: expect the same text as the notice, and nothing arrives in that mailbox.
   - Then remove the variable (or set it back) and redeploy.
   - If you have no such address, skip this; the cap is then recorded as not verified live.

Report the results to the tester; until then the pipeline records them as "not verified live".

## 11. AI triage and reply drafts (Phase 2c)

Alex uses the Claude API for two things:
- **Triage:** Haiku 5.5 labels recent inbox mail with a category, a needs-reply flag and a one-line summary. This is advisory only: nothing is hidden or moved.
- **Drafts:** Opus 5.5 writes a reply's body text, but only when you click **Draft reply with AI**. The draft becomes a pending queue item. Recipients, account, subject and threading are set by Alex, and nothing is sent until you approve it.

Without an API key every AI feature is off and the app shows "AI not configured". Everything else works as before.

### 11.1 Database migration (before merging)

**Run this before merging Phase 2c to `main`.** Migration `drizzle/0003_ai.sql` only adds things:
- the value `ai` to the `approval_source` type
- three new enum types
- the tables `mail_triage` and `ai_calls`

It changes no existing column or row.

```bash
DATABASE_URL='<the pooled connection string>' npm run db:migrate
```

### 11.2 API key (Anthropic Console)

1. In the [Anthropic Console](https://platform.claude.com/), create an API key for Alex.
2. In Vercel, under **Settings → Environment Variables**, add `ANTHROPIC_API_KEY` for **Production** only. Paste it there directly: never into the repo, a file, a ticket or chat, and never into Preview.
3. Optionally, override the daily caps with the `AI_*` variables listed in `.env.example`. The defaults (owner decision) are:
   - triage: 400 calls and $0.50 a day
   - drafts: 25 calls and $3.00 a day
   - $3.50 a day overall

   A cap pauses that feature until midnight UTC.

### 11.3 Spend limit (Anthropic Console), as an external backstop

In the Anthropic Console, set a **monthly spend limit** for the organization or workspace that owns the key, for example about $110 (the $3.50 daily cap × 31). Alex's caps are estimates from a price table; the Console limit is enforced by Anthropic. When Anthropic answers that a spend limit is reached, Alex pauses AI triage and drafts for the rest of the UTC day.

### 11.4 Smoke check (owner-run, from your own terminal)

This sends **one fixed synthetic email**, never real mail, through the same request builders the app uses: one Haiku triage call and one Opus draft call.
- It has no database access.
- It prints only the stop reason, the token usage and the estimated cost, never model output.
- It confirms that the API accepts Alex's request shape.

1. Open a terminal in the repo.
2. Set the key in that shell only, for example with `read -rs ANTHROPIC_API_KEY && export ANTHROPIC_API_KEY` in bash (type or paste the key at the hidden prompt). Don't put it in a file.
3. Run:

   ```bash
   node --experimental-strip-types scripts/ai-smoke.mjs
   ```

4. Expect two lines (`triage:` and `draft:`). Each should show `stop_reason=end_turn`, non-zero `input` and `output`, and a small `cost_estimate`: roughly $0.001 for triage, a few cents for the draft.
5. Close the shell (or run `unset ANTHROPIC_API_KEY`).

Run `node --experimental-strip-types scripts/ai-smoke.mjs --dry-run` first if you only want to see that the requests build (no key, no call).

Tell the tester the two lines. If a call fails with `status=400`, the request shape needs changing, and the AI features must stay off (leave `ANTHROPIC_API_KEY` unset in Production) until it is fixed.

### 11.5 After merging: check AI on production

There is no preview deployment for this, and no production secret is copied anywhere. You do this on production, after the merge has deployed, migration 0003 is applied (11.1) and `ANTHROPIC_API_KEY` is set in Production (11.2).

1. **Triage:** wait for the next `gmail-sync` cron run (at most 5 minutes) after a new email arrives. In **Inbox**, recent threads show a category chip and a one-line summary, and the **Needs reply** tab lists the ones marked as needing a reply. Every thread is still listed under **All**.
2. **AI usage** (top bar): today's triage calls, tokens and estimated cost appear, and stay well under the caps.
3. **Draft:** open a thread from **one of your own other connected accounts**, click **Draft reply with AI** and wait (up to about a minute).
   - The queue item opens with the "AI draft" badge and "Written by AI (Opus 5.5); check every line".
   - From, To, Cc and the subject are the normal reply defaults.
   - Read the whole text and any warnings (new recipient, invisible characters, links not in the thread).
   - **What the links warning can't do:** it only flags links that appear nowhere in the thread. If the sender put a phishing link in their own email and the AI repeats it, the warning stays silent, because that link is "in the thread". It also doesn't flag a link on **any subdomain of a domain that already appears in the thread**: for example, if the thread mentions a big hosting or document platform, a link to anyone's site or file on a subdomain of that platform counts as "in the thread". Check every link in an AI draft yourself, whatever the warnings say.
   - **Known cost gap (until fixed):** only each email's body text is capped before it goes to the model. The subject and date lines are not, and they add up across every email in the thread. A sender who writes huge subject lines into a long thread can therefore make one draft cost a few dollars instead of the usual cents, and drafts started at the same time on several such threads can each do this. Triage has the same gap, at much smaller Haiku prices. A call that times out or fails without returning usage is counted at a fixed estimate ($0.448 for a draft), which can be less than Anthropic actually bills for such a thread. Drafts only run when you click. If **AI usage** shows a day's draft cost far above normal, stop drafting on unusually long threads, and keep the Console spend limit (11.3) set, because that is the hard backstop.
4. Approve it only if it is to your own account, as in the section 10 check. Otherwise reject it. Don't approve an AI draft to a third party until steps 1–3 have worked.
5. **Anthropic Console:** the Usage page shows the calls, and the cost is in line with Alex's AI usage page.

Report the results to the tester; until then the pipeline records live AI behaviour as "not verified".

## 12. Composing new messages (Phase 2d)

How to use it is in section 9; the production check is section 10.1. No new Google scopes are needed (`messages.send` accepts `gmail.modify`).

### 12.1 Database migration (before merging)

**Run this before merging Phase 2d to `main`.** Apply 0001–0003 first if they aren't applied yet (sections 6.0, 8 and 11.1); `npm run db:migrate` applies whatever is missing, in order. Migration `drizzle/0004_compose.sql` only adds things:
- the value `outbound` to the `mail_fetch_source` type (additive; not used in the same migration)
- the nullable column `approval_items.new_recipient_count`
- the table `approval_recipient_charges` (what each approval charged against the daily first-time-recipient cap; it keeps counting after an account is disconnected)
- the check constraint `approval_items_new_message_shape_chk` (an `email.send` item without threading has no thread or parent; every existing item is a reply, so it passes)

```bash
DATABASE_URL='<the pooled connection string>' npm run db:migrate
```

### 12.2 Environment variable (optional)

| Variable | Default | Meaning |
|---|---|---|
| `EMAIL_NEW_RECIPIENTS_PER_DAY` | `10` | First-time recipients (addresses Alex hasn't seen in your mail) that can be approved per UTC day, across new emails and replies. `0` means none. Empty or invalid means `10`. |

Set it in Vercel (Production) only if you want a different limit, then redeploy.
