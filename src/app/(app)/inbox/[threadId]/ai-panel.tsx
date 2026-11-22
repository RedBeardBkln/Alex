import type { MailTriage } from "@/db/schema";
import { AiDraftButtons } from "./ai-draft-buttons";
import { draftReplyAction, triageThreadAction } from "./ai-actions";

/**
 * Phase 2c AI panel on the thread page: the triage result (a suggestion) and "Draft reply with
 * AI" (owner Q3: only when the owner clicks). Shows why a feature is off instead of hiding it.
 */

const CATEGORY_LABEL: Record<string, string> = {
  needs_reply: "Needs reply",
  fyi: "FYI",
  newsletter: "Newsletter",
  notification: "Notification",
  promo: "Promo",
  spam_suspect: "Suspected spam",
};

const DRAFT_ERRORS: Record<string, string> = {
  not_configured: "AI not configured.",
  capped: "Today's AI draft limit is reached. It resets at midnight UTC.",
  in_flight: "A draft for this thread is already being written. Wait for it to finish (up to about a minute), then check the Queue.",
  not_found: "This thread is no longer available.",
  proposal: "The draft couldn't be saved (for example no readable recipient). Write the reply yourself.",
  account_disconnected: "The account was disconnected while the draft was being written. Nothing was saved.",
};
const TRIAGE_OUTCOMES: Record<string, string> = {
  triaged: "Triaged.",
  already: "This thread already has a triage result.",
  not_found: "No inbox message to triage in this thread.",
  capped: "Today's AI triage limit is reached. It resets at midnight UTC.",
  failed: "AI triage failed; try again later.",
  not_configured: "AI not configured.",
  account_disconnected: "The account was disconnected during triage. Nothing was saved.",
};

export type AiPanelProps = {
  threadId: string;
  configured: boolean;
  draftCapped: boolean;
  triage: Pick<MailTriage, "status" | "category" | "needsReply" | "summary"> | null;
  aiError?: string;
  aiTriage?: string;
};

export function AiPanel({ threadId, configured, draftCapped, triage, aiError, aiTriage }: AiPanelProps) {
  const disabledReason = !configured ? "AI not configured." : draftCapped ? DRAFT_ERRORS.capped : null;
  return (
    <section id="ai" className="space-y-3 rounded-lg border border-[var(--border)] p-4 text-sm">
      <h2 className="font-semibold">AI</h2>
      {triage?.status === "ok" ? (
        <p>
          <span className="rounded-full bg-[var(--warn-bg)] px-2 py-0.5 text-xs">{CATEGORY_LABEL[triage.category ?? ""] ?? triage.category}</span>{" "}
          <span className="text-[var(--muted)]">AI triage (a suggestion):</span> {triage.summary}
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[var(--muted)]">
            {triage?.status === "skipped_cap"
              ? "Not triaged: today's AI triage limit was reached."
              : triage
                ? "Not triaged (the AI couldn't classify this message)."
                : "Not triaged."}
          </span>
          {configured && (
            <form action={triageThreadAction}>
              <input type="hidden" name="threadId" value={threadId} />
              <button className="rounded-md border border-[var(--border)] px-2 py-1">Triage this thread</button>
            </form>
          )}
        </div>
      )}
      {aiTriage && TRIAGE_OUTCOMES[aiTriage] && <p role="status">{TRIAGE_OUTCOMES[aiTriage]}</p>}

      {aiError && (
        <p role="alert" className="rounded-md bg-[var(--warn-bg)] px-3 py-2">
          {DRAFT_ERRORS[aiError] ?? "AI draft failed; try again or write it yourself."}
        </p>
      )}
      {disabledReason ? (
        <p className="text-[var(--muted)]">Draft reply with AI: {disabledReason}</p>
      ) : (
        <form action={draftReplyAction} className="space-y-2">
          <input type="hidden" name="threadId" value={threadId} />
          <label className="block">
            <span className="text-[var(--muted)]">Optional instruction for the AI (only your words; the email itself is never treated as instructions)</span>
            <textarea name="instruction" rows={2} maxLength={2_000} className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--bg)] p-2" />
          </label>
          <AiDraftButtons />
          <p className="text-xs text-[var(--muted)]">
            The AI writes only the text. Recipients, account and subject are set by Alex, and nothing is sent until you approve it in the Queue. Drafting can take up to a minute.
          </p>
        </form>
      )}
    </section>
  );
}
