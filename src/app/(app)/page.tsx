import { db } from "@/db";
import { listAccounts, type AccountSummary } from "@/lib/accounts";
import { env } from "@/lib/env";
import { mailStatusByAccount, type AccountMailStatus } from "@/lib/gmail/store";
import { reconnectBy } from "@/lib/google";
import { requireUser } from "@/lib/session";
import { signaturesByAccount, type StoredSignature } from "@/lib/signatures/store";
import { countDueForNav } from "@/lib/tasks/service";
import { effectiveZone } from "@/lib/tasks/time";
import { disconnect, updateLabel } from "./actions";
import { TestConnectionButton } from "./test-connection-button";
import { LocalTime } from "../local-time";
import { MailStatusLine } from "./mail-status";
import { DueBanner } from "./tasks/task-ui";
import { SignatureText } from "./signature-ui";

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
  const [accounts, mailStatus, due, signatures] = await Promise.all([
    listAccounts(db(), user.id),
    mailStatusByAccount(db(), user.id),
    countDueForNav(db(), user.id, new Date(), effectiveZone(user).zone),
    signaturesByAccount(db(), user.id),
  ]);
  const testingMode = env().GOOGLE_OAUTH_TESTING_MODE;

  return (
    <div className="space-y-6">
      <DueBanner counts={due} />
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

      <p className="text-sm text-[var(--muted)]">
        Connecting a Google account lets Alex read its mail (the last 30 days, then new mail) and its Gmail signature,
        store them here, send the mail to Anthropic&apos;s Claude for sorting and for drafts you ask for, and send emails
        only after you approve them. It
        also requests Calendar and Drive access; today Calendar is used only to test the connection, and Drive isn&apos;t
        used. See the{" "}
        <a href="/privacy" className="underline">
          privacy policy
        </a>
        .
      </p>
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
            <AccountCard key={a.id} account={a} testingMode={testingMode} mail={mailStatus.get(a.id)} signature={signatures.get(a.id) ?? null} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** Phase email-signatures (owner Q4c): the signature's status and preview. Fixed text; the signature itself is React text in a <pre>. */
function SignatureStatus({ signature: s }: { signature: StoredSignature | null }) {
  const state = s?.state ?? null;
  return (
    <div className="mt-2 text-sm text-[var(--muted)]">
      <p>
        {state === "set" && s ? (
          <>
            {/* Review R-6: the last successful read (fetched_at), not a later failed attempt. */}
            Signature: from Gmail, checked <LocalTime iso={(s.fetchedAt ?? s.checkedAt).toISOString()} />
          </>
        ) : state === "none" ? (
          "Signature: none set in Gmail"
        ) : state === "not_found" ? (
          "Signature: not found for this address"
        ) : state === "too_large" ? (
          "Signature: too long to add (over 10,000 characters as text)"
        ) : (
          "Signature: not read yet"
        )}
      </p>
      {s?.lastErrorCode && (
        <p className="text-[var(--danger)]">
          Couldn&apos;t read it at the last check (<span className="font-mono">{s.lastErrorCode}</span>);{" "}
          {s.fetchedAt ? (
            <>
              using the copy from <LocalTime iso={s.fetchedAt.toISOString()} />
            </>
          ) : (
            "no copy yet"
          )}
        </p>
      )}
      {state === "set" && s?.text && (
        <details className="mt-1">
          <summary className="cursor-pointer">Show the signature Alex adds</summary>
          <SignatureText text={s.text} />
        </details>
      )}
      <p className="text-xs">Alex sends it as plain text: no images or formatting; link addresses are written after the link text.</p>
    </div>
  );
}

function AccountCard({
  account: a,
  testingMode,
  mail,
  signature,
}: {
  account: AccountSummary;
  testingMode: boolean;
  mail: AccountMailStatus | undefined;
  signature: StoredSignature | null;
}) {
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

      {a.provider === "google" && (
        <p className="mt-2 text-sm text-[var(--muted)]">
          Mail: <MailStatusLine account={a} status={mail} />
        </p>
      )}
      {a.provider === "google" && <SignatureStatus signature={signature} />}

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
