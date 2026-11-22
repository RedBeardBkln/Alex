import type { Executor } from "@/db";
import { approveAndSend as realApproveAndSend, type ExecutorDeps } from "@/lib/approvals/execute";
import { approveItem as realApproveItem, getOwnItem, newerDigest, newerMessageIds } from "@/lib/approvals/service";

/**
 * Test-only wrappers for approveItem and approveAndSend (phase-2-followups-3, S1, owner Q2).
 *
 * The real functions require `shownNewer` (the newer-message digest the approval page rendered). These
 * wrappers make it optional: when the key is absent, they compute it from the stored thread right
 * before the call, which simulates "the approval page was rendered just now". An explicit value,
 * `undefined` included, is passed through unchanged.
 *
 * SF2 tests (approve bound to the newer-message set the page showed) must NOT use these: import the
 * real functions from `@/lib/approvals/service` / `@/lib/approvals/execute` and pass the field.
 */
type ApproveInput = Parameters<typeof realApproveItem>[1];
export type TestApproveInput = Omit<ApproveInput, "shownNewer"> & { shownNewer?: string };

async function withShownNewer(ex: Executor, input: TestApproveInput): Promise<ApproveInput> {
  if ("shownNewer" in input) return input as ApproveInput;
  const item = await getOwnItem(ex, input.userId, input.itemId);
  // No item: the real call returns not_found anyway.
  const shownNewer = item ? newerDigest(await newerMessageIds(ex, item)) : "";
  return { ...input, shownNewer };
}

export async function approveItem(ex: Executor, input: TestApproveInput): ReturnType<typeof realApproveItem> {
  return realApproveItem(ex, await withShownNewer(ex, input));
}

export async function approveAndSend(deps: ExecutorDeps, input: TestApproveInput): ReturnType<typeof realApproveAndSend> {
  return realApproveAndSend(deps, await withShownNewer(deps.db, input));
}
