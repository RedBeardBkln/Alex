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
  if (!result.ok) redirect(`/inbox/${input.threadId}?ai_error=${result.code}#ai`);
  revalidatePath("/queue");
  redirect(`/queue/${result.itemId}`);
}

export async function triageThreadAction(formData: FormData) {
  const user = await requireActionUser();
  const threadId = uuid.parse(field(formData, "threadId"));
  const { triageThreadOnDemand } = await import("@/lib/ai/runtime");
  const outcome = await triageThreadOnDemand(user.id, threadId);
  revalidatePath(`/inbox/${threadId}`);
  redirect(`/inbox/${threadId}?ai_triage=${outcome}#ai`);
}
