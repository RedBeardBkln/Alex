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

**About Testing status:** while the app is in Testing, Google expires each account's refresh token 7 days after you grant consent. Alex shows a "reconnect by" date on each account, and reconnecting takes one click. To get out of the 7-day limit, section 13 publishes the app **In production without verification**, which Google allows for apps with a limited audience (fewer than 100 users, who click through an "unverified app" warning). Whether Google then grants `gmail.modify` and keeps the tokens past 7 days can only be checked live; section 13 has the checks and the way back to Testing. Full verification, which includes a paid third-party security assessment for restricted scopes such as `gmail.modify`, isn't part of this.

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
   | `GOOGLE_OAUTH_TESTING_MODE` | `true` while the Google app is in Testing; `false` once it's published (unset means `true`) |

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
   - **Expiration period:** Never expire. The default is 31 days: a subscription with no activity (such as a successful push) for that long is deleted, and push stops.
2. The equivalent `gcloud` command is:
   ```bash
   gcloud pubsub subscriptions create gmail-push-alex \
     --topic=gmail-push \
     --push-endpoint=https://alex.ericandeva.com/api/gmail/push \
     --push-auth-service-account=alex-pubsub-push@<PROJECT_ID>.iam.gserviceaccount.com \
     --push-auth-token-audience=https://alex.ericandeva.com/api/gmail/push \
     --expiration-period=never
   ```
3. **Already created it?** Set the expiration on the existing subscription, either in the Console (the subscription → **Edit** → **Expiration period** → never expire) or with:
   ```bash
   gcloud pubsub subscriptions update gmail-push-alex --expiration-period=never
   ```
   If push does stop, mail still arrives through the 5-minute `gmail-sync` cron, just later.

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

Line endings: `.gitattributes` (`* text=auto eol=lf`) makes Git check out every text file with LF, even where `core.autocrlf=true` is set (Git for Windows sets it system-wide). The repository itself already stores LF. A working copy from before this file existed may still have CRLF files; refresh it once by deleting the tracked files and checking them out again. This discards uncommitted edits to tracked files, so commit or stash first, and run it only behind the clean-tree guard: `test -z "$(git status --porcelain)" && git ls-files -z | xargs -0 rm -- && git checkout -- .` (if the tree isn't clean, the guard fails and nothing is deleted). If it stops halfway (for example because a running dev server holds a file), stop the server and run `git checkout -- .` to restore the tracked files.

Disconnecting an account stops its Gmail notifications and deletes all of its stored mail. If you disconnect while an AI draft or triage is running, nothing is saved for it, you land on the Inbox with a note saying so, and the call still counts in AI usage. If the delete itself fails, the error is shown and `account.disconnect_failed` is audited; try again.

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
- On an item, check the From account, every recipient, the subject and the whole message, read any warnings, then click **Approve and send**. If the thread has messages newer than the one you're replying to, tick "I've seen the new messages" first. If more arrive while the page is open, approving shows the page again with a note; read them, tick the box and approve again.
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
     - What counts as a link: web links (also written without slashes or with backslashes, such as `https:example.test`), bare domains (including the domain of an email address, and forms with a port, `?`, `#` or a word and colon in front, such as `example.test:8080` or `Link:example.test`), links with any other scheme (`ftp://`, `smb://` and so on), `://` with an odd or look-alike scheme in front, links starting with `//`, and bare IPv4 addresses (an IP counts as known only if exactly that IP is in the thread). Every link in a word is checked, so a link hidden after another one (`https://known.test/?next=https://other.test`) is flagged too. It doesn't check other schemes without `//` (such as `javascript:` or `data:`; a domain after them still counts as a bare domain), bare IPv6 addresses, single-word hosts such as `localhost:3000`, or percent-encoded links inside another link. A four-part version number such as `1.2.3.4` is flagged too, because it looks like an IP, and so are glued forms such as `file.txt:12`.
     - **Always flagged, even if the thread mentions them:** network-share links (a word starting with two slashes of which at least one is a backslash, such as `\\host\share`, also after quotes or punctuation such as `“\\host\share”` or `:\\host`, or right after an `=`, such as `href=\\host\share`; `file:` followed by `/` or `\`; `smb:` followed by `/` or `\`), and the Windows handler schemes `search-ms:`, `search:` and `ms-…:` (such as `ms-msdt:`). A file-share link in a reply from your account is almost never legitimate.
     - Also checked: `//host` right after an `=` (such as `href=//other.test/x`), and domains whose last part is in punycode (`xn--…`, such as `example.xn--p1ai`; a bare domain counts only if that last part is typed in ASCII). A web link to such a domain (`http://example.xn--p1ai/`) is now flagged only if that domain isn't in the thread; before, it was always flagged.
     - A link inside a known link's path or query that has no real host (`https://known.test/x?next=http://localhost:3000`, `…?u=myapp://open`) no longer flags the whole link. Hosts inside it still count, also when more query text is glued on (`…?next=https://other.test&v=1` checks `other.test`, and so do `…?next=https://known.test@other.test&v=1` and `…?next=https://other.test&email=a@known.test`; a percent-encoded `@`, `%40`, is always flagged), and the always-flagged forms above still flag.
     - **Very long threads:** only the newest part is checked: at most 262,144 characters of each stored body field (text, rendered text, rendered HTML) and 2,097,152 characters in total, newest emails first, cut only between words. Headers and subjects are always checked in full. When the thread was cut, the page says so ("This thread is very long, so only its newest part was checked…"). A cut can only add warnings: a link that appears only in an older email may be flagged.
     - Not checked: bare domains with a non-ASCII last part (`example.рф`), a fullwidth colon (`https：//…`), and a number-only host after an odd scheme (`_://3405803785/`).
   - **Cost limits per draft:** everything the model sees from each email (sender, date, subject, body text and the formatting around them) is capped: 6,000 characters per email and 30,000 per thread, newest emails first; older emails beyond that are left out. Subjects are cut to 300 characters, dates to 100 and sender addresses to 254. Triage sees one email within 6,000.
     - The reserved estimate ($0.448 per draft, $0.0013 per triage) assumes at most about one token per character. Ordinary text uses far fewer. Unusual scripts or symbols could use more, so a draft on a thread built for it could cost somewhat more than the estimate: up to about $0.69 if they took 3 tokens per character. Alex can't check this exactly (Anthropic doesn't document tokens per character).
     - The estimate also allows 2,000 tokens for Alex's own instructions. The smoke run on 2026-11-20 measured about 1,584 for a draft and 1,539 for triage; a long instruction of your own (up to 2,000 characters) can take a draft slightly over that, by a fraction of a cent.
     - Successful calls are recorded at the usage Anthropic returns; the estimate is only used while a draft is running and for a call that fails without returning usage. Keep the Console spend limit (11.3) set as the hard backstop.
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

## 13. Publishing the Google app (Phase 0)

This gets the Google app out of Testing, so refresh tokens no longer expire after 7 days. The app is published **In production without verification**. Google allows that for apps with a limited audience (fewer than 100 users); each user clicks through a "Google hasn't verified this app" screen when connecting. Google's console only enables **Publish app** once the Branding page has a home page, a privacy policy and a terms of service link. Alex serves those as public pages: `/about`, `/privacy` and `/terms`.

**What `GOOGLE_OAUTH_TESTING_MODE` does.** It only changes the Accounts page. When it's `true`, each account shows "Google test mode: reconnect by <date>" (7 days after consent), and after that date it shows "Reconnect needed" even if the token still works. When it's `false`, there's no deadline, and only an account Google has actually rejected (for example after a revoked or expired token) shows "Reconnect needed". It changes nothing in the Google sign-in request, the scopes or the token handling. **Unset means `true`**, so it has to be set to `false` explicitly.

Tokens granted while the app was in Testing are expected to keep their 7-day expiry (Google's docs don't say otherwise). That's why every account is reconnected once, **after** publishing (step 7).

1. **After merge and deploy:** in a private browser window, open `https://alex.ericandeva.com/about`, `/privacy` and `/terms`. Each should load without signing in. `/` should still go to the sign-in page.
2. **Fill in the contact first,** if it wasn't done before merging: the `OWNER_CONTACT` constant in `src/app/(public)/site-info.ts` is what the pages show as the contact. Change `LAST_UPDATED` in the same file whenever the privacy policy or terms text changes.
3. **Google Auth Platform → Branding:**
   - App name `Alex`.
   - User support email: pick from the drop-down.
   - **No logo.** Uploading one makes Google verify the app before it's shown.
   - Application home page `https://alex.ericandeva.com/about`.
   - Application privacy policy link `https://alex.ericandeva.com/privacy`.
   - Application terms of service link `https://alex.ericandeva.com/terms`.
   - Authorized domains: make sure `ericandeva.com` is listed, and add it if not. Google says to add authorized domains before the URLs.
   - Developer contact email.
   - Save.
4. **If the console asks for domain verification:** verify `ericandeva.com` in Google Search Console with a Google account that is an owner or editor of the Cloud project. A Domain property is verified with a DNS TXT record, added wherever DNS for `ericandeva.com` is managed. Add a **new** TXT record; never edit or replace an existing TXT record (it usually holds SPF, and overwriting it breaks the domain's mail). This doesn't affect the main site. Skip this step if the console doesn't ask.
5. **Google Auth Platform → Audience → Publish app**, then confirm.
   - **Before publishing,** check that `ALEX_ALLOWED_EMAILS` in Vercel (Production) lists only your own addresses. Publishing removes Google's test-user gate: anyone with a Google account can then complete Google's sign-in for Alex, and the allow list is the only thing that keeps them out.
   - After publishing, refused sign-ins from strangers appear in the activity log as `login.denied` rows (they record only the email domain). That's expected, not an incident.
   - Don't click "Prepare for verification" or submit anything for verification.
   - If a "Verify branding" button appears, ignore it. Verification only matters for showing the app name and logo.
   - If Publish stays disabled or Google asks for verification, stop and tell the main session.
6. **Vercel → Project → Settings → Environment Variables:** set `GOOGLE_OAUTH_TESTING_MODE` to `false` for Production. The value must be exactly lowercase `false`: `False` or an empty value breaks most of the app. The signed-in pages, the cron jobs, the Google sign-in and connect routes and the server actions all read the configuration and fail; only the static `/about`, `/privacy` and `/terms` pages keep working. `/login` still loads when you aren't signed in, but signing in fails, and `/api/health` reports the database as unreachable even though it's fine. Don't delete it: unset means `true`. Then redeploy, so the new value is used.
7. **Reconnect every Google account** from the Accounts page (Reconnect, or Connect personal/business).
   - Expect Google's "Google hasn't verified this app" screen. Before clicking through it, check that the address bar shows `accounts.google.com` and that the screen names Alex's own app. Then choose **Advanced**, then the option to continue to the app's domain, then tick **every** permission. (Google's exact link wording wasn't verified.)
   - Sign-in only asks for name and email. Google's docs don't say whether it shows the warning screen too.
8. **Check:**
   - No account shows a "reconnect by" date.
   - **Test connection** works on each account.
   - About 8 days later, check that each account is still Active. That is the live check that production tokens don't expire after 7 days.
9. **Workspace account:** if connecting a Google Workspace account fails with an "access blocked" or admin-policy message, that Workspace's admin restricts third-party apps. The admin can mark Alex's OAuth client as **Trusted** under Admin console → Security → Access and data control → API controls → Manage App Access. If the console allows it, limit the setting to your own user or organizational unit. **Never set up domain-wide delegation**: Alex doesn't need it, and it would let the client act for every user in the domain. (These Admin console options weren't verified.) If you aren't the admin, ask them, or leave that account disconnected. An account in Google's Advanced Protection Program may block non-Google apps altogether.
10. **Fallback, if Google refuses `gmail.modify` for the unverified published app:**
    - Audience → **Back to testing**.
    - Make sure every account is still a test user.
    - Set `GOOGLE_OAUTH_TESTING_MODE=true` and redeploy.
    - Reconnect, and go back to weekly reconnects.
    - Tell the main session. Full verification (including the paid security assessment) is a separate decision.
11. **Keep the pages current:** if Alex starts using Google data in a new way (for example Calendar events in a later phase), update `/privacy` **before** that ships, and change `LAST_UPDATED`. That PR's plan must list it.
