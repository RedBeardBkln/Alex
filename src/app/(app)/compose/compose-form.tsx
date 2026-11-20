"use client";

import { useActionState } from "react";
import { proposeNewMessageFormAction, type ComposeFormState } from "../queue/actions";

/**
 * The compose form (Phase 2d, plan §6.1), following the reply form's useActionState pattern. A
 * refused save shows the error and keeps what the owner typed, including the account they picked;
 * those values come only from the action's response. No field has a default other than empty, and
 * no account radio is checked until the owner checks one.
 */

export const COMPOSE_ERRORS: Record<string, string> = {
  no_account: "Choose the account to send from.",
  not_found: "That account isn't available. Choose one of your connected accounts.",
  account_not_google: "That account can't send email.",
  account_inactive: "That account must be reconnected first (Accounts page).",
  invalid_recipients: "Some addresses aren't valid. Use plain addresses like name@example.com, one per line, with no names.",
  idn_not_punycode: "Internationalised domains must be typed in their xn-- (punycode) form.",
  no_recipients: "Add at least one To address.",
  too_many_recipients: "At most 50 recipients in total.",
  invalid_subject: "The subject can't contain line breaks or control characters (500 characters at most).",
  empty_subject: "Add a subject.",
  body_too_long: "The message is too long (100,000 characters at most).",
  invalid_body: "The message contains a control character (such as NUL) that can't be sent.",
  empty_body: "Write a message.",
};

export type ComposeAccount = { id: string; email: string; label: "personal" | "business"; active: boolean };

export function ComposeForm({ accounts }: { accounts: ComposeAccount[] }) {
  const [state, action, pending] = useActionState<ComposeFormState, FormData>(proposeNewMessageFormAction, null);
  const v = state?.values ?? { accountId: "", to: "", cc: "", subject: "", bodyText: "" };
  return (
    // The key remounts the fields with the returned values after a refused save (React resets the form after an action).
    <form key={state?.seq ?? 0} action={action} className="space-y-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4 text-sm">
      {state?.error && (
        <div role="alert" className="rounded-md bg-[var(--warn-bg)] px-3 py-2">
          <p>{COMPOSE_ERRORS[state.error] ?? "The message couldn't be saved."}</p>
          {state.invalid.length > 0 && (
            <ul className="mt-1 font-mono">
              {state.invalid.map((t, i) => (
                <li key={i}>{t}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      <fieldset>
        <legend className="text-[var(--muted)]">From (choose the account to send from)</legend>
        <ul className="mt-1 space-y-1">
          {accounts.map((a) => (
            <li key={a.id}>
              <label className={`flex items-center gap-2 ${a.active ? "" : "text-[var(--muted)]"}`}>
                <input type="radio" name="accountId" value={a.id} required disabled={!a.active} defaultChecked={a.active && v.accountId === a.id} />
                <span className="font-medium">{a.email}</span> ({a.label === "business" ? "Business" : "Personal"})
                {!a.active && <span>: reconnect first</span>}
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
      <label className="block">
        <span className="text-[var(--muted)]">To (one address per line)</span>
        <textarea name="to" rows={2} required defaultValue={v.to} className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--bg)] p-2 font-mono" />
      </label>
      <label className="block">
        <span className="text-[var(--muted)]">Cc (one address per line)</span>
        <textarea name="cc" rows={2} defaultValue={v.cc} className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--bg)] p-2 font-mono" />
      </label>
      <p className="text-[var(--muted)]">No Bcc.</p>
      <label className="block">
        <span className="text-[var(--muted)]">Subject</span>
        <input name="subject" required maxLength={500} defaultValue={v.subject} className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--bg)] p-2" />
      </label>
      <label className="block">
        <span className="text-[var(--muted)]">Message (plain text)</span>
        <textarea name="bodyText" rows={12} required maxLength={100_000} defaultValue={v.bodyText} className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--bg)] p-2" />
      </label>
      <button disabled={pending} className="rounded-md bg-[var(--accent)] px-3 py-2 font-medium text-[var(--bg)]">
        Save for approval
      </button>
      <p className="text-xs text-[var(--muted)]">Nothing is sent until you approve it in the Queue.</p>
    </form>
  );
}
