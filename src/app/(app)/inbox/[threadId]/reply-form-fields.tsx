"use client";

import { useActionState } from "react";
import { proposeReplyFormAction, type ReplyFormState } from "../../queue/actions";

/**
 * The reply form's fields (Phase 2b). If the server refuses the save, the error is shown and the
 * typed values, including the body, stay as they were (review N2). There is no redirect on a refused
 * save, so the page keeps its mode (Reply or Reply all).
 * Nothing is sent from here: saving creates a pending approval item.
 */

export const REPLY_ERRORS: Record<string, string> = {
  invalid_recipients: "Some addresses aren't valid. Use plain addresses like name@example.com, separated by commas or new lines.",
  no_recipients: "Add at least one To address.",
  too_many_recipients: "At most 50 recipients in total.",
  invalid_subject: "The subject can't contain line breaks or control characters (500 characters at most).",
  body_too_long: "The message is too long (100,000 characters at most).",
  invalid_body: "The message contains a control character (such as NUL) that can't be sent.",
  not_found: "This thread or message is no longer available.",
  account_not_google: "This account can't send email.",
};

export type ReplyFormFieldsProps = {
  threadId: string;
  parentMessageId: string;
  mode: "reply" | "all";
  account: { email: string; label: "personal" | "business" };
  defaults: { to: string[]; cc: string[]; subject: string; unreadable: number; hasQuote: boolean };
};

export function ReplyFormFields({ threadId, parentMessageId, account, defaults }: ReplyFormFieldsProps) {
  const [state, action, pending] = useActionState<ReplyFormState, FormData>(proposeReplyFormAction, null);
  const v = state?.values ?? { to: defaults.to.join("\n"), cc: defaults.cc.join("\n"), subject: defaults.subject, bodyText: "", includeQuote: true };
  const label = account.label === "business" ? "Business" : "Personal";
  return (
    // The key remounts the fields with the returned values after a refused save (React resets the form after an action).
    <form key={state?.seq ?? 0} action={action} className="space-y-3 text-sm">
      {state?.error && (
        <p role="alert" className="rounded-md bg-[var(--warn-bg)] px-3 py-2">
          {REPLY_ERRORS[state.error] ?? "The reply couldn't be saved."}
        </p>
      )}
      <input type="hidden" name="threadId" value={threadId} />
      <input type="hidden" name="parentMessageId" value={parentMessageId} />
      <p>
        <span className="text-[var(--muted)]">From: </span>
        <span className="font-medium">{account.email}</span> ({label}) <span className="text-[var(--muted)]">(the account that received this thread; can&apos;t be changed)</span>
      </p>
      {defaults.unreadable > 0 && (
        <p className="rounded-md bg-[var(--warn-bg)] px-3 py-2">
          {defaults.unreadable === 1 ? "1 address couldn't be read" : `${defaults.unreadable} addresses couldn't be read`}; add them manually if needed.
        </p>
      )}
      <label className="block">
        <span className="text-[var(--muted)]">To (one address per line)</span>
        <textarea name="to" rows={2} defaultValue={v.to} className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--bg)] p-2 font-mono" />
      </label>
      <label className="block">
        <span className="text-[var(--muted)]">Cc (one address per line)</span>
        <textarea name="cc" rows={2} defaultValue={v.cc} className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--bg)] p-2 font-mono" />
      </label>
      <p className="text-[var(--muted)]">No Bcc.</p>
      <label className="block">
        <span className="text-[var(--muted)]">Subject (changing it may stop Gmail from threading the reply)</span>
        <input name="subject" defaultValue={v.subject} maxLength={500} className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--bg)] p-2" />
      </label>
      <label className="block">
        <span className="text-[var(--muted)]">Message (plain text)</span>
        <textarea name="bodyText" rows={10} maxLength={100_000} defaultValue={v.bodyText} className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--bg)] p-2" />
      </label>
      {defaults.hasQuote && (
        <label className="flex items-center gap-2">
          <input type="checkbox" name="includeQuote" defaultChecked={v.includeQuote} />
          <span>Include the quoted message below my reply</span>
        </label>
      )}
      <button disabled={pending} className="rounded-md bg-[var(--accent)] px-3 py-2 font-medium text-[var(--bg)]">
        Save for approval
      </button>
      <p className="text-xs text-[var(--muted)]">Nothing is sent until you approve it on the next screen.</p>
    </form>
  );
}
