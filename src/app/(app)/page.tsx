import { db } from "@/db";
import { listAccounts, type AccountSummary } from "@/lib/accounts";
import { env } from "@/lib/env";
import { reconnectBy } from "@/lib/google";
import { requireUser } from "@/lib/session";
import { disconnect, updateLabel } from "./actions";
import { TestConnectionButton } from "./test-connection-button";
import { LocalTime } from "../local-time";

const ERRORS: Record<string, string> = {
  cancelled: "Connecting the account was cancelled.",
  state: "The connection request expired. Please try again.",
  google: "Google didn't complete the connection. Please try again.",
  missing_scopes:
    "Some permissions were unticked on Google's screen. Alex needs all of them (mail, calendar, Drive files) — please connect again and leave every box ticked.",
};

export default async function AccountsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; connected?: string; email?: string }>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const accounts = await listAccounts(db(), user.id);
  const testingMode = env().GOOGLE_OAUTH_TESTING_MODE;

  return (
    <div className="space-y-6">
      <section>
        <h1 className="text-2xl font-semibold">Connected accounts</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Alex reads, drafts and schedules across these accounts. Nothing is sent without your approval.
        </p>
      </section>

      {params.connected && (
        <p role="status" className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm">
          Connected {params.connected}.
        </p>
      )}
      {params.error && ERRORS[params.error] && (
        <p role="alert" className="rounded-md border border-[var(--border)] bg-[var(--warn-bg)] px-3 py-2 text-sm">
          {params.email ? `${params.email}: ` : ""}
          {ERRORS[params.error]}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <a href="/api/accounts/google/connect?label=personal" className="rounded-md bg-[var(--accent)] px-3 py-2 text-sm font-medium text-[var(--bg)]">
          Connect personal Google account
        </a>
        <a href="/api/accounts/google/connect?label=business" className="rounded-md bg-[var(--accent)] px-3 py-2 text-sm font-medium text-[var(--bg)]">
          Connect business Google account
        </a>
      </div>

      {accounts.length === 0 ? (
        <p className="text-sm text-[var(--muted)]">No accounts connected yet.</p>
      ) : (
        <ul className="space-y-3">
          {accounts.map((a) => (
            <AccountCard key={a.id} account={a} testingMode={testingMode} />
          ))}
        </ul>
      )}
    </div>
  );
}

function AccountCard({ account: a, testingMode }: { account: AccountSummary; testingMode: boolean }) {
  const deadline = reconnectBy(a.consentedAt, testingMode);
  const msLeft = deadline ? deadline.getTime() - Date.now() : null;
  const needsReauth = a.status !== "active" || (msLeft !== null && msLeft <= 0);
  const soon = msLeft !== null && msLeft > 0 && msLeft < 24 * 60 * 60 * 1000;

  return (
    <li className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-medium">{a.email}</p>
          <p className="text-sm text-[var(--muted)]">
            Google · {a.label === "business" ? "Business" : "Personal"}
            {a.displayName ? ` · ${a.displayName}` : ""}
          </p>
        </div>
        <span
          className={`rounded-full px-2 py-0.5 text-xs ${needsReauth ? "bg-[var(--warn-bg)] text-[var(--danger)]" : "border border-[var(--border)] text-[var(--muted)]"}`}
        >
          {needsReauth ? "Reconnect needed" : "Active"}
        </span>
      </div>

      {deadline && !needsReauth && (
        <p className={`mt-2 text-sm ${soon ? "text-[var(--danger)]" : "text-[var(--muted)]"}`}>
          Google test mode: reconnect by <LocalTime iso={deadline.toISOString()} />.
        </p>
      )}
      {needsReauth && (
        <p className="mt-2 text-sm text-[var(--danger)]">
          {a.lastError ?? "Google's 7-day test-mode limit has passed."}{" "}
          <a className="underline" href={`/api/accounts/google/connect?label=${a.label}`}>
            Reconnect
          </a>
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <TestConnectionButton accountId={a.id} />
        <form action={updateLabel} className="flex items-center gap-2">
          <input type="hidden" name="accountId" value={a.id} />
          <input type="hidden" name="label" value={a.label === "business" ? "personal" : "business"} />
          <button className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm">
            Mark as {a.label === "business" ? "personal" : "business"}
          </button>
        </form>
        <form action={disconnect}>
          <input type="hidden" name="accountId" value={a.id} />
          <button className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--danger)]">Disconnect</button>
        </form>
      </div>
    </li>
  );
}
