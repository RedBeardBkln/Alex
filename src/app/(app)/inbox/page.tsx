import Link from "next/link";
import { z } from "zod";
import { db } from "@/db";
import { listAccounts } from "@/lib/accounts";
import { senderDisplayName, snippetText } from "@/lib/gmail/mime";
import { listInboxThreads, mailStatusByAccount, type InboxCursor } from "@/lib/gmail/store";
import { requireUser } from "@/lib/session";
import { LocalTime } from "../../local-time";
import { MailStatusLine } from "../mail-status";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

/** Phase 2c triage chips (advisory; nothing is hidden). */
const CATEGORY_LABEL: Record<string, string> = {
  needs_reply: "Needs reply",
  fyi: "FYI",
  newsletter: "Newsletter",
  notification: "Notification",
  promo: "Promo",
  spam_suspect: "Suspected spam",
};

const cursorSchema = z.object({ at: z.iso.datetime({ offset: true }), id: z.uuid() });

function parseCursor(raw: string | undefined): InboxCursor | undefined {
  if (!raw) return undefined;
  const [at, id] = raw.split("_");
  const parsed = cursorSchema.safeParse({ at, id });
  return parsed.success ? { lastMessageAt: new Date(parsed.data.at), id: parsed.data.id } : undefined;
}

export default async function InboxPage({ searchParams }: { searchParams: Promise<{ before?: string; view?: string }> }) {
  const user = await requireUser();
  const params = await searchParams;
  const before = parseCursor(params.before);
  const needsReply = params.view === "needs_reply";
  const viewParam = needsReply ? "&view=needs_reply" : "";
  const [threads, accounts, status] = await Promise.all([
    listInboxThreads(db(), user.id, { before, limit: PAGE_SIZE + 1, needsReply }),
    listAccounts(db(), user.id),
    mailStatusByAccount(db(), user.id),
  ]);
  const page = threads.slice(0, PAGE_SIZE);
  const last = page[page.length - 1];
  const next = threads.length > PAGE_SIZE && last ? `${last.lastMessageAt.toISOString()}_${last.id}` : null;
  const googleAccounts = accounts.filter((a) => a.provider === "google");

  return (
    <div className="space-y-6">
      <section>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold">Inbox</h1>
          <Link href="/compose" className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-[var(--bg)]">
            Compose
          </Link>
        </div>
        <p className="mt-1 text-sm text-[var(--muted)]">
          All connected Google accounts, newest first. Alex never archives or marks mail read; replies and new messages are sent only after you approve them in the Queue.
        </p>
        {googleAccounts.length > 0 && (
          <ul className="mt-3 space-y-1 text-sm text-[var(--muted)]">
            {googleAccounts.map((a) => (
              <li key={a.id}>
                <span className="text-[var(--text)]">{a.email}</span>: <MailStatusLine account={a} status={status.get(a.id)} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <nav className="flex gap-4 text-sm" aria-label="Inbox views">
        <Link href="/inbox" className={needsReply ? "underline-offset-4 hover:underline" : "font-semibold underline"}>
          All
        </Link>
        <Link href="/inbox?view=needs_reply" className={needsReply ? "font-semibold underline" : "underline-offset-4 hover:underline"}>
          Needs reply
        </Link>
        <span className="text-xs text-[var(--muted)]">AI triage is a suggestion; every message stays in All.</span>
      </nav>

      {page.length === 0 ? (
        <p className="text-sm text-[var(--muted)]">
          {before ? "No older conversations." : "No conversations yet. New accounts take a while to backfill."}
        </p>
      ) : (
        <ul className="divide-y divide-[var(--border)] rounded-lg border border-[var(--border)] bg-[var(--surface)]">
          {page.map((t) => (
            <li key={t.id}>
              <Link href={`/inbox/${t.id}`} className="block px-4 py-3 hover:bg-[var(--bg)]">
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span className={`flex min-w-0 items-center gap-2 ${t.hasUnread ? "font-semibold" : ""}`}>
                    {t.hasUnread && <span aria-label="Unread" className="inline-block h-2 w-2 shrink-0 rounded-full bg-[var(--accent)]" />}
                    <span className="truncate">{senderDisplayName(t.sender)}</span>
                    {t.messageCount > 1 && <span className="text-[var(--muted)]">({t.messageCount})</span>}
                  </span>
                  <span className="shrink-0 text-xs text-[var(--muted)]">
                    <LocalTime iso={t.lastMessageAt.toISOString()} />
                  </span>
                </div>
                <p className={`truncate text-sm ${t.hasUnread ? "font-semibold" : ""}`}>{t.subject || "(no subject)"}</p>
                {t.triage?.summary ? (
                  <p className="truncate text-sm text-[var(--muted)]" title="AI summary">
                    {t.triage.summary}
                  </p>
                ) : (
                  <p className="truncate text-sm text-[var(--muted)]">{snippetText(t.snippet)}</p>
                )}
                <p className="mt-1 flex items-center gap-2 text-xs text-[var(--muted)]">
                  <span className="rounded-full border border-[var(--border)] px-2 py-0.5">
                    {t.accountLabel === "business" ? "Business" : "Personal"}
                  </span>
                  <span className="truncate">{t.accountEmail}</span>
                  {t.triage && (
                    <span className="rounded-full bg-[var(--warn-bg)] px-2 py-0.5" title="AI triage (suggestion)">
                      {CATEGORY_LABEL[t.triage.category] ?? t.triage.category}
                    </span>
                  )}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <div className="flex gap-3 text-sm">
        {before && (
          <Link className="underline" href={needsReply ? "/inbox?view=needs_reply" : "/inbox"}>
            Newest
          </Link>
        )}
        {next && (
          <Link className="underline" href={`/inbox?before=${encodeURIComponent(next)}${viewParam}`}>
            Load older
          </Link>
        )}
      </div>
    </div>
  );
}
