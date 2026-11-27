import Link from "next/link";
import { REPLY_ERRORS, ReplyFormFields } from "./reply-form-fields";
import type { SignaturePreviewData } from "../../signature-ui";

/**
 * Reply form (Phase 2b, plan §7). Submitting creates a pending approval item and opens it;
 * nothing is sent from here. The sending account is shown but can't be changed: the server
 * always uses the thread's account. The fields keep the typed values after a refused save
 * (reply-form-fields.tsx); `error` covers the no-JavaScript path (`?error=` on the page URL).
 */

export type ReplyFormProps = {
  threadId: string;
  parentMessageId: string;
  account: { email: string; label: "personal" | "business" };
  mode: "reply" | "all";
  defaults: { to: string[]; cc: string[]; subject: string; unreadable: number; hasQuote: boolean };
  /** Phase email-signatures: the stored signature of the thread's account, for the preview. */
  signature?: SignaturePreviewData;
  error?: string;
};

export function ReplyForm({ threadId, parentMessageId, account, mode, defaults, signature, error }: ReplyFormProps) {
  return (
    <section className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
        <h2 className="font-semibold">{mode === "all" ? "Reply all" : "Reply"}</h2>
        <Link href={`/inbox/${threadId}?reply=${mode === "all" ? "1" : "all"}#reply`} className="underline">
          {mode === "all" ? "Switch to Reply" : "Switch to Reply all"}
        </Link>
        <Link href={`/inbox/${threadId}`} className="underline">
          Close
        </Link>
      </div>
      {error && (
        <p role="alert" className="mb-3 rounded-md bg-[var(--warn-bg)] px-3 py-2 text-sm">
          {REPLY_ERRORS[error] ?? "The reply couldn't be saved."}
        </p>
      )}
      <ReplyFormFields threadId={threadId} parentMessageId={parentMessageId} mode={mode} account={account} defaults={defaults} signature={signature} />
    </section>
  );
}
