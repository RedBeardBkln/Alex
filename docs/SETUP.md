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

Alex pulls INBOX mail from every connected Google account into its database: first a 30-day backfill per account, then only new mail. Gmail push notifications arrive through Google Cloud Pub/Sub, and a cron job polls every 5 minutes as a fallback. Alex only reads mail. It never sends, labels, archives or marks anything read.

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

Email HTML is rendered at ingest in a background worker. Its bundle, `.alex-build/render-worker.mjs`, is built automatically by `npm run dev`, `npm run build` and `npm test` (or by hand with `npm run build:worker`). If it is missing, HTML mail is stored as plain text and re-rendered by a later cron run once the worker is available.

Disconnecting an account stops its Gmail notifications and deletes all of its stored mail.

### 6.8 After merging: check the render worker in production

No preview check is needed, and none of these steps involves Preview environment variables: don't copy production secrets into Preview.

After the merge deploy, wait for the first `gmail-sync` cron run (at most 5 minutes). In the Vercel project's **Logs**, find the line `gmail-sync renders` for that run. It lists content-free counts by kind and reason, for example `{"html":12,"none":3}`. At least one `html` entry means the render worker is running in production. The line only appears when a run processed mail, so if there's none yet, send one of your connected addresses a short HTML email and check the next run.

If you only see `text:worker_unavailable`, the worker bundle didn't reach the function. Check that the build log shows `render worker bundled` (from `prebuild`).

**Fail-safe:** nothing is lost while the worker is missing or broken.
- HTML mail is stored and shown as plain text in the meantime, flagged "still being prepared".
- Those rows are stored without a sanitizer version, so the re-render step of a later cron run converts them to HTML once the worker works.
- `mail.render_worker_unavailable` is recorded once in the audit log.
