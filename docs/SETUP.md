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
