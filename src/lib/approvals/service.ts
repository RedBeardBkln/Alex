import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import type { Executor } from "@/db";
import { approvalItems, connectedAccounts, mailMessages, mailThreads, type ApprovalItem, type ConnectedAccount } from "@/db/schema";
import { utcDayStart } from "@/lib/ai-ledger/config";
import { audit } from "@/lib/audit";
import { lockAccountForWrite } from "@/lib/db-locks";
import { MAX_BODY_CHARS, isValidSubject, replySubject, replyThreading } from "@/lib/gmail/compose";
import { enqueueOutbound } from "@/lib/gmail/store";
import { extractAddresses, MAX_RECIPIENTS, parseRecipientInput, replyDefaults, replyToDiffers, type ParentHeaders } from "./addresses";
import { contentHash, emailSendPayload, isNewMessage, quoteText, type EmailSendPayload } from "./payload";
import { capAllows, capRemaining, confirmationMatches, idnDisplay, newRecipientLimit } from "./recipients";
import { recordRecheckFailure } from "./recheck";
import { firstTimeRecipients, newRecipientsUsedToday, recordRecipientCharge, replyParentOf } from "./seen";
import { hasDisallowedControl, sliceOnCodePoint, stripAllControls, wellFormed } from "./text";
import { cutAtTokenBoundary } from "./warnings";

/**
 * The approval queue's state machine (Phase 2b, plan §5). Every transition is one conditional
 * UPDATE plus its audit entry in the same transaction, so concurrent callers can't both win and a
 * rollback leaves neither. Every query is scoped to the user. Audit details carry ids, counts,
 * hashes and content-free codes only: no addresses, subjects or body text.
 *
 * Lock order (phase-2-followups-1): every audited transition's first statement locks the item's
 * account row FOR KEY SHARE (lockAccountForWrite), so it can't deadlock with a Disconnect.
 *
 * Nothing here sends anything. Sending happens only in execute.ts, after `claimItem`.
 */

export const EMAIL_SEND = "email.send" as const;
/** An `unknown` item can be marked "not sent" by the owner only after this long (plan §5.4). */
export const MARK_NOT_SENT_AFTER_MS = 30 * 60_000;
/** An `executing` item older than this is treated as stuck by the reconciler. */
export const STUCK_EXECUTING_MS = 10 * 60_000;

/** Statuses an owner can still edit, approve or cancel. */
const OPEN: ApprovalItem["status"][] = ["pending", "failed"];

export type ReplyInput = {
  userId: string;
  threadId: string;
  parentMessageId: string;
  to: string;
  cc: string;
  subject: string;
  bodyText: string;
  includeQuote: boolean;
};

export type InputError =
  | "not_found"
  | "invalid_recipients"
  | "no_recipients"
  | "too_many_recipients"
  | "invalid_subject"
  | "body_too_long"
  | "invalid_body"
  | "account_not_google"
  // Phase 2d (new messages)
  | "empty_subject"
  | "empty_body"
  | "account_inactive"
  | "idn_not_punycode";

/** A refused save. `invalid` lists up to 10 of the owner's own invalid tokens (compose only; never stored or audited). */
export type InputFailure = { ok: false; error: InputError; invalid?: string[] };

/** How many invalid tokens the compose form echoes back, and how long each may be. */
const MAX_ECHOED_TOKENS = 10;
const MAX_ECHOED_TOKEN_CHARS = 100;

const hasNonAscii = (v: string) => {
  for (let i = 0; i < v.length; i++) if (v.charCodeAt(i) > 127) return true;
  return false;
};

// ---- Reply context ------------------------------------------------------------------------------

export type ParentMessage = ParentHeaders & {
  id: string;
  threadId: string;
  subject: string | null;
  dateHeader: string | null;
  rfc822MessageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  bodyText: string | null;
  renderedText: string | null;
  labelIds: string[];
  internalDate: Date;
};

const parentColumns = {
  id: mailMessages.id,
  threadId: mailMessages.threadId,
  isSent: mailMessages.isSent,
  fromHeader: mailMessages.fromHeader,
  toHeader: mailMessages.toHeader,
  ccHeader: mailMessages.ccHeader,
  replyToHeader: mailMessages.replyToHeader,
  subject: mailMessages.subject,
  dateHeader: mailMessages.dateHeader,
  rfc822MessageId: mailMessages.rfc822MessageId,
  inReplyTo: mailMessages.inReplyTo,
  references: mailMessages.references,
  bodyText: mailMessages.bodyText,
  renderedText: mailMessages.renderedText,
  labelIds: mailMessages.labelIds,
  internalDate: mailMessages.internalDate,
};

export type ReplyContext = {
  thread: typeof mailThreads.$inferSelect;
  account: ConnectedAccount;
  parent: ParentMessage;
};

/**
 * The thread (the user's), its receiving account (the only account a reply can be sent from) and
 * the message being replied to: `parentMessageId` if it is in the thread, otherwise the newest
 * message not in Trash or Spam.
 */
export async function replyContext(ex: Executor, userId: string, threadId: string, parentMessageId?: string): Promise<ReplyContext | null> {
  const [head] = await ex
    .select({ thread: mailThreads, account: connectedAccounts })
    .from(mailThreads)
    .innerJoin(connectedAccounts, eq(connectedAccounts.id, mailThreads.accountId))
    .where(and(eq(mailThreads.id, threadId), eq(mailThreads.userId, userId), eq(connectedAccounts.userId, userId)))
    .limit(1);
  if (!head) return null;
  const messages = await ex
    .select(parentColumns)
    .from(mailMessages)
    .where(and(eq(mailMessages.threadId, threadId), eq(mailMessages.userId, userId)))
    .orderBy(desc(mailMessages.internalDate), desc(mailMessages.id));
  const visible = messages.filter((m) => !m.labelIds.includes("TRASH") && !m.labelIds.includes("SPAM"));
  const parent = parentMessageId ? messages.find((m) => m.id === parentMessageId) : visible[0];
  if (!parent) return null;
  return { thread: head.thread, account: head.account, parent };
}

/** The quote for a reply to `parent`, or null if the parent has no text. */
function parentQuote(parent: Pick<ParentMessage, "fromHeader" | "dateHeader" | "bodyText" | "renderedText">): string | null {
  const q = quoteText({ fromHeader: parent.fromHeader, dateHeader: parent.dateHeader, text: parent.bodyText ?? parent.renderedText });
  return q === "" ? null : q;
}

/** Form defaults for a reply (owner Q1, Q7). Computed in code from the stored headers. */
export function replyFormDefaults(ctx: ReplyContext, mode: "reply" | "all") {
  const d = replyDefaults(ctx.parent, ctx.account.email, mode);
  const quote = quoteText({ fromHeader: ctx.parent.fromHeader, dateHeader: ctx.parent.dateHeader, text: ctx.parent.bodyText ?? ctx.parent.renderedText });
  return { ...d, subject: replySubject(ctx.parent.subject ?? ctx.thread.subject), hasQuote: quote !== "" };
}

/**
 * Owner-entered fields to a validated payload (recipients re-checked, Reply-To notice recomputed in code).
 * `newMessage` (Phase 2d, plan §5): the subject and body must not be empty (owner Q8), the quote is
 * never included, a non-ASCII token is reported as `idn_not_punycode` (owner Q7), and the invalid
 * tokens are returned so the compose form can list them.
 */
export function buildEmailPayload(
  fields: { to: string; cc: string; subject: string; bodyText: string; includeQuote: boolean },
  /** `quote` is only called when the owner includes the quote (review D2: an excluded quote isn't computed or stored). */
  base: { quote: () => string | null; threading: EmailSendPayload["threading"]; parent: ParentHeaders | null; previousNotice: boolean; newMessage?: boolean },
): { ok: true; payload: EmailSendPayload } | InputFailure {
  const to = parseRecipientInput(fields.to);
  const cc = parseRecipientInput(fields.cc);
  const invalid = [...to.invalid, ...cc.invalid];
  if (invalid.length > 0) {
    if (!base.newMessage) return { ok: false, error: "invalid_recipients" };
    const echoed = invalid.slice(0, MAX_ECHOED_TOKENS).map((t) => sliceOnCodePoint(wellFormed(t), MAX_ECHOED_TOKEN_CHARS));
    return { ok: false, error: invalid.some(hasNonAscii) ? "idn_not_punycode" : "invalid_recipients", invalid: echoed };
  }
  if (to.addresses.length === 0) return { ok: false, error: "no_recipients" };
  const ccList = cc.addresses.filter((a) => !to.addresses.some((t) => t.toLowerCase() === a.toLowerCase()));
  if (to.addresses.length + ccList.length > MAX_RECIPIENTS) return { ok: false, error: "too_many_recipients" };
  // Lone surrogates become U+FFFD (jsonb rejects them); NUL and other controls are validation errors (review D2, D4).
  const subject = wellFormed(fields.subject).trim();
  if (!isValidSubject(subject)) return { ok: false, error: "invalid_subject" };
  if (base.newMessage && subject === "") return { ok: false, error: "empty_subject" };
  const bodyText = wellFormed(fields.bodyText).replace(/\r\n?/g, "\n");
  if (hasDisallowedControl(bodyText)) return { ok: false, error: "invalid_body" };
  if (bodyText.length > MAX_BODY_CHARS) return { ok: false, error: "body_too_long" };
  if (base.newMessage && bodyText.trim() === "") return { ok: false, error: "empty_body" };
  const quote = fields.includeQuote && !base.newMessage ? base.quote() : null;
  const payload: EmailSendPayload = {
    to: to.addresses,
    cc: ccList,
    subject,
    bodyText,
    quote: quote ? { included: true, text: quote } : null,
    threading: base.threading,
    replyToNotice: base.parent ? replyToDiffers(base.parent, to.addresses) : base.previousNotice,
  };
  const parsed = emailSendPayload.safeParse(payload);
  if (!parsed.success) return { ok: false, error: "invalid_recipients" };
  return { ok: true, payload: parsed.data };
}

// ---- Propose and edit ----------------------------------------------------------------------------

/**
 * Creates a pending `email.send` reply. The sending account is the thread's account (never taken
 * from the form), and the threading headers come from the stored parent. Nothing is sent.
 */
export async function proposeReply(ex: Executor, input: ReplyInput, source: ApprovalItem["source"] = "owner"): Promise<{ ok: true; itemId: string } | { ok: false; error: InputError }> {
  const ctx = await replyContext(ex, input.userId, input.threadId, input.parentMessageId);
  if (!ctx) return { ok: false, error: "not_found" };
  if (ctx.account.provider !== "google") return { ok: false, error: "account_not_google" };
  const built = buildEmailPayload(input, {
    quote: () => parentQuote(ctx.parent),
    threading: replyThreading(ctx.thread.gmailThreadId, ctx.parent),
    parent: ctx.parent,
    previousNotice: false,
  });
  if (!built.ok) return built;
  const payload = built.payload;
  const hash = contentHash(EMAIL_SEND, ctx.account.id, payload);
  const itemId = await ex.transaction(async (tx) => {
    // Lock order: the account first. A Disconnect that got there first leaves no account row.
    if (!(await lockAccountForWrite(tx, ctx.account.id))) return null;
    // Q6 at propose time (review round 1, D1): a message newer than the parent may already be stored
    // (synced after the form was rendered, or while the AI drafted). Then the warning is raised
    // now, exactly as the ingest hook raises it for a message that arrives later.
    const changed = await newerMessageInThread(tx, input.userId, ctx.thread.id, ctx.parent.id, ctx.parent.internalDate);
    const [row] = await tx
      .insert(approvalItems)
      .values({
        userId: input.userId,
        kind: EMAIL_SEND,
        source,
        status: "pending",
        accountId: ctx.account.id,
        threadId: ctx.thread.id,
        parentMessageId: ctx.parent.id,
        // Q6 baseline (review D5): survives deletion of the parent row; never changed by an edit.
        parentInternalDate: ctx.parent.internalDate,
        threadChangedAt: changed ? new Date() : null,
        payload,
        revision: 1,
        contentHash: hash,
      })
      .returning({ id: approvalItems.id });
    await audit(
      {
        userId: input.userId,
        accountId: ctx.account.id,
        action: "approval.proposed",
        detail: { itemId: row!.id, kind: EMAIL_SEND, source, recipients: payload.to.length + payload.cc.length },
      },
      tx,
    );
    return row!.id;
  });
  if (itemId === null) return { ok: false, error: "not_found" };
  // Round 3, E2: check again now that the item is committed. A message committed while the
  // transaction above was open is seen here; one committed later is flagged by the ingest hook's
  // post-commit step (afterMessageCommitted), which then sees this item. Either way it's flagged.
  // E5 follow-up: advisory. The item is saved; a failure here is logged and audited
  // (approval.recheck_failed), and the save still succeeds.
  try {
    if (await newerMessageInThread(ex, input.userId, ctx.thread.id, ctx.parent.id, ctx.parent.internalDate)) {
      await ex
        .update(approvalItems)
        .set({ threadChangedAt: new Date() })
        .where(and(eq(approvalItems.id, itemId), isNull(approvalItems.threadChangedAt), inArray(approvalItems.status, OPEN)));
    }
  } catch (err) {
    await recordRecheckFailure(ex, { stage: "propose", userId: input.userId, accountId: ctx.account.id, threadId: ctx.thread.id, itemId }, err);
  }
  return { ok: true, itemId };
}

export type NewMessageInput = {
  userId: string;
  /** The account the owner picked (owner constraint 2). Checked to be the user's, Google and active. */
  accountId: string;
  to: string;
  cc: string;
  subject: string;
  bodyText: string;
};

/**
 * Creates a pending `email.send` item for a NEW message (Phase 2d, plan §6.2): no thread, no
 * parent, no quote, `threading: null`. Recipients, subject and body are only what the owner typed.
 * The account must be the user's own Google account and active (owner Q10). Nothing is sent: it
 * goes through the same approve, claim and execute path as a reply.
 */
export async function proposeNewMessage(ex: Executor, input: NewMessageInput): Promise<{ ok: true; itemId: string } | InputFailure> {
  const [account] = await ex
    .select({ id: connectedAccounts.id, provider: connectedAccounts.provider, status: connectedAccounts.status })
    .from(connectedAccounts)
    .where(and(eq(connectedAccounts.id, input.accountId), eq(connectedAccounts.userId, input.userId)))
    .limit(1);
  // Another user's account and a missing one get the same answer.
  if (!account) return { ok: false, error: "not_found" };
  if (account.provider !== "google") return { ok: false, error: "account_not_google" };
  if (account.status !== "active") return { ok: false, error: "account_inactive" };
  const built = buildEmailPayload(
    { to: input.to, cc: input.cc, subject: input.subject, bodyText: input.bodyText, includeQuote: false },
    { quote: () => null, threading: null, parent: null, previousNotice: false, newMessage: true },
  );
  if (!built.ok) return built;
  const payload = built.payload;
  const hash = contentHash(EMAIL_SEND, account.id, payload);
  const itemId = await ex.transaction(async (tx) => {
    // Lock order: the account first. A Disconnect that got there first leaves no account row.
    if (!(await lockAccountForWrite(tx, account.id))) return null;
    const [row] = await tx
      .insert(approvalItems)
      .values({
        userId: input.userId,
        kind: EMAIL_SEND,
        source: "owner",
        status: "pending",
        accountId: account.id,
        threadId: null,
        parentMessageId: null,
        parentInternalDate: null,
        threadChangedAt: null,
        payload,
        revision: 1,
        contentHash: hash,
      })
      .returning({ id: approvalItems.id });
    await audit(
      {
        userId: input.userId,
        accountId: account.id,
        action: "approval.proposed",
        detail: { itemId: row!.id, kind: EMAIL_SEND, source: "owner", recipients: payload.to.length + payload.cc.length, variant: "new" },
      },
      tx,
    );
    return row!.id;
  });
  if (itemId === null) return { ok: false, error: "not_found" };
  return { ok: true, itemId };
}

/**
 * The Q6 rule, in one place: a stored message of the user's thread that isn't the parent, is newer
 * than the baseline, and isn't one of Alex's own sends (a SENT copy carrying an approval item's
 * Message-ID in the same account). It is the rule the ingest hook uses.
 */
function newerMessageWhere(userId: string, threadId: string, parentId: string | null, baseline: Date): SQL {
  return and(
    eq(mailMessages.threadId, threadId),
    eq(mailMessages.userId, userId),
    parentId === null ? undefined : sql`${mailMessages.id} <> ${parentId}::uuid`,
    sql`${mailMessages.internalDate} > ${baseline.toISOString()}::timestamptz`,
    sql`not (${mailMessages.isSent} and ${mailMessages.rfc822MessageId} is not null and exists (
      select 1 from ${approvalItems} a
      where a.account_id = ${mailMessages.accountId} and a.message_id_header = ${mailMessages.rfc822MessageId}
    ))`,
  )!;
}

/** True if the thread holds a message newer than the parent under the Q6 rule (newerMessageWhere). */
export async function newerMessageInThread(ex: Executor, userId: string, threadId: string, parentId: string, parentInternalDate: Date): Promise<boolean> {
  const [row] = await ex.select({ id: mailMessages.id }).from(mailMessages).where(newerMessageWhere(userId, threadId, parentId, parentInternalDate)).limit(1);
  return !!row;
}

/**
 * SF2 (phase-2-followups-2, owner Q1 option c): the ids of the stored messages that count as new for
 * the item under the Q6 rule, with the hook's baseline (parent_internal_date, else created_at). None
 * for an item without a thread (a new message, or a reply whose thread is gone).
 */
export async function newerMessageIds(
  ex: Executor,
  item: Pick<ApprovalItem, "userId" | "threadId" | "parentMessageId" | "parentInternalDate" | "createdAt">,
): Promise<string[]> {
  if (!item.threadId) return [];
  const rows = await ex
    .select({ id: mailMessages.id })
    .from(mailMessages)
    .where(newerMessageWhere(item.userId, item.threadId, item.parentMessageId, item.parentInternalDate ?? item.createdAt));
  return rows.map((r) => r.id);
}

/** sha256 hex of the sorted ids joined with ",", or "" for none. The same for any order of the ids. */
export function newerDigest(ids: readonly string[]): string {
  if (ids.length === 0) return "";
  return createHash("sha256").update([...ids].sort().join(",")).digest("hex");
}

/**
 * The only entry point for AI-written replies (Phase 2c, plan §6.3). The model supplies the body
 * text and nothing else: the account comes from the thread, the recipients are the code-computed
 * Reply / Reply-all defaults, the subject is the default "Re:" subject, threading is derived from
 * the stored parent, and the quote is included (owner Q7). It goes through proposeReply, so the
 * same validation applies, and the item is `pending` with `source: ai` until the owner approves it.
 */
/** Longest AI-written body accepted (plan §6.5). */
export const AI_BODY_CAP = 20_000;

export async function proposeAiReply(
  ex: Executor,
  input: { userId: string; threadId: string; parentMessageId?: string; mode: "reply" | "all"; body: string },
): Promise<{ ok: true; itemId: string } | { ok: false; error: InputError }> {
  // The gate checks the model's body itself (review round 1, D3): controls other than newline and
  // tab removed, at most AI_BODY_CAP characters, and not empty or whitespace-only.
  const body = sliceOnCodePoint(stripAllControls(wellFormed(input.body).replace(/\r\n?/g, "\n")).trim(), AI_BODY_CAP);
  if (body === "") return { ok: false, error: "invalid_body" };
  const ctx = await replyContext(ex, input.userId, input.threadId, input.parentMessageId);
  if (!ctx) return { ok: false, error: "not_found" };
  const d = replyFormDefaults(ctx, input.mode);
  return proposeReply(
    ex,
    {
      userId: input.userId,
      threadId: input.threadId,
      parentMessageId: ctx.parent.id,
      to: d.to.join(", "),
      cc: d.cc.join(", "),
      subject: d.subject,
      bodyText: body,
      includeQuote: true,
    },
    "ai",
  );
}

export type EditInput = {
  userId: string;
  itemId: string;
  revision: number;
  to: string;
  cc: string;
  subject: string;
  bodyText: string;
  includeQuote: boolean;
};

/**
 * Edits a pending or failed item (optimistic: `revision` must be the one the form showed). The
 * revision goes up, the approval snapshot is cleared and the item returns to `pending`.
 */
export async function editItem(ex: Executor, input: EditInput): Promise<{ ok: true; revision: number } | { ok: false; error: InputError | "stale" }> {
  const item = await getOwnItem(ex, input.userId, input.itemId);
  if (!item) return { ok: false, error: "not_found" };
  if (!OPEN.includes(item.status) || item.revision !== input.revision) return { ok: false, error: "stale" };
  const current = emailSendPayload.parse(item.payload);
  // Phase 2d: a new message keeps the new-message rules (non-empty subject and body, no quote).
  // The account never changes on edit (owner Q9): editItem takes no account.
  const newMessage = isNewMessage(current);
  const parent =
    item.parentMessageId && !newMessage
      ? ((await ex.select(parentColumns).from(mailMessages).where(and(eq(mailMessages.id, item.parentMessageId), eq(mailMessages.userId, input.userId))).limit(1))[0] ?? null)
      : null;
  const built = buildEmailPayload(
    newMessage ? { ...input, includeQuote: false } : input,
    {
      quote: () => current.quote?.text ?? (parent ? parentQuote(parent) : null),
      threading: current.threading,
      parent,
      previousNotice: current.replyToNotice,
      newMessage,
    },
  );
  if (!built.ok) return { ok: false, error: built.error };
  const hash = contentHash(item.kind, item.accountId, built.payload);
  return ex.transaction(async (tx) => {
    // Lock order: the account first. If it is gone, the item was cascaded and the UPDATE is stale.
    if (item.accountId) await lockAccountForWrite(tx, item.accountId);
    const [row] = await tx
      .update(approvalItems)
      .set({
        payload: built.payload,
        revision: sql`${approvalItems.revision} + 1`,
        contentHash: hash,
        status: "pending",
        approvedRevision: null,
        approvedHash: null,
        approvedPayload: null,
        approvedAt: null,
        messageIdHeader: null,
        errorCode: null,
        newRecipientCount: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(approvalItems.id, input.itemId),
          eq(approvalItems.userId, input.userId),
          eq(approvalItems.revision, input.revision),
          inArray(approvalItems.status, OPEN),
        ),
      )
      .returning({ revision: approvalItems.revision });
    if (!row) return { ok: false as const, error: "stale" as const };
    await audit({ userId: input.userId, accountId: item.accountId, action: "approval.edited", detail: { itemId: input.itemId, revision: row.revision } }, tx);
    return { ok: true as const, revision: row.revision };
  });
}

// ---- Approve and claim --------------------------------------------------------------------------

export type ApproveResult =
  | { kind: "approved" }
  /** Already approved with exactly this revision and hash (a replay or a parallel click): the caller may try to claim. */
  | { kind: "already_approved" }
  /** Changed since the page loaded (another revision or hash), or handled already. */
  | { kind: "stale"; status: ApprovalItem["status"] }
  | {
      kind: "blocked";
      reason:
        | "not_found"
        | "account_inactive"
        | "account_mismatch"
        | "hash_mismatch"
        | "ack_required"
        /** Phase 2d, owner Q2: the ticked recipients aren't exactly the new message's to ∪ cc. */
        | "recipients_unconfirmed"
        /** Phase 2d, owner Q3: approving would pass today's first-time-recipient limit. */
        | "new_recipient_limit";
    };

/** Most confirmRecipient values the approve action accepts, and the longest one. */
export const MAX_CONFIRMED_RECIPIENTS = 100;
export const MAX_CONFIRMED_RECIPIENT_CHARS = 254;

/**
 * Approves exactly what was on screen (plan §5.1): the conditional UPDATE requires the displayed
 * `revision` and `content_hash`, and copies the current content into the frozen approved_* columns
 * with a new Message-ID.
 */
export async function approveItem(
  ex: Executor,
  input: {
    userId: string;
    itemId: string;
    revision: number;
    contentHash: string;
    ackThreadChange: boolean;
    /**
     * The thread_changed_at the approval page rendered (epoch ms), or null if it showed no new-message
     * warning (review B1). Omitted counts as null. Approval requires the stored value to be exactly this.
     */
    shownThreadChangedAt?: number | null;
    /**
     * SF2 (owner Q1 option c): the newer-message digest the approval page rendered (newerDigest, "" for
     * none). Required (S1, phase-2-followups-3): recomputed inside the approve transaction on every
     * call; a value that doesn't equal the recomputed digest, or a non-empty one without the tick, is
     * ack_required. The approve action always passes it (a missing form field is ""). An untyped
     * caller that passes undefined gets ack_required, even on a thread with no newer messages.
     */
    shownNewer: string;
    messageIdHost: string;
    /**
     * Phase 2d, owner Q2: the recipients the owner ticked on the approval page. Required to equal
     * the stored to ∪ cc exactly for a new message; not taken or checked for replies.
     */
    confirmedRecipients?: string[];
    /** The daily first-time-recipient cap (owner Q3). Omitted: EMAIL_NEW_RECIPIENTS_PER_DAY, default 10. */
    newRecipientLimit?: number;
    /** The clock for the cap's UTC day (tests). */
    now?: Date;
  },
): Promise<ApproveResult> {
  const item = await getOwnItem(ex, input.userId, input.itemId);
  if (!item) return { kind: "blocked", reason: "not_found" };
  if (item.status === "approved" && item.approvedRevision === input.revision && item.approvedHash === input.contentHash) {
    return { kind: "already_approved" };
  }
  if (!OPEN.includes(item.status) || item.revision !== input.revision || item.contentHash !== input.contentHash) {
    return { kind: "stale", status: item.status };
  }
  // The stored hash must match the stored content (nothing changed it outside this module).
  if (contentHash(item.kind, item.accountId, item.payload) !== item.contentHash) return { kind: "blocked", reason: "hash_mismatch" };
  const check = await accountCheck(ex, item);
  if (check !== "ok") return { kind: "blocked", reason: check };
  // Q6, bound to what the owner saw (review B1): the stored flag must be the one the page rendered,
  // and if it is set the owner must have ticked the box. Otherwise the page re-renders the warning.
  const shown = input.shownThreadChangedAt ?? null;
  if ((item.threadChangedAt?.getTime() ?? null) !== shown) return { kind: "blocked", reason: "ack_required" };
  if (item.threadChangedAt && !input.ackThreadChange) return { kind: "blocked", reason: "ack_required" };
  const shownSql = shown === null ? null : new Date(shown).toISOString();

  // Phase 2d, owner Q2: a new message is approved only with every recipient ticked, exactly. The
  // stored payload is the one bound by the revision and content hash checked above.
  const parsed = emailSendPayload.safeParse(item.payload);
  if (!parsed.success) return { kind: "blocked", reason: "hash_mismatch" };
  const payload = parsed.data;
  const newMessage = isNewMessage(payload);
  const confirmed = input.confirmedRecipients ?? [];
  if (newMessage && !confirmationMatches(confirmed, payload)) return { kind: "blocked", reason: "recipients_unconfirmed" };
  const limit = input.newRecipientLimit ?? newRecipientLimit();
  const now = input.now ?? new Date();

  // A new Message-ID for every approval, so an approve-again after a definite failure (Q8) is a new message.
  const messageId = `<alex.${item.id}.${item.revision}.${randomBytes(6).toString("hex")}@${input.messageIdHost}>`;
  return ex.transaction(async (tx) => {
    // Lock order: the account first, before the advisory lock (Disconnect never takes that lock,
    // so waiting on it while holding KEY SHARE can't form a cycle). If the account is gone, the item
    // was cascaded with it: stale, as the UPDATE below would find, but without first writing a
    // new_recipient_limit audit row whose account FK would fail.
    if (item.accountId && !(await lockAccountForWrite(tx, item.accountId))) return { kind: "stale" as const, status: item.status };
    // SF2 (owner Q1 option c): approval is bound to the newer-message set the page showed, recomputed
    // here after the lock. A message whose post-commit re-check failed (or never ran) is in this set
    // once it is committed, so it can't be approved past unseen.
    const digest = newerDigest(await newerMessageIds(tx, item));
    if (digest !== input.shownNewer || (digest !== "" && !input.ackThreadChange)) return { kind: "blocked" as const, reason: "ack_required" as const };
    // Phase 2d, owner Q3 (amended): the daily first-time-recipient cap, for every email.send item.
    // Serialized per user with a transaction-scoped advisory lock (as the AI draft caps), so two
    // parallel approves can't both fit under the limit.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`alex-new-recipients:${input.userId}`}))`);
    const firstTime = await firstTimeRecipients(tx, input.userId, payload, replyParentOf(item));
    const n = firstTime.length;
    if (n > 0) {
      const used = await newRecipientsUsedToday(tx, input.userId, utcDayStart(now));
      if (!capAllows(n, used, limit)) {
        await audit(
          { userId: input.userId, accountId: item.accountId, action: "approval.new_recipient_limit", detail: { itemId: item.id, newRecipients: n, usedToday: used, limit } },
          tx,
        );
        return { kind: "blocked" as const, reason: "new_recipient_limit" as const };
      }
    }
    const [row] = await tx
      .update(approvalItems)
      .set({
        status: "approved",
        approvedRevision: item.revision,
        approvedHash: item.contentHash,
        approvedPayload: item.payload,
        approvedAt: now,
        messageIdHeader: messageId,
        executionId: null,
        executingSince: null,
        errorCode: null,
        newRecipientCount: n,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(approvalItems.id, item.id),
          eq(approvalItems.userId, input.userId),
          inArray(approvalItems.status, OPEN),
          eq(approvalItems.revision, input.revision),
          eq(approvalItems.contentHash, input.contentHash),
          // A message that lands between the check above and this UPDATE moves thread_changed_at.
          sql`${approvalItems.threadChangedAt} is not distinct from ${shownSql}::timestamptz`,
        ),
      )
      .returning({ id: approvalItems.id });
    if (!row) {
      const now = await getOwnItem(tx, input.userId, item.id);
      const sameContent = now && OPEN.includes(now.status) && now.revision === input.revision && now.contentHash === input.contentHash;
      return sameContent ? { kind: "blocked" as const, reason: "ack_required" as const } : { kind: "stale" as const, status: now?.status ?? item.status };
    }
    // Round 2, D1: the charge survives account disconnects. Always written (also when n = 0), so a
    // re-approval replaces an earlier approval's charge instead of reviving it.
    await recordRecipientCharge(tx, { itemId: item.id, userId: input.userId, accountId: item.accountId, approvedAt: now, newRecipients: n });
    await audit(
      {
        userId: input.userId,
        accountId: item.accountId,
        action: "approval.approved",
        // Counts only (plan §6.5): how many recipients were ticked, and how many were first-time.
        detail: {
          itemId: item.id,
          revision: item.revision,
          contentHash: item.contentHash,
          ...(newMessage ? { confirmedRecipients: confirmed.length } : {}),
          newRecipients: n,
        },
      },
      tx,
    );
    return { kind: "approved" as const };
  });
}

/**
 * For email.send: the account must be the user's and active. A reply's account must still be its
 * thread's account. A new message (Phase 2d) must have no thread and no parent, and its account must
 * be a Google account (owner constraint 2, checked again at send time by the executor).
 */
async function accountCheck(ex: Executor, item: ApprovalItem): Promise<"ok" | "account_inactive" | "account_mismatch" | "not_found"> {
  if (!item.accountId) return "account_mismatch";
  const [account] = await ex
    .select({ status: connectedAccounts.status, userId: connectedAccounts.userId, provider: connectedAccounts.provider })
    .from(connectedAccounts)
    .where(eq(connectedAccounts.id, item.accountId))
    .limit(1);
  if (!account || account.userId !== item.userId) return "account_mismatch";
  if (account.status !== "active") return "account_inactive";
  if (item.kind === EMAIL_SEND && isNewMessage(item.payload)) {
    if (item.threadId !== null || item.parentMessageId !== null || account.provider !== "google") return "account_mismatch";
    return "ok";
  }
  if (item.kind === EMAIL_SEND) {
    if (!item.threadId) return "account_mismatch";
    const [thread] = await ex.select({ accountId: mailThreads.accountId }).from(mailThreads).where(eq(mailThreads.id, item.threadId)).limit(1);
    if (!thread || thread.accountId !== item.accountId) return "account_mismatch";
  }
  return "ok";
}

/**
 * approved -> executing (plan §5.2). Exactly one caller can win: everyone else gets null. The
 * execution_started audit commits before anything is sent.
 */
export async function claimItem(ex: Executor, userId: string, itemId: string): Promise<{ executionId: string } | null> {
  const executionId = randomUUID();
  const accountId = await itemAccountId(ex, userId, itemId);
  if (accountId === undefined) return null;
  return ex.transaction(async (tx) => {
    if (accountId) await lockAccountForWrite(tx, accountId);
    const [row] = await tx
      .update(approvalItems)
      .set({ status: "executing", executionId, executingSince: new Date(), updatedAt: new Date() })
      .where(and(eq(approvalItems.id, itemId), eq(approvalItems.userId, userId), eq(approvalItems.status, "approved")))
      .returning({ accountId: approvalItems.accountId });
    if (!row) return null;
    await audit({ userId, accountId: row.accountId, action: "approval.execution_started", detail: { itemId, executionId } }, tx);
    return { executionId };
  });
}

export type ExecutionOutcome =
  | { kind: "succeeded"; gmailMessageId: string; gmailThreadId: string }
  | { kind: "failed"; code: string; status: number | null }
  | { kind: "unknown"; code: string; status: number | null };

/** executing -> succeeded | failed | unknown, only for the execution that claimed the item. */
export async function recordOutcome(ex: Executor, item: ApprovalItem, executionId: string, outcome: ExecutionOutcome): Promise<boolean> {
  return ex.transaction(async (tx) => {
    if (item.accountId) await lockAccountForWrite(tx, item.accountId);
    const now = new Date();
    const set =
      outcome.kind === "succeeded"
        ? { status: "succeeded" as const, result: { gmailMessageId: outcome.gmailMessageId, gmailThreadId: outcome.gmailThreadId }, completedAt: now, errorCode: null }
        : outcome.kind === "failed"
          ? // Q8 (review round 1): moving to failed bumps the revision, so a resubmitted old approve
            // POST is stale and only a click on a freshly rendered page approves again.
            { status: "failed" as const, errorCode: outcome.code, revision: sql`${approvalItems.revision} + 1` }
          : { status: "unknown" as const, errorCode: outcome.code };
    const [row] = await tx
      .update(approvalItems)
      .set({ ...set, updatedAt: now })
      .where(and(eq(approvalItems.id, item.id), eq(approvalItems.executionId, executionId), eq(approvalItems.status, "executing")))
      .returning({ id: approvalItems.id });
    if (!row) return false;
    const base = { userId: item.userId, accountId: item.accountId };
    if (outcome.kind === "succeeded") {
      await audit({ ...base, action: "approval.executed", detail: { itemId: item.id, gmailMessageId: outcome.gmailMessageId } }, tx);
      // Phase 2d (plan §6.4): bring the SENT copy of a new message into Alex at the next sync.
      if (isNewMessage(item.approvedPayload) && item.accountId) {
        await enqueueOutbound(tx, { id: item.accountId, userId: item.userId }, outcome.gmailMessageId, outcome.gmailThreadId);
      }
    } else if (outcome.kind === "failed") {
      await audit({ ...base, action: "approval.execution_failed", detail: { itemId: item.id, code: outcome.code, status: outcome.status } }, tx);
    } else {
      await audit({ ...base, action: "approval.execution_unknown", detail: { itemId: item.id, code: outcome.code } }, tx);
    }
    return true;
  });
}

// ---- Reject, cancel, mark not sent, reconcile ----------------------------------------------------

/**
 * The item's account id for the lock-first rule: undefined if the user has no such item. Read
 * outside the transition's transaction; an item's account never changes (2d owner Q9).
 */
async function itemAccountId(ex: Executor, userId: string, itemId: string): Promise<string | null | undefined> {
  const [row] = await ex
    .select({ accountId: approvalItems.accountId })
    .from(approvalItems)
    .where(and(eq(approvalItems.id, itemId), eq(approvalItems.userId, userId)))
    .limit(1);
  return row ? row.accountId : undefined;
}

async function simpleTransition(
  ex: Executor,
  userId: string,
  itemId: string,
  from: ApprovalItem["status"][],
  to: ApprovalItem["status"],
  action: string,
  extra: Partial<Omit<typeof approvalItems.$inferInsert, "revision">> & { revision?: SQL } = {},
  extraWhere?: ReturnType<typeof and>,
): Promise<boolean> {
  const accountId = await itemAccountId(ex, userId, itemId);
  if (accountId === undefined) return false;
  return ex.transaction(async (tx) => {
    if (accountId) await lockAccountForWrite(tx, accountId);
    const [row] = await tx
      .update(approvalItems)
      .set({ status: to, updatedAt: new Date(), ...extra })
      .where(and(eq(approvalItems.id, itemId), eq(approvalItems.userId, userId), inArray(approvalItems.status, from), extraWhere))
      .returning({ accountId: approvalItems.accountId });
    if (!row) return false;
    await audit({ userId, accountId: row.accountId, action, detail: { itemId } }, tx);
    return true;
  });
}

/** pending -> rejected. */
export const rejectItem = (ex: Executor, userId: string, itemId: string) =>
  simpleTransition(ex, userId, itemId, ["pending"], "rejected", "approval.rejected", { completedAt: new Date() });

/** pending | failed -> cancelled. */
export const cancelItem = (ex: Executor, userId: string, itemId: string) =>
  simpleTransition(ex, userId, itemId, OPEN, "cancelled", "approval.cancelled", { completedAt: new Date() });

/** unknown -> failed, by the owner, only once MARK_NOT_SENT_AFTER_MS have passed since execution started. */
export const markNotSent = (ex: Executor, userId: string, itemId: string, now: Date) =>
  simpleTransition(
    ex,
    userId,
    itemId,
    ["unknown"],
    "failed",
    "approval.marked_not_sent",
    { errorCode: "marked_not_sent", revision: sql`${approvalItems.revision} + 1` }, // Q8: invalidates old approve POSTs
    lt(approvalItems.executingSince, new Date(now.getTime() - MARK_NOT_SENT_AFTER_MS)),
  );

/** unknown | executing -> succeeded after finding the sent message (reconcile list hit or 2a ingest match). */
export async function markReconciledSent(
  ex: Executor,
  item: Pick<ApprovalItem, "id" | "userId" | "accountId">,
  found: { gmailMessageId: string; gmailThreadId: string },
  outcome: "list_found" | "ingest_match",
): Promise<boolean> {
  return ex.transaction(async (tx) => {
    if (item.accountId) await lockAccountForWrite(tx, item.accountId);
    const now = new Date();
    const [row] = await tx
      .update(approvalItems)
      .set({ status: "succeeded", result: found, completedAt: now, updatedAt: now, errorCode: null })
      // Scoped to the item's user as well (security review N1).
      .where(and(eq(approvalItems.id, item.id), eq(approvalItems.userId, item.userId), inArray(approvalItems.status, ["unknown", "executing"])))
      .returning({ id: approvalItems.id, accountId: approvalItems.accountId, approvedPayload: approvalItems.approvedPayload });
    if (!row) return false;
    await audit({ userId: item.userId, accountId: item.accountId, action: "approval.reconciled", detail: { itemId: item.id, outcome } }, tx);
    // Phase 2d (plan §6.4): a reconcile hit (SENT in this account) for a new message brings its SENT
    // copy into Alex. An ingest match means the copy is being stored already.
    if (outcome === "list_found" && isNewMessage(row.approvedPayload) && row.accountId) {
      await enqueueOutbound(tx, { id: row.accountId, userId: item.userId }, found.gmailMessageId, found.gmailThreadId);
    }
    return true;
  });
}

/** executing (stuck past STUCK_EXECUTING_MS, nothing found) -> unknown. Never retried automatically. */
export async function markStuckUnknown(ex: Executor, item: Pick<ApprovalItem, "id" | "userId" | "accountId">, now: Date): Promise<boolean> {
  return ex.transaction(async (tx) => {
    if (item.accountId) await lockAccountForWrite(tx, item.accountId);
    const [row] = await tx
      .update(approvalItems)
      .set({ status: "unknown", errorCode: "stuck", updatedAt: now })
      .where(
        and(
          eq(approvalItems.id, item.id),
          eq(approvalItems.status, "executing"),
          lt(approvalItems.executingSince, new Date(now.getTime() - STUCK_EXECUTING_MS)),
        ),
      )
      .returning({ id: approvalItems.id });
    if (!row) return false;
    await audit({ userId: item.userId, accountId: item.accountId, action: "approval.reconciled", detail: { itemId: item.id, outcome: "stuck_unknown" } }, tx);
    return true;
  });
}

/** Items the reconciler looks at: unknown, and executing older than STUCK_EXECUTING_MS. */
export async function itemsToReconcile(ex: Executor, now: Date, limit = 20, userId?: string, itemId?: string): Promise<ApprovalItem[]> {
  const conditions = [
    or(
      eq(approvalItems.status, "unknown"),
      and(eq(approvalItems.status, "executing"), lt(approvalItems.executingSince, new Date(now.getTime() - STUCK_EXECUTING_MS))),
    ),
    sql`${approvalItems.messageIdHeader} is not null`,
  ];
  if (userId) conditions.push(eq(approvalItems.userId, userId));
  if (itemId) conditions.push(eq(approvalItems.id, itemId));
  return ex.select().from(approvalItems).where(and(...conditions)).orderBy(approvalItems.updatedAt).limit(limit);
}

// ---- Reads --------------------------------------------------------------------------------------

export async function getOwnItem(ex: Executor, userId: string, itemId: string): Promise<ApprovalItem | null> {
  const [row] = await ex
    .select()
    .from(approvalItems)
    .where(and(eq(approvalItems.id, itemId), eq(approvalItems.userId, userId)))
    .limit(1);
  return row ?? null;
}

export const QUEUE_TABS = {
  pending: ["pending", "approved", "executing"],
  attention: ["failed", "unknown"],
  done: ["succeeded", "rejected", "cancelled"],
} as const satisfies Record<string, ApprovalItem["status"][]>;
export type QueueTab = keyof typeof QUEUE_TABS;

export type QueueRow = Pick<ApprovalItem, "id" | "kind" | "status" | "source" | "payload" | "createdAt" | "updatedAt"> & {
  accountEmail: string | null;
  accountLabel: "personal" | "business" | null;
};

export async function listItems(ex: Executor, userId: string, tab: QueueTab, limit = 100): Promise<QueueRow[]> {
  return ex
    .select({
      id: approvalItems.id,
      kind: approvalItems.kind,
      status: approvalItems.status,
      source: approvalItems.source,
      payload: approvalItems.payload,
      createdAt: approvalItems.createdAt,
      updatedAt: approvalItems.updatedAt,
      accountEmail: connectedAccounts.email,
      accountLabel: connectedAccounts.label,
    })
    .from(approvalItems)
    .leftJoin(connectedAccounts, eq(connectedAccounts.id, approvalItems.accountId))
    .where(and(eq(approvalItems.userId, userId), inArray(approvalItems.status, [...QUEUE_TABS[tab]])))
    .orderBy(desc(approvalItems.createdAt))
    .limit(limit);
}

/** The nav badge: items waiting for the owner (pending) or needing attention (failed, unknown). */
export async function countNeedingOwner(ex: Executor, userId: string): Promise<number> {
  const [row] = await ex
    .select({ n: sql<number>`count(*)::int` })
    .from(approvalItems)
    .where(and(eq(approvalItems.userId, userId), inArray(approvalItems.status, ["pending", "failed", "unknown"])));
  return row?.n ?? 0;
}

export type ItemView = {
  item: ApprovalItem;
  payload: EmailSendPayload;
  /** What is shown for approval: the approved snapshot once approved, the editable content before. */
  shown: EmailSendPayload;
  account: { id: string; email: string; label: "personal" | "business"; status: ConnectedAccount["status"] } | null;
  thread: { id: string; subject: string | null; messageCount: number; accountId: string } | null;
  parent: (ParentMessage & {
    renderKind: string | null;
    renderReason: string | null;
    renderedHtml: string | null;
    renderedHtmlRemote: string | null;
    renderTruncated: boolean;
    sanitizerVersion: number | null;
    bodyIncomplete: boolean;
  }) | null;
  /** Phase 2c warnings: every address in the thread's stored From/To/Cc/Reply-To headers. */
  threadAddresses: string[];
  /** The owner's connected account addresses. */
  ownAccounts: string[];
  /** The thread's stored text, rendered HTML and headers, for the AI links warning. Never shown. */
  threadHaystack: string;
  /** S3 (phase-2-followups-3): the haystack holds only the newest part of the thread's bodies (a cap cut or left out a field). */
  threadHaystackTruncated: boolean;
  /** Phase 2d: a new message (threading null), not a reply. */
  isNew: boolean;
  /** SF2 (owner Q1 option c): how many stored messages count as new for this item (Q6 rule). */
  newerCount: number;
  /** SF2: newerDigest of those messages, sent back by the approve form as `shownNewer`. */
  newerDigest: string;
  /** Phase 2d: the shown recipients (lowercased) that are first-time recipients right now (owner Q3, Q4). */
  firstTime: string[];
  /** Phase 2d, owner Q7: the Unicode form of each shown recipient's punycode domain, keyed by the address as shown. */
  idn: Record<string, string>;
  /** Phase 2d: today's first-time-recipient cap (UTC day). */
  cap: { limit: number; usedToday: number; remaining: number };
  /** Phase 2d: the stored thread of a sent new message (found by the Gmail thread id in the result), once synced. */
  sentThread: { id: string; subject: string | null; messageCount: number } | null;
};

/**
 * S3 (phase-2-followups-3, owner Q3): the link-check haystack's caps, in UTF-16 units, for the body
 * fields (body_text, rendered_text, rendered_html). Headers and subjects have their own budget below.
 */
export const HAYSTACK_FIELD_CAP = 262_144;
export const HAYSTACK_CAP = 2_097_152;
/**
 * Sec N4 (phase-h1-link-hardening, owner Q7 a): the haystack's copy of each From/To/Cc/Reply-To
 * header and subject, and of all of them together, in UTF-16 units. Only the copy is bounded:
 * stored data and the recipients warning (whole headers) are unchanged.
 */
export const HAYSTACK_HEADER_FIELD_CAP = 16_384;
export const HAYSTACK_HEADER_CAP = 262_144;
/** Messages per query B statement (4 parameters each). */
const HAYSTACK_QUERY_CHUNK = 1000;

/**
 * Addresses and text of a thread's stored messages (for the Phase 2c approval warnings).
 *
 * S3 (phase-2-followups-3, owner Q3): the body fields in the haystack are bounded. Query A reads every
 * message's headers and subject (uncapped: the recipients warning needs whole addresses) and each body
 * field's stored size (`octet_length`, which Postgres reads from the value's header without
 * decompressing it), newest message first. The fields are then planned in that order (per message:
 * body text, rendered text, rendered HTML), each within min(HAYSTACK_FIELD_CAP, what is left of
 * HAYSTACK_CAP). A field's UTF-8 size is at least its UTF-16 length, so reserving min(budget, size)
 * never lets the total pass the cap. Query B fetches only the planned fields, with `left()`, so the DB
 * never ships a huge body. A field longer than its budget is cut on a code point, then back to a token
 * boundary (cutAtTokenBoundary), so a cut can't turn "bank.com" into a known "bank.co". `truncated`
 * is true when any field was cut or left out; a cap can only add link warnings, never remove one.
 *
 * Sec N4 (owner Q7 a): the headers' and subjects' copies in the haystack have their own budget, also
 * newest message first: each at most HAYSTACK_HEADER_FIELD_CAP, all together at most
 * HAYSTACK_HEADER_CAP, cut the same way (a cut or omission sets `truncated`). `addresses` is still
 * built from the whole headers, and normal-size headers give exactly the haystack they gave before.
 */
export async function threadContext(ex: Executor, userId: string, threadId: string): Promise<{ addresses: string[]; haystack: string; truncated: boolean }> {
  const rows = await ex
    .select({
      id: mailMessages.id,
      fromHeader: mailMessages.fromHeader,
      toHeader: mailMessages.toHeader,
      ccHeader: mailMessages.ccHeader,
      replyToHeader: mailMessages.replyToHeader,
      subject: mailMessages.subject,
      bodyTextSize: sql<number | null>`octet_length(${mailMessages.bodyText})`.mapWith(Number),
      renderedTextSize: sql<number | null>`octet_length(${mailMessages.renderedText})`.mapWith(Number),
      renderedHtmlSize: sql<number | null>`octet_length(${mailMessages.renderedHtml})`.mapWith(Number),
    })
    .from(mailMessages)
    .where(and(eq(mailMessages.threadId, threadId), eq(mailMessages.userId, userId)))
    .orderBy(desc(mailMessages.internalDate), desc(mailMessages.id));

  // Plan the body fields, newest message first: each gets a budget, or 0 if it is empty or left out.
  let remaining = HAYSTACK_CAP;
  let truncated = false;
  const budgets = new Map<string, [number, number, number]>();
  for (const r of rows) {
    const sizes = [r.bodyTextSize, r.renderedTextSize, r.renderedHtmlSize];
    const b: [number, number, number] = [0, 0, 0];
    for (let f = 0; f < 3; f++) {
      const size = sizes[f];
      if (!size) continue;
      if (remaining <= 0) {
        truncated = true;
        continue;
      }
      b[f] = Math.min(HAYSTACK_FIELD_CAP, remaining);
      remaining -= Math.min(b[f], size);
    }
    if (b[0] + b[1] + b[2] > 0) budgets.set(r.id, b);
  }

  // Query B: only the planned fields, at most budget + 1 characters each (the extra one shows a cut).
  const texts = new Map<string, [string | null, string | null, string | null]>();
  const planned = [...budgets.entries()];
  const n = (budget: number) => (budget > 0 ? budget + 1 : 0);
  for (let i = 0; i < planned.length; i += HAYSTACK_QUERY_CHUNK) {
    const chunk = planned.slice(i, i + HAYSTACK_QUERY_CHUNK);
    const values = sql.join(
      chunk.map(([id, b]) => sql`(${id}::uuid, ${n(b[0])}::int, ${n(b[1])}::int, ${n(b[2])}::int)`),
      sql`, `,
    );
    const got = await ex.execute(sql`
      select m.id, left(m.body_text, v.a) as body_text, left(m.rendered_text, v.b) as rendered_text, left(m.rendered_html, v.c) as rendered_html
      from ${mailMessages} m join (values ${values}) as v(id, a, b, c) on m.id = v.id
      where m.user_id = ${userId}::uuid`);
    for (const g of got as unknown as { id: string; body_text: string | null; rendered_text: string | null; rendered_html: string | null }[]) texts.set(g.id, [g.body_text, g.rendered_text, g.rendered_html]);
  }

  const addresses = new Set<string>();
  const parts: string[] = [];
  let headerRemaining = HAYSTACK_HEADER_CAP;
  /** The haystack's copy of one header or subject, within the header budget (Sec N4). */
  const pushHeader = (value: string | null) => {
    if (!value) return;
    const budget = Math.min(HAYSTACK_HEADER_FIELD_CAP, headerRemaining);
    let text = value;
    if (text.length > budget) {
      text = budget > 0 ? cutAtTokenBoundary(sliceOnCodePoint(text, budget)) : "";
      truncated = true;
    }
    headerRemaining -= text.length;
    if (text) parts.push(text);
  };
  for (const r of rows) {
    for (const h of [r.fromHeader, r.toHeader, r.ccHeader, r.replyToHeader]) {
      for (const a of extractAddresses(h).addresses) addresses.add(a.toLowerCase());
      pushHeader(h);
    }
    pushHeader(r.subject);
    const b = budgets.get(r.id);
    const t = texts.get(r.id);
    if (!b) continue;
    for (let f = 0; f < 3; f++) {
      let text = t?.[f] ?? null;
      if (b[f] === 0 || !text) continue;
      if (text.length > b[f]) {
        text = cutAtTokenBoundary(sliceOnCodePoint(text, b[f]));
        truncated = true;
      }
      if (text) parts.push(text);
    }
  }
  return { addresses: [...addresses], haystack: parts.join(" "), truncated };
}

/** Everything the detail page shows, or null if it isn't the user's item. */
export async function getItemView(
  ex: Executor,
  userId: string,
  itemId: string,
  opts: { newRecipientLimit?: number; now?: Date } = {},
): Promise<ItemView | null> {
  const item = await getOwnItem(ex, userId, itemId);
  if (!item) return null;
  const payload = emailSendPayload.parse(item.payload);
  const shown = item.approvedPayload ? emailSendPayload.parse(item.approvedPayload) : payload;
  const account = item.accountId
    ? ((await ex
        .select({ id: connectedAccounts.id, email: connectedAccounts.email, label: connectedAccounts.label, status: connectedAccounts.status })
        .from(connectedAccounts)
        .where(and(eq(connectedAccounts.id, item.accountId), eq(connectedAccounts.userId, userId)))
        .limit(1))[0] ?? null)
    : null;
  const thread = item.threadId
    ? ((await ex
        .select({ id: mailThreads.id, subject: mailThreads.subject, messageCount: mailThreads.messageCount, accountId: mailThreads.accountId })
        .from(mailThreads)
        .where(and(eq(mailThreads.id, item.threadId), eq(mailThreads.userId, userId)))
        .limit(1))[0] ?? null)
    : null;
  const parent = item.parentMessageId
    ? ((await ex
        .select({
          ...parentColumns,
          renderKind: mailMessages.renderKind,
          renderReason: mailMessages.renderReason,
          renderedHtml: mailMessages.renderedHtml,
          renderedHtmlRemote: mailMessages.renderedHtmlRemote,
          renderTruncated: mailMessages.renderTruncated,
          sanitizerVersion: mailMessages.sanitizerVersion,
          bodyIncomplete: mailMessages.bodyIncomplete,
        })
        .from(mailMessages)
        .where(and(eq(mailMessages.id, item.parentMessageId), eq(mailMessages.userId, userId)))
        .limit(1))[0] ?? null)
    : null;
  const ctx = item.threadId ? await threadContext(ex, userId, item.threadId) : { addresses: [], haystack: "", truncated: false };
  const ownAccounts = (await ex.select({ email: connectedAccounts.email }).from(connectedAccounts).where(eq(connectedAccounts.userId, userId))).map((a) => a.email);
  const newer = await newerMessageIds(ex, item);

  // Phase 2d: first-time markers, IDN display, the cap, and the sent new message's thread.
  const isNew = isNewMessage(shown);
  const firstTime = await firstTimeRecipients(ex, userId, shown, replyParentOf(item));
  const idn: Record<string, string> = {};
  for (const a of [...shown.to, ...shown.cc]) {
    const u = idnDisplay(a);
    if (u !== null) idn[a] = u;
  }
  const limit = opts.newRecipientLimit ?? newRecipientLimit();
  const usedToday = await newRecipientsUsedToday(ex, userId, utcDayStart(opts.now ?? new Date()));
  const sentGmailThreadId = (item.result as { gmailThreadId?: unknown } | null)?.gmailThreadId;
  const sentThread =
    isNew && item.accountId && typeof sentGmailThreadId === "string"
      ? ((await ex
          .select({ id: mailThreads.id, subject: mailThreads.subject, messageCount: mailThreads.messageCount })
          .from(mailThreads)
          .where(and(eq(mailThreads.accountId, item.accountId), eq(mailThreads.gmailThreadId, sentGmailThreadId), eq(mailThreads.userId, userId)))
          .limit(1))[0] ?? null)
      : null;
  return {
    item,
    payload,
    shown,
    account,
    thread,
    parent,
    threadAddresses: ctx.addresses,
    ownAccounts,
    threadHaystack: ctx.haystack,
    threadHaystackTruncated: ctx.truncated,
    isNew,
    newerCount: newer.length,
    newerDigest: newerDigest(newer),
    firstTime,
    idn,
    cap: { limit, usedToday, remaining: capRemaining(usedToday, limit) },
    sentThread,
  };
}
