"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireActionUser } from "../../action-guard";

/**
 * Phase 2c AI actions on the thread page. Each one requires sign-in and the app's Origin
 * (requireActionUser), and loads the AI code with a dynamic import, so the page's static import
 * graph stays free of the Anthropic SDK (AC10). Nothing here sends: a draft becomes a pending
 * `source: ai` approval item.
 */

const uuid = z.uuid();

/** The Inbox shows fixed text for this value only (src/app/(app)/inbox/page.tsx). */
const ACCOUNT_DISCONNECTED_NOTICE = "/inbox?notice=account_disconnected";

function field(formData: FormData, name: string): string | undefined {
  const v = formData.get(name);
  return typeof v === "string" ? v : undefined;
}

export async function draftReplyAction(formData: FormData) {
  const user = await requireActionUser();
  const input = z
    .object({
      threadId: uuid,
      mode: z.enum(["reply", "all"]).default("reply"),
      instruction: z.string().max(4_000).default(""),
    })
    .parse({ threadId: field(formData, "threadId"), mode: field(formData, "mode"), instruction: field(formData, "instruction") });
  const { draftReplyNow } = await import("@/lib/ai/runtime");
  const result = await draftReplyNow({ userId: user.id, threadId: input.threadId, mode: input.mode, instruction: input.instruction || null });
  // O2 (owner Q7): the thread page 404s once its account is disconnected, so both answers go to the
  // Inbox with a fixed notice (since O1, not_found also means the thread or its account is gone).
  if (!result.ok && (result.code === "account_disconnected" || result.code === "not_found")) redirect(ACCOUNT_DISCONNECTED_NOTICE);
  if (!result.ok) redirect(`/inbox/${input.threadId}?ai_error=${result.code}#ai`);
  revalidatePath("/queue");
  redirect(`/queue/${result.itemId}`);
}

export async function triageThreadAction(formData: FormData) {
  const user = await requireActionUser();
  const threadId = uuid.parse(field(formData, "threadId"));
  const { triageThreadOnDemand } = await import("@/lib/ai/runtime");
  const outcome = await triageThreadOnDemand(user.id, threadId);
  if (outcome === "account_disconnected") redirect(ACCOUNT_DISCONNECTED_NOTICE);
  revalidatePath(`/inbox/${threadId}`);
  redirect(`/inbox/${threadId}?ai_triage=${outcome}#ai`);
}
