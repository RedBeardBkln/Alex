import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { db } from "@/db";
import { extractAddresses } from "@/lib/approvals/addresses";
import { outgoingBody } from "@/lib/approvals/payload";
import { invisibleCharacters, linksNotInThread, newRecipients, subjectWarnings, type InvisibleFinding } from "@/lib/approvals/warnings";
import { newRecipientLimit } from "@/lib/approvals/recipients";
import { getItemView, MARK_NOT_SENT_AFTER_MS, STUCK_EXECUTING_MS } from "@/lib/approvals/service";
import { requireUser } from "@/lib/session";
import { LocalTime } from "../../../local-time";
import { MessageBody } from "../../inbox/[threadId]/message-body";
import {
  approveItemAction,
  cancelItemAction,
  editItemAction,
  markNotSentAction,
  recheckItemAction,
  rejectItemAction,
} from "../actions";

export const dynamic = "force-dynamic";
/** The approve action sends from this page (plan §6). */
export const maxDuration = 60;

const NOTICES: Record<string, string> = {
  sent: "Sent.",
  failed: "Not sent: Gmail refused it. Nothing was sent; you can edit it or approve it again.",
  unknown: "Gmail didn't confirm the send. It may or may not have been sent; Alex checks automatically and never resends on its own.",
  in_progress: "This is already being sent (or was), so nothing more was done.",
  stale: "This item changed or was already handled, so nothing was done. Here is its current state.",
  edited: "Saved. Review it and approve it again.",
  rejected: "Rejected.",
  cancelled: "Cancelled.",
  marked_not_sent: "Marked as not sent. You can edit it or approve it again.",
  found: "Found the sent message in Gmail.",
  not_found_yet: "Not found in Gmail yet.",
  check_failed: "Couldn't check Gmail right now. Try again later.",
  ack_required: "New messages arrived in this thread since the page was shown. Nothing was sent. Read them, tick the box below, then approve again.",
  account_inactive: "This account must be reconnected before sending.",
  account_mismatch: "This reply's account no longer matches its thread, so it can't be sent.",
  recipients_unconfirmed: "Tick every recipient, then approve again. Nothing was sent.",
  new_recipient_limit: "Today's limit for first-time recipients is reached. Nothing was sent. It resets at 00:00 UTC.",
  hash_mismatch: "This item's stored content doesn't match its checksum, so it can't be approved.",
  not_found: "This item no longer exists.",
};

const ERROR_CODES: Record<string, string> = {
  reauth_required: "The account must be reconnected. Reconnect it on the Accounts page, then approve again.",
  stale_account: "The account or thread changed, so it wasn't sent.",
  hash_mismatch: "The approved copy didn't match its checksum, so it wasn't sent.",
  marked_not_sent: "You marked this as not sent.",
  token_unavailable: "Couldn't get access to the account, so it wasn't sent.",
  timeout: "Gmail didn't answer in time.",
  network: "The connection to Gmail failed.",
  gmail_5xx: "Gmail had a server error.",
  gmail_shape: "Gmail answered, but the answer couldn't be read.",
  stuck: "The send didn't finish.",
  executor_error: "Something failed during the send.",
};

const EDIT_ERRORS: Record<string, string> = {
  invalid_recipients: "Some addresses aren't valid.",
  no_recipients: "Add at least one To address.",
  too_many_recipients: "At most 50 recipients in total.",
  invalid_subject: "The subject can't contain line breaks or control characters.",
  body_too_long: "The message is too long.",
  invalid_body: "The message contains a control character (such as NUL) that can't be sent.",
  empty_subject: "Add a subject.",
  empty_body: "Write a message.",
  idn_not_punycode: "Internationalised domains must be typed in their xn-- (punycode) form.",
};

/** S3 (phase-2-followups-3): shown on AI items when the link check saw only the newest part of the thread. Fixed text. */
const HAYSTACK_TRUNCATED_NOTE = "This thread is very long, so only its newest part was checked: a link may be flagged even if it appears in an older message.";

/** Phase 2d: the account_mismatch notice for a new message, which has no thread. */
const NEW_MESSAGE_ACCOUNT_MISMATCH = "This message's account is no longer one of your connected accounts, or the item was changed, so it can't be sent.";

const STATUS_LABEL: Record<string, string> = {
  pending: "Waiting for your approval",
  approved: "Approved",
  executing: "Sending",
  succeeded: "Sent",
  failed: "Not sent",
  unknown: "Outcome unknown",
  rejected: "Rejected",
  cancelled: "Cancelled",
};

function InvisibleWarning({ where, finding }: { where: string; finding: InvisibleFinding }) {
  return (
    <Warning>
      The {where} contains {finding.count} invisible, control or text-direction {finding.count === 1 ? "character" : "characters"} that can make it read differently
      from what is sent: <span className="font-mono">{finding.items.map((x) => `${x.codePoint} at position ${x.index}`).join(", ")}</span>
      {finding.count > finding.items.length ? ", …" : ""}
    </Warning>
  );
}

function Warning({ children }: { children: React.ReactNode }) {
  return <li className="rounded-md bg-[var(--warn-bg)] px-3 py-2">{children}</li>;
}

/** Phase 2d: one recipient of a new message, monospace with the domain in bold, plus its markers. */
function Recipient({ address, firstTime, idn }: { address: string; firstTime: boolean; idn: string | undefined }) {
  const at = address.lastIndexOf("@");
  return (
    <>
      <span className="font-mono">
        {address.slice(0, at + 1)}
        <strong>{address.slice(at + 1)}</strong>
      </span>
      {firstTime && <span className="ml-2 rounded-full bg-[var(--warn-bg)] px-2 py-0.5 text-xs">First time</span>}
      {idn !== undefined && (
        <span className="ml-2 text-xs">
          (internationalised domain, shown as <span className="font-mono">{idn}</span>; check it)
        </span>
      )}
    </>
  );
}

export default async function QueueItemPage({
  params,
  searchParams,
}: {
  params: Promise<{ itemId: string }>;
  searchParams: Promise<{ notice?: string; edit?: string; error?: string }>;
}) {
  const user = await requireUser();
  const { itemId } = await params;
  const { notice, edit, error } = await searchParams;
  if (!z.uuid().safeParse(itemId).success) notFound();
  const view = await getItemView(db(), user.id, itemId, { newRecipientLimit: newRecipientLimit() });
  if (!view) notFound();
  const { item, shown, account, thread, parent, isNew } = view;
  const firstTime = new Set(view.firstTime);
  const isFirstTime = (a: string) => firstTime.has(a.toLowerCase());
  // Round 2: one item with more first-time recipients than the whole daily limit can never be approved as it is.
  const overLimit = view.firstTime.length > view.cap.limit;
  const overLimitText = `This email has ${view.firstTime.length} first-time ${view.firstTime.length === 1 ? "recipient" : "recipients"}; the daily limit is ${view.cap.limit}, so it can't be sent as it is, on any day. Remove some recipients, or raise EMAIL_NEW_RECIPIENTS_PER_DAY.`;
  const open = item.status === "pending" || item.status === "failed";
  // Q6: the warning and the required tick show when a message was flagged, or (SF2, owner Q1 option c)
  // when the thread holds newer messages right now, even if no flag was written for them.
  const threadChanged = item.threadChangedAt !== null || view.newerCount > 0;
  const now = Date.now();
  const executingFor = item.executingSince ? now - item.executingSince.getTime() : 0;
  const subjectWarning = subjectWarnings(shown.subject, parent?.subject ?? thread?.subject ?? null);
  // Phase 2c content warnings (plan §6.7): new recipients and invisible characters for every item, links for AI items.
  const isAi = item.source === "ai";
  const unknownRecipients = isNew ? [] : newRecipients([...shown.to, ...shown.cc], view.threadAddresses, view.ownAccounts);
  const bodyInvisible = invisibleCharacters(shown.bodyText);
  const quoteInvisible = invisibleCharacters(shown.quote?.included ? shown.quote.text : "");
  const unknownLinks = isAi ? linksNotInThread(shown.bodyText, view.threadHaystack) : [];
  // S3 (phase-2-followups-3): only the newest part of a very long thread was checked for links.
  const haystackTruncated = isAi && view.threadHaystackTruncated;
  const parentHasText = !!(parent && (parent.bodyText ?? parent.renderedText ?? "").trim() !== "");
  const errorText = item.errorCode ? (ERROR_CODES[item.errorCode] ?? (item.errorCode.startsWith("gmail_") ? `Gmail refused it (${item.errorCode.slice(6)}).` : "It wasn't sent.")) : null;

  return (
    <div className="space-y-4 text-sm">
      <p>
        <Link href="/queue" className="underline">
          ← Queue
        </Link>
      </p>
      {notice && NOTICES[notice] && (
        <p role="status" className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
          {isNew && notice === "account_mismatch"
            ? NEW_MESSAGE_ACCOUNT_MISMATCH
            : notice === "new_recipient_limit" && overLimit
              ? overLimitText
              : NOTICES[notice]}
        </p>
      )}

      <section className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
        <p className="flex flex-wrap items-center gap-2 text-xs uppercase tracking-wide text-[var(--muted)]">
          <span>
            {isNew ? "New email" : "Email reply"} · {STATUS_LABEL[item.status]}
          </span>
          {isAi && <span className="rounded-full bg-[var(--warn-bg)] px-2 py-0.5 normal-case tracking-normal text-[var(--text)]">AI draft</span>}
        </p>
        {isAi && <p className="mt-1 font-medium">Written by AI (Opus 5.5); check every line before approving.</p>}
        <dl className="mt-3 grid grid-cols-[6rem_1fr] gap-x-3 gap-y-2">
          <dt className="text-[var(--muted)]">From</dt>
          <dd>
            {account ? (
              <>
                <span className="font-medium">{account.email}</span> ({account.label === "business" ? "Business" : "Personal"})
              </>
            ) : (
              "(account disconnected)"
            )}
          </dd>
          <dt className="text-[var(--muted)]">To</dt>
          <dd>
            <ul>
              {shown.to.map((a) =>
                isNew ? (
                  <li key={a}>
                    <Recipient address={a} firstTime={open && isFirstTime(a)} idn={view.idn[a]} />
                  </li>
                ) : (
                  <li key={a} className="font-mono">
                    {a}
                  </li>
                ),
              )}
            </ul>
          </dd>
          <dt className="text-[var(--muted)]">Cc</dt>
          <dd>
            {shown.cc.length === 0 ? (
              <span className="text-[var(--muted)]">None</span>
            ) : (
              <ul>
                {shown.cc.map((a) =>
                  isNew ? (
                    <li key={a}>
                      <Recipient address={a} firstTime={open && isFirstTime(a)} idn={view.idn[a]} />
                    </li>
                  ) : (
                    <li key={a} className="font-mono">
                      {a}
                    </li>
                  ),
                )}
              </ul>
            )}
          </dd>
          <dt className="text-[var(--muted)]">Bcc</dt>
          <dd className="text-[var(--muted)]">No Bcc</dd>
          <dt className="text-[var(--muted)]">Subject</dt>
          <dd>{shown.subject}</dd>
          <dt className="text-[var(--muted)]">Thread</dt>
          <dd>
            {isNew ? (
              view.sentThread ? (
                <Link href={`/inbox/${view.sentThread.id}`} className="underline">
                  New conversation (open it)
                </Link>
              ) : (
                "New conversation"
              )
            ) : thread ? (
              <Link href={`/inbox/${thread.id}`} className="underline">
                Reply in thread: {thread.subject || "(no subject)"} ({thread.messageCount} {thread.messageCount === 1 ? "message" : "messages"})
              </Link>
            ) : (
              "(thread no longer stored)"
            )}
          </dd>
        </dl>

        <ul className="mt-3 space-y-2">
          {unknownRecipients.map((a) => (
            <Warning key={`r-${a}`}>
              New recipient not in this conversation: <span className="font-mono">{a}</span>
            </Warning>
          ))}
          {bodyInvisible.count > 0 && <InvisibleWarning where="message" finding={bodyInvisible} />}
          {quoteInvisible.count > 0 && <InvisibleWarning where="quoted text" finding={quoteInvisible} />}
          {unknownLinks.length > 0 && (
            <Warning>
              The AI draft mentions links or domains that don&apos;t appear in this thread: <span className="font-mono">{unknownLinks.join(", ")}</span>. Check them before sending.
              {haystackTruncated && <> {HAYSTACK_TRUNCATED_NOTE}</>}
            </Warning>
          )}
          {unknownLinks.length === 0 && haystackTruncated && <Warning>{HAYSTACK_TRUNCATED_NOTE}</Warning>}
          {shown.replyToNotice && (
            <Warning>
              Reply-To differs from the sender. This reply goes to the Reply-To address
              {parent ? (
                <>
                  {" "}
                  (<span className="font-mono">{extractAddresses(parent.replyToHeader).addresses.join(", ")}</span>), not the sender (
                  <span className="font-mono">{extractAddresses(parent.fromHeader).addresses.join(", ")}</span>)
                </>
              ) : null}
              . Check it's the right address.
            </Warning>
          )}
          {isNew &&
            Object.entries(view.idn).map(([a, u]) => (
              <Warning key={`idn-${a}`}>
                <span className="font-mono">{a}</span> has an internationalised domain. It displays as <span className="font-mono">{u}</span>; check that this is
                the domain you mean.
              </Warning>
            ))}
          {!isNew && thread && subjectWarning.changed && <Warning>The subject was changed; Gmail may not thread this reply.</Warning>}
          {subjectWarning.bidi && (
            <Warning>The subject contains invisible text-direction characters, so it may display differently from what is sent.</Warning>
          )}
          {!isNew && shown.threading && shown.threading.inReplyTo === null && (
            <Warning>The original message has no usable Message-ID, so threading relies on Gmail&apos;s thread id only.</Warning>
          )}
          {!isNew && threadChanged && open && (
            <Warning>
              New messages arrived in this thread since this was written.{" "}
              {thread && (
                <Link href={`/inbox/${thread.id}`} className="underline">
                  Read the thread
                </Link>
              )}
            </Warning>
          )}
          {account && account.status !== "active" && <Warning>This account must be reconnected before sending.</Warning>}
          {open && overLimit && <Warning>{overLimitText}</Warning>}
        </ul>

        <h2 className="mt-4 font-medium">Message (exactly as it will be sent)</h2>
        <pre className="mt-1 max-w-full whitespace-pre-wrap break-words rounded-md border border-[var(--border)] bg-[var(--bg)] p-3 font-mono text-sm">{outgoingBody(shown)}</pre>
        {shown.quote && !shown.quote.included && <p className="mt-1 text-xs text-[var(--muted)]">The quoted message is not included.</p>}
      </section>

      {item.status === "succeeded" && (
        <section className="rounded-lg border border-[var(--border)] p-4">
          <p>
            Sent {item.completedAt && <LocalTime iso={item.completedAt.toISOString()} />}. Gmail message id:{" "}
            <span className="font-mono">{String((item.result as { gmailMessageId?: string } | null)?.gmailMessageId ?? "")}</span>
          </p>
          {!isNew && thread && (
            <p className="mt-1">
              <Link href={`/inbox/${thread.id}`} className="underline">
                Open the thread
              </Link>{" "}
              (the sent reply appears after the next sync).
            </p>
          )}
          {isNew &&
            (view.sentThread ? (
              <p className="mt-1">
                <Link href={`/inbox/${view.sentThread.id}`} className="underline">
                  Open the conversation
                </Link>
              </p>
            ) : (
              <p className="mt-1">The conversation appears in Alex after the next sync (up to 5 minutes).</p>
            ))}
        </section>
      )}

      {item.status === "failed" && errorText && <p className="rounded-md bg-[var(--warn-bg)] px-3 py-2">{errorText}</p>}

      {item.status === "unknown" && (
        <section className="space-y-2 rounded-lg border border-[var(--border)] p-4">
          <p>
            Gmail didn&apos;t confirm this send{errorText ? ` (${errorText})` : ""}. It may or may not have been sent. Alex checks Gmail for it every
            few minutes and never resends it on its own.
          </p>
          <form action={recheckItemAction}>
            <input type="hidden" name="itemId" value={item.id} />
            <button className="rounded-md border border-[var(--border)] px-3 py-1.5">Check again</button>
          </form>
          {executingFor >= MARK_NOT_SENT_AFTER_MS ? (
            <form action={markNotSentAction}>
              <input type="hidden" name="itemId" value={item.id} />
              <button className="rounded-md border border-[var(--border)] px-3 py-1.5">Mark as not sent (I checked Gmail; it isn&apos;t there)</button>
            </form>
          ) : (
            <p className="text-xs text-[var(--muted)]">&quot;Mark as not sent&quot; becomes available 30 minutes after the send started.</p>
          )}
        </section>
      )}

      {(item.status === "executing" || item.status === "approved") && (
        <section className="space-y-2 rounded-lg border border-[var(--border)] p-4">
          <p>This is being sent.</p>
          {item.status === "executing" && executingFor >= STUCK_EXECUTING_MS && (
            <form action={recheckItemAction}>
              <input type="hidden" name="itemId" value={item.id} />
              <button className="rounded-md border border-[var(--border)] px-3 py-1.5">Check again</button>
            </form>
          )}
        </section>
      )}

      {open && edit === "1" && (
        <section className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
          <h2 className="mb-2 font-medium">Edit</h2>
          {error && <p className="mb-2 rounded-md bg-[var(--warn-bg)] px-3 py-2">{EDIT_ERRORS[error] ?? "Couldn't save."}</p>}
          <form action={editItemAction} className="space-y-3">
            <input type="hidden" name="itemId" value={item.id} />
            <input type="hidden" name="revision" value={item.revision} />
            <label className="block">
              <span className="text-[var(--muted)]">To (one address per line)</span>
              <textarea name="to" rows={2} defaultValue={view.payload.to.join("\n")} className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--bg)] p-2 font-mono" />
            </label>
            <label className="block">
              <span className="text-[var(--muted)]">Cc (one address per line)</span>
              <textarea name="cc" rows={2} defaultValue={view.payload.cc.join("\n")} className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--bg)] p-2 font-mono" />
            </label>
            <label className="block">
              <span className="text-[var(--muted)]">{isNew ? "Subject" : "Subject (changing it may stop Gmail from threading the reply)"}</span>
              <input name="subject" required={isNew} defaultValue={view.payload.subject} maxLength={500} className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--bg)] p-2" />
            </label>
            <label className="block">
              <span className="text-[var(--muted)]">Message (plain text)</span>
              <textarea name="bodyText" rows={10} required={isNew} maxLength={100_000} defaultValue={view.payload.bodyText} className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--bg)] p-2" />
            </label>
            {isNew && <p className="text-[var(--muted)]">The sending account can&apos;t be changed. To send from another account, cancel this and compose again.</p>}
            {!isNew && (view.payload.quote || parentHasText) && (
              <label className="flex items-center gap-2">
                <input type="checkbox" name="includeQuote" defaultChecked={!!view.payload.quote?.included} />
                <span>Include the quoted message</span>
              </label>
            )}
            <button className="rounded-md bg-[var(--accent)] px-3 py-2 font-medium text-[var(--bg)]">Save changes</button>
          </form>
        </section>
      )}

      {open && edit !== "1" && (
        <section className="space-y-3 rounded-lg border border-[var(--border)] p-4">
          <form action={approveItemAction} className="space-y-2">
            <input type="hidden" name="itemId" value={item.id} />
            <input type="hidden" name="revision" value={item.revision} />
            <input type="hidden" name="contentHash" value={item.contentHash} />
            <input type="hidden" name="shownThreadChangedAt" value={item.threadChangedAt ? String(item.threadChangedAt.getTime()) : ""} />
            <input type="hidden" name="shownNewer" value={view.newerDigest} />
            {isNew && (
              <fieldset className="space-y-1">
                <legend className="font-medium">
                  {shown.to.length + shown.cc.length} {shown.to.length + shown.cc.length === 1 ? "recipient" : "recipients"}: {shown.to.length} To,{" "}
                  {shown.cc.length} Cc
                </legend>
                <ul className="space-y-1">
                  {[...shown.to.map((a) => ["To", a] as const), ...shown.cc.map((a) => ["Cc", a] as const)].map(([kind, a]) => (
                    <li key={`c-${a}`}>
                      <label className="flex flex-wrap items-center gap-2">
                        <input type="checkbox" name="confirmRecipient" value={a} required />
                        <span className="w-6 text-[var(--muted)]">{kind}</span>
                        <Recipient address={a} firstTime={isFirstTime(a)} idn={view.idn[a]} />
                      </label>
                    </li>
                  ))}
                </ul>
              </fieldset>
            )}
            {(isNew || view.firstTime.length > 0) && (
              <p>
                {isNew ? "Tick each recipient to confirm it. " : ""}
                {view.firstTime.length} of them {view.firstTime.length === 1 ? "is a first-time recipient" : "are first-time recipients"}; today&apos;s limit:{" "}
                {view.cap.remaining} left.
              </p>
            )}
            {!isNew && threadChanged && (
              <label className="flex items-center gap-2">
                <input type="checkbox" name="ackThreadChange" required />
                <span>I&apos;ve seen the new messages in this thread</span>
              </label>
            )}
            <button className="rounded-md bg-[var(--accent)] px-3 py-2 font-medium text-[var(--bg)]">
              {item.status === "failed" ? "Approve and send again" : "Approve and send"}
            </button>
          </form>
          <div className="flex flex-wrap gap-3">
            <Link href={`/queue/${item.id}?edit=1`} className="rounded-md border border-[var(--border)] px-3 py-1.5">
              Edit
            </Link>
            {item.status === "pending" && (
              <form action={rejectItemAction}>
                <input type="hidden" name="itemId" value={item.id} />
                <button className="rounded-md border border-[var(--border)] px-3 py-1.5">Reject</button>
              </form>
            )}
            <form action={cancelItemAction}>
              <input type="hidden" name="itemId" value={item.id} />
              <button className="rounded-md border border-[var(--border)] px-3 py-1.5">Cancel</button>
            </form>
          </div>
        </section>
      )}

      {parent && thread && (
        <section className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
          <h2 className="font-medium">Replying to</h2>
          <p className="text-[var(--muted)]">{parent.isSent ? `You (from ${account?.email ?? "this account"})` : parent.fromHeader || "(unknown sender)"}</p>
          <MessageBody
            message={{ ...parent, renderKind: parent.renderKind as "html" | "text" | "none" | null }}
            threadId={thread.id}
            remoteOn={false}
          />
        </section>
      )}
    </div>
  );
}
