import { randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import type { Executor } from "@/db";
import { approvalItems, connectedAccounts, mailMessages, mailThreads, type ApprovalItem, type ConnectedAccount } from "@/db/schema";
import { audit } from "@/lib/audit";
import { MAX_BODY_CHARS, isValidSubject, replySubject, replyThreading } from "@/lib/gmail/compose";
import { extractAddresses, MAX_RECIPIENTS, parseRecipientInput, replyDefaults, replyToDiffers, type ParentHeaders } from "./addresses";
import { contentHash, emailSendPayload, quoteText, type EmailSendPayload } from "./payload";
import { hasDisallowedControl, sliceOnCodePoint, stripAllControls, wellFormed } from "./text";

/**
 * The approval queue's state machine (Phase 2b, plan §5). Every transition is one conditional
 * UPDATE plus its audit entry in the same transaction, so concurrent callers can't both win and a
 * rollback leaves neither. Every query is scoped to the user. Audit details carry ids, counts,
 * hashes and content-free codes only: no addresses, subjects or body text.
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
  | "account_not_google";

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

/** Owner-entered fields to a validated payload (recipients re-checked, Reply-To notice recomputed in code). */
function buildEmailPayload(
  fields: { to: string; cc: string; subject: string; bodyText: string; includeQuote: boolean },
  /** `quote` is only called when the owner includes the quote (review D2: an excluded quote isn't computed or stored). */
  base: { quote: () => string | null; threading: EmailSendPayload["threading"]; parent: ParentHeaders | null; previousNotice: boolean },
): { ok: true; payload: EmailSendPayload } | { ok: false; error: InputError } {
  const to = parseRecipientInput(fields.to);
  const cc = parseRecipientInput(fields.cc);
  if (to.invalid.length > 0 || cc.invalid.length > 0) return { ok: false, error: "invalid_recipients" };
  if (to.addresses.length === 0) return { ok: false, error: "no_recipients" };
  const ccList = cc.addresses.filter((a) => !to.addresses.some((t) => t.toLowerCase() === a.toLowerCase()));
  if (to.addresses.length + ccList.length > MAX_RECIPIENTS) return { ok: false, error: "too_many_recipients" };
  // Lone surrogates become U+FFFD (jsonb rejects them); NUL and other controls are validation errors (review D2, D4).
  const subject = wellFormed(fields.subject).trim();
  if (!isValidSubject(subject)) return { ok: false, error: "invalid_subject" };
  const bodyText = wellFormed(fields.bodyText).replace(/\r\n?/g, "\n");
  if (hasDisallowedControl(bodyText)) return { ok: false, error: "invalid_body" };
  if (bodyText.length > MAX_BODY_CHARS) return { ok: false, error: "body_too_long" };
  const quote = fields.includeQuote ? base.quote() : null;
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
  // Round 3, E2: check again now that the item is committed. A message committed while the
  // transaction above was open is seen here; one committed later is flagged by the ingest hook's
  // post-commit step (afterMessageCommitted), which then sees this item. Either way it's flagged.
  if (await newerMessageInThread(ex, input.userId, ctx.thread.id, ctx.parent.id, ctx.parent.internalDate)) {
    await ex
      .update(approvalItems)
      .set({ threadChangedAt: new Date() })
      .where(and(eq(approvalItems.id, itemId), isNull(approvalItems.threadChangedAt), inArray(approvalItems.status, OPEN)));
  }
  return { ok: true, itemId };
}

/**
 * True if the thread holds a message newer than the parent that isn't one of Alex's own sends (a
 * SENT copy carrying an approval item's Message-ID in the same account), the rule the ingest hook
 * uses.
 */
export async function newerMessageInThread(ex: Executor, userId: string, threadId: string, parentId: string, parentInternalDate: Date): Promise<boolean> {
  const [row] = await ex
    .select({ id: mailMessages.id })
    .from(mailMessages)
    .where(
      and(
        eq(mailMessages.threadId, threadId),
        eq(mailMessages.userId, userId),
        sql`${mailMessages.id} <> ${parentId}::uuid`,
        sql`${mailMessages.internalDate} > ${parentInternalDate.toISOString()}::timestamptz`,
        sql`not (${mailMessages.isSent} and ${mailMessages.rfc822MessageId} is not null and exists (
          select 1 from ${approvalItems} a
          where a.account_id = ${mailMessages.accountId} and a.message_id_header = ${mailMessages.rfc822MessageId}
        ))`,
      ),
    )
    .limit(1);
  return !!row;
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
  const parent = item.parentMessageId
    ? ((await ex.select(parentColumns).from(mailMessages).where(and(eq(mailMessages.id, item.parentMessageId), eq(mailMessages.userId, input.userId))).limit(1))[0] ?? null)
    : null;
  const built = buildEmailPayload(input, {
    quote: () => current.quote?.text ?? (parent ? parentQuote(parent) : null),
    threading: current.threading,
    parent,
    previousNotice: current.replyToNotice,
  });
  if (!built.ok) return built;
  const hash = contentHash(item.kind, item.accountId, built.payload);
  return ex.transaction(async (tx) => {
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
  | { kind: "blocked"; reason: "not_found" | "account_inactive" | "account_mismatch" | "hash_mismatch" | "ack_required" };

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
    messageIdHost: string;
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

  // A new Message-ID for every approval, so an approve-again after a definite failure (Q8) is a new message.
  const messageId = `<alex.${item.id}.${item.revision}.${randomBytes(6).toString("hex")}@${input.messageIdHost}>`;
  return ex.transaction(async (tx) => {
    const [row] = await tx
      .update(approvalItems)
      .set({
        status: "approved",
        approvedRevision: item.revision,
        approvedHash: item.contentHash,
        approvedPayload: item.payload,
        approvedAt: new Date(),
        messageIdHeader: messageId,
        executionId: null,
        executingSince: null,
        errorCode: null,
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
    await audit(
      { userId: input.userId, accountId: item.accountId, action: "approval.approved", detail: { itemId: item.id, revision: item.revision, contentHash: item.contentHash } },
      tx,
    );
    return { kind: "approved" as const };
  });
}

/** For email.send: the account must be active and, for a reply, still the thread's account. */
async function accountCheck(ex: Executor, item: ApprovalItem): Promise<"ok" | "account_inactive" | "account_mismatch" | "not_found"> {
  if (!item.accountId) return "account_mismatch";
  const [account] = await ex
    .select({ status: connectedAccounts.status, userId: connectedAccounts.userId })
    .from(connectedAccounts)
    .where(eq(connectedAccounts.id, item.accountId))
    .limit(1);
  if (!account || account.userId !== item.userId) return "account_mismatch";
  if (account.status !== "active") return "account_inactive";
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
  return ex.transaction(async (tx) => {
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
    } else if (outcome.kind === "failed") {
      await audit({ ...base, action: "approval.execution_failed", detail: { itemId: item.id, code: outcome.code, status: outcome.status } }, tx);
    } else {
      await audit({ ...base, action: "approval.execution_unknown", detail: { itemId: item.id, code: outcome.code } }, tx);
    }
    return true;
  });
}

// ---- Reject, cancel, mark not sent, reconcile ----------------------------------------------------

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
  return ex.transaction(async (tx) => {
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
    const now = new Date();
    const [row] = await tx
      .update(approvalItems)
      .set({ status: "succeeded", result: found, completedAt: now, updatedAt: now, errorCode: null })
      // Scoped to the item's user as well (security review N1).
      .where(and(eq(approvalItems.id, item.id), eq(approvalItems.userId, item.userId), inArray(approvalItems.status, ["unknown", "executing"])))
      .returning({ id: approvalItems.id });
    if (!row) return false;
    await audit({ userId: item.userId, accountId: item.accountId, action: "approval.reconciled", detail: { itemId: item.id, outcome } }, tx);
    return true;
  });
}

/** executing (stuck past STUCK_EXECUTING_MS, nothing found) -> unknown. Never retried automatically. */
export async function markStuckUnknown(ex: Executor, item: Pick<ApprovalItem, "id" | "userId" | "accountId">, now: Date): Promise<boolean> {
  return ex.transaction(async (tx) => {
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
};

/** Addresses and text of a thread's stored messages (for the Phase 2c approval warnings). */
export async function threadContext(ex: Executor, userId: string, threadId: string): Promise<{ addresses: string[]; haystack: string }> {
  const rows = await ex
    .select({
      fromHeader: mailMessages.fromHeader,
      toHeader: mailMessages.toHeader,
      ccHeader: mailMessages.ccHeader,
      replyToHeader: mailMessages.replyToHeader,
      subject: mailMessages.subject,
      bodyText: mailMessages.bodyText,
      renderedText: mailMessages.renderedText,
      renderedHtml: mailMessages.renderedHtml,
    })
    .from(mailMessages)
    .where(and(eq(mailMessages.threadId, threadId), eq(mailMessages.userId, userId)));
  const addresses = new Set<string>();
  const parts: string[] = [];
  for (const r of rows) {
    for (const h of [r.fromHeader, r.toHeader, r.ccHeader, r.replyToHeader]) {
      for (const a of extractAddresses(h).addresses) addresses.add(a.toLowerCase());
      if (h) parts.push(h);
    }
    for (const t of [r.subject, r.bodyText, r.renderedText, r.renderedHtml]) if (t) parts.push(t);
  }
  return { addresses: [...addresses], haystack: parts.join(" ") };
}

/** Everything the detail page shows, or null if it isn't the user's item. */
export async function getItemView(ex: Executor, userId: string, itemId: string): Promise<ItemView | null> {
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
  const ctx = item.threadId ? await threadContext(ex, userId, item.threadId) : { addresses: [], haystack: "" };
  const ownAccounts = (await ex.select({ email: connectedAccounts.email }).from(connectedAccounts).where(eq(connectedAccounts.userId, userId))).map((a) => a.email);
  return { item, payload, shown, account, thread, parent, threadAddresses: ctx.addresses, ownAccounts, threadHaystack: ctx.haystack };
}
