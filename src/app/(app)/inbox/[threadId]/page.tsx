import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { db } from "@/db";
import { replyContext, replyFormDefaults } from "@/lib/approvals/service";
import { getThreadView, latestThreadTriage, type ThreadView } from "@/lib/gmail/store";
import { requireUser } from "@/lib/session";
import { LocalTime } from "../../../local-time";
import { MessageBody } from "./message-body";
import { ReplyForm } from "./reply-form";
import { AiPanel } from "./ai-panel";
import { aiConfigured } from "@/lib/ai-ledger/config";
import { capState } from "@/lib/ai-ledger/ledger";

export const dynamic = "force-dynamic";
/** The AI draft action runs from this page: Opus with a 90 s timeout (plan §7). */
export const maxDuration = 120;

const HIDDEN_LABELS = ["TRASH", "SPAM"];

function formatSize(bytes: number | null): string {
  if (bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default async function ThreadPage({
  params,
  searchParams,
}: {
  params: Promise<{ threadId: string }>;
  searchParams: Promise<{ remote?: string; reply?: string; error?: string; ai_error?: string; ai_triage?: string }>;
}) {
  const user = await requireUser();
  const { threadId } = await params;
  const { remote, reply, error, ai_error: aiError, ai_triage: aiTriage } = await searchParams;
  if (!z.uuid().safeParse(threadId).success) notFound();
  const view = await getThreadView(db(), user.id, threadId);
  if (!view) notFound();

  const visible = view.messages.filter((m) => !m.labelIds.some((l) => HIDDEN_LABELS.includes(l)));
  const hidden = view.messages.length - visible.length;
  const replyMode = reply === "all" ? "all" : reply ? "reply" : null;
  const ctx = replyMode ? await replyContext(db(), user.id, threadId) : null;
  const configured = aiConfigured();
  const [triage, draftCap] = await Promise.all([
    latestThreadTriage(db(), user.id, threadId),
    configured ? capState(db(), user.id, "draft", new Date()) : Promise.resolve({ capped: false as const }),
  ]);

  return (
    <div className="space-y-4">
      <p className="text-sm">
        <Link href="/inbox" className="underline">
          ← Inbox
        </Link>
      </p>
      <section>
        <h1 className="text-xl font-semibold">{view.thread.subject || "(no subject)"}</h1>
        <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-[var(--muted)]">
          <span className="rounded-full border border-[var(--border)] px-2 py-0.5 text-xs">
            {view.account.label === "business" ? "Business" : "Personal"}
          </span>
          <span>{view.account.email}</span>
          {!view.thread.inInbox && (
            <span className="rounded-full bg-[var(--warn-bg)] px-2 py-0.5 text-xs">Archived in Gmail</span>
          )}
        </p>
        {hidden > 0 && (
          <p className="mt-2 text-sm text-[var(--muted)]">
            {hidden === 1 ? "1 message in Trash or Spam is hidden." : `${hidden} messages in Trash or Spam are hidden.`}
          </p>
        )}
      </section>

      <ol className="space-y-4">
        {visible.map((m) => (
          <MessageCard key={m.id} message={m} view={view} remoteOn={remote === m.id} />
        ))}
      </ol>

      <AiPanel threadId={view.thread.id} configured={configured} draftCapped={draftCap.capped} triage={triage} aiError={aiError} aiTriage={aiTriage} />

      <div id="reply">
        {ctx && replyMode ? (
          <ReplyForm
            threadId={view.thread.id}
            parentMessageId={ctx.parent.id}
            account={view.account}
            mode={replyMode}
            defaults={replyFormDefaults(ctx, replyMode)}
            error={error}
          />
        ) : (
          visible.length > 0 && (
            <p className="flex gap-3 text-sm">
              <Link href={`/inbox/${view.thread.id}?reply=1#reply`} className="rounded-md bg-[var(--accent)] px-3 py-1.5 font-medium text-[var(--bg)]">
                Reply
              </Link>
              <Link href={`/inbox/${view.thread.id}?reply=all#reply`} className="rounded-md border border-[var(--border)] px-3 py-1.5">
                Reply all
              </Link>
            </p>
          )
        )}
      </div>
    </div>
  );
}

function MessageCard({
  message: m,
  view,
  remoteOn,
}: {
  message: ThreadView["messages"][number];
  view: ThreadView;
  remoteOn: boolean;
}) {
  return (
    <li id={`m-${m.id}`} className={`rounded-lg border border-[var(--border)] p-4 ${m.isSent ? "bg-[var(--bg)]" : "bg-[var(--surface)]"}`}>
      <div className="flex flex-wrap items-start justify-between gap-2 text-sm">
        <div className="min-w-0">
          <p className="font-medium">
            {m.isSent ? `You (from ${view.account.email})` : m.fromHeader || "(unknown sender)"}
          </p>
          {m.toHeader && <p className="text-[var(--muted)]">To: {m.toHeader}</p>}
          {m.ccHeader && <p className="text-[var(--muted)]">Cc: {m.ccHeader}</p>}
        </div>
        <span className="shrink-0 text-xs text-[var(--muted)]">
          <LocalTime iso={m.internalDate.toISOString()} />
        </span>
      </div>

      <MessageBody message={m} threadId={view.thread.id} remoteOn={remoteOn} />

      {m.attachments.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm text-[var(--muted)]">
          {m.attachments.map((a) => (
            <li key={a.id}>
              Attachment: {a.filename || "(unnamed attachment)"} {a.mimeType ? `· ${a.mimeType}` : ""} {a.sizeBytes !== null ? `· ${formatSize(a.sizeBytes)}` : ""}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
