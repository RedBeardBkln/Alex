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
import { cancelItem, editItem, markNotSent, proposeReply, rejectItem } from "@/lib/approvals/service";
import { env } from "@/lib/env";
import { requireUser } from "@/lib/session";

/**
 * Approval queue Server Actions (Phase 2b, plan §6). Each one requires a signed-in user, checks
 * the Origin header, validates its input with zod and acts only on the user's own items. Only
 * `approveItem` can lead to a send, through approveAndSend (approve, claim, execute).
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
    })
    .parse({
      itemId: field(formData, "itemId"),
      revision: field(formData, "revision"),
      contentHash: field(formData, "contentHash"),
      ackThreadChange: field(formData, "ackThreadChange"),
      shownThreadChangedAt: field(formData, "shownThreadChangedAt"),
    });
  const result = await approveAndSend(approvalExecutorDeps(), {
    userId: user.id,
    itemId: input.itemId,
    revision: input.revision,
    contentHash: input.contentHash,
    ackThreadChange: input.ackThreadChange === "on",
    shownThreadChangedAt: input.shownThreadChangedAt === "" ? null : Number(input.shownThreadChangedAt),
    messageIdHost: messageIdHost(),
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
