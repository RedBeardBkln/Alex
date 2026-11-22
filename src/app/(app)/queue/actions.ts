"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/db";
import { approveAndSend } from "@/lib/approvals/execute";
import { ForbiddenOriginError, isAllowedOrigin } from "@/lib/approvals/origin";
import { reconcileApprovals } from "@/lib/approvals/reconcile";
import { approvalExecutorDeps, approvalReconcileDeps, messageIdHost } from "@/lib/approvals/runtime";
import { newRecipientLimit } from "@/lib/approvals/recipients";
import {
  cancelItem,
  editItem,
  markNotSent,
  MAX_CONFIRMED_RECIPIENT_CHARS,
  MAX_CONFIRMED_RECIPIENTS,
  proposeNewMessage,
  proposeReply,
  rejectItem,
} from "@/lib/approvals/service";
import { env } from "@/lib/env";
import { requireUser } from "@/lib/session";

/**
 * Approval queue Server Actions (Phase 2b, plan §6). Each one requires a signed-in user, checks
 * the Origin header, validates its input with zod and acts only on the user's own items. Only
 * `approveItem` can lead to a send, through approveAndSend (approve, claim, execute). Composing a
 * new message (Phase 2d) only creates a pending item, like a reply.
 */

const uuid = z.uuid();
const revision = z.coerce.number().int().positive();
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const text = (max: number) => z.string().max(max).default("");

async function guard() {
  const user = await requireUser();
  if (!isAllowedOrigin((await headers()).get("origin"), env().APP_URL)) throw new ForbiddenOriginError();
  return user;
}

function field(formData: FormData, name: string): string | undefined {
  const v = formData.get(name);
  return typeof v === "string" ? v : undefined;
}

const itemPath = (id: string, notice?: string) => `/queue/${id}${notice ? `?notice=${notice}` : ""}`;

/** What the reply form shows again after a refused save (review N2: keep the mode and the typed text). */
export type ReplyFormState = {
  /** Increases with every refused save, so the form remounts with these values. */
  seq: number;
  error: string;
  values: { to: string; cc: string; subject: string; bodyText: string; includeQuote: boolean };
} | null;

async function proposeFromForm(user: { id: string }, formData: FormData) {
  const input = z
    .object({
      threadId: uuid,
      parentMessageId: uuid,
      mode: z.enum(["reply", "all"]).default("reply"),
      to: text(20_000),
      cc: text(20_000),
      subject: text(1_000),
      bodyText: text(200_000),
      includeQuote: z.enum(["on"]).optional(),
    })
    .parse({
      threadId: field(formData, "threadId"),
      parentMessageId: field(formData, "parentMessageId"),
      mode: field(formData, "mode"),
      to: field(formData, "to"),
      cc: field(formData, "cc"),
      subject: field(formData, "subject"),
      bodyText: field(formData, "bodyText"),
      includeQuote: field(formData, "includeQuote"),
    });
  const includeQuote = input.includeQuote === "on";
  const result = await proposeReply(db(), { ...input, userId: user.id, includeQuote });
  return { input, includeQuote, result };
}

/** Plain form action (no client state): on a refused save, back to the form in the same mode. */
export async function proposeReplyAction(formData: FormData) {
  const user = await guard();
  const { input, result } = await proposeFromForm(user, formData);
  if (!result.ok) redirect(`/inbox/${input.threadId}?reply=${input.mode === "all" ? "all" : "1"}&error=${result.error}#reply`);
  revalidatePath("/queue");
  redirect(itemPath(result.itemId));
}

/** The reply form's action (useActionState): a refused save returns the error and the typed values. */
export async function proposeReplyFormAction(prev: ReplyFormState, formData: FormData): Promise<ReplyFormState> {
  const user = await guard();
  const { input, includeQuote, result } = await proposeFromForm(user, formData);
  if (!result.ok) {
    return { seq: (prev?.seq ?? 0) + 1, error: result.error, values: { to: input.to, cc: input.cc, subject: input.subject, bodyText: input.bodyText, includeQuote } };
  }
  revalidatePath("/queue");
  redirect(itemPath(result.itemId));
}

/** What the compose form shows again after a refused save (the owner's own input only, never stored). */
export type ComposeFormState = {
  /** Increases with every refused save, so the form remounts with these values. */
  seq: number;
  error: string;
  /** Up to 10 of the owner's invalid address tokens, echoed back in the response only. */
  invalid: string[];
  values: { accountId: string; to: string; cc: string; subject: string; bodyText: string };
} | null;

/**
 * The compose form's action (Phase 2d, plan §6.1): creates a pending new-message item from the
 * owner's typed fields and the account they picked, then opens it. Nothing is sent from here.
 */
export async function proposeNewMessageFormAction(prev: ComposeFormState, formData: FormData): Promise<ComposeFormState> {
  const user = await guard();
  const input = z
    .object({
      accountId: z.string().max(100).default(""),
      to: text(20_000),
      cc: text(20_000),
      subject: text(1_000),
      bodyText: text(200_000),
    })
    .parse({
      accountId: field(formData, "accountId"),
      to: field(formData, "to"),
      cc: field(formData, "cc"),
      subject: field(formData, "subject"),
      bodyText: field(formData, "bodyText"),
    });
  const refuse = (error: string, invalid: string[] = []): ComposeFormState => ({ seq: (prev?.seq ?? 0) + 1, error, invalid, values: input });
  // No account picked (there is no default): refused before anything else.
  if (!uuid.safeParse(input.accountId).success) return refuse("no_account");
  const result = await proposeNewMessage(db(), { userId: user.id, accountId: input.accountId, to: input.to, cc: input.cc, subject: input.subject, bodyText: input.bodyText });
  if (!result.ok) return refuse(result.error, result.invalid ?? []);
  revalidatePath("/queue");
  redirect(itemPath(result.itemId));
}

export async function editItemAction(formData: FormData) {
  const user = await guard();
  const input = z
    .object({
      itemId: uuid,
      revision,
      to: text(20_000),
      cc: text(20_000),
      subject: text(1_000),
      bodyText: text(200_000),
      includeQuote: z.enum(["on"]).optional(),
    })
    .parse({
      itemId: field(formData, "itemId"),
      revision: field(formData, "revision"),
      to: field(formData, "to"),
      cc: field(formData, "cc"),
      subject: field(formData, "subject"),
      bodyText: field(formData, "bodyText"),
      includeQuote: field(formData, "includeQuote"),
    });
  const result = await editItem(db(), { ...input, userId: user.id, includeQuote: input.includeQuote === "on" });
  revalidatePath("/queue");
  if (!result.ok) redirect(result.error === "stale" || result.error === "not_found" ? itemPath(input.itemId, "stale") : `${itemPath(input.itemId)}?edit=1&error=${result.error}`);
  redirect(itemPath(input.itemId, "edited"));
}

export async function approveItemAction(formData: FormData) {
  const user = await guard();
  const input = z
    .object({
      itemId: uuid,
      revision,
      contentHash: hash,
      ackThreadChange: z.enum(["on"]).optional(),
      // The thread_changed_at the page rendered (epoch ms), empty if it showed no new-message warning (B1).
      shownThreadChangedAt: z.string().regex(/^[0-9]{0,16}$/).default(""),
      // SF2 (owner Q1 option c): the newer-message digest the page rendered; empty if it showed none.
      // A page rendered before this field existed sends nothing, which counts as "".
      shownNewer: z.string().regex(/^([0-9a-f]{64})?$/).default(""),
    })
    .parse({
      itemId: field(formData, "itemId"),
      revision: field(formData, "revision"),
      contentHash: field(formData, "contentHash"),
      ackThreadChange: field(formData, "ackThreadChange"),
      shownThreadChangedAt: field(formData, "shownThreadChangedAt"),
      shownNewer: field(formData, "shownNewer"),
    });
  // Phase 2d, owner Q2: the ticked recipient boxes (new messages). Bounded before use.
  const confirmedRecipients = z
    .array(z.string().max(MAX_CONFIRMED_RECIPIENT_CHARS))
    .max(MAX_CONFIRMED_RECIPIENTS)
    .parse(formData.getAll("confirmRecipient").filter((v): v is string => typeof v === "string"));
  const result = await approveAndSend(approvalExecutorDeps(), {
    userId: user.id,
    itemId: input.itemId,
    revision: input.revision,
    contentHash: input.contentHash,
    ackThreadChange: input.ackThreadChange === "on",
    shownThreadChangedAt: input.shownThreadChangedAt === "" ? null : Number(input.shownThreadChangedAt),
    shownNewer: input.shownNewer,
    messageIdHost: messageIdHost(),
    confirmedRecipients,
    newRecipientLimit: newRecipientLimit(),
  });
  revalidatePath("/queue");
  let notice: string;
  if (result.kind === "executed") notice = result.outcome.kind === "succeeded" ? "sent" : result.outcome.kind;
  else if (result.kind === "not_claimed") notice = "in_progress";
  else notice = result.result.kind === "blocked" ? result.result.reason : "stale";
  redirect(itemPath(input.itemId, notice));
}

async function simpleAction(formData: FormData, run: (userId: string, itemId: string) => Promise<boolean>, okNotice: string) {
  const user = await guard();
  const itemId = uuid.parse(field(formData, "itemId"));
  const ok = await run(user.id, itemId);
  revalidatePath("/queue");
  redirect(itemPath(itemId, ok ? okNotice : "stale"));
}

export async function rejectItemAction(formData: FormData) {
  await simpleAction(formData, (userId, itemId) => rejectItem(db(), userId, itemId), "rejected");
}

export async function cancelItemAction(formData: FormData) {
  await simpleAction(formData, (userId, itemId) => cancelItem(db(), userId, itemId), "cancelled");
}

export async function markNotSentAction(formData: FormData) {
  await simpleAction(formData, (userId, itemId) => markNotSent(db(), userId, itemId, new Date()), "marked_not_sent");
}

export async function recheckItemAction(formData: FormData) {
  const user = await guard();
  const itemId = uuid.parse(field(formData, "itemId"));
  const r = await reconcileApprovals(approvalReconcileDeps(), { userId: user.id, itemId });
  revalidatePath("/queue");
  redirect(itemPath(itemId, r.found > 0 ? "found" : r.errors > 0 ? "check_failed" : "not_found_yet"));
}
