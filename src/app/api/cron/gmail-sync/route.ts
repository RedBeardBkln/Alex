import type { NextRequest } from "next/server";
import { productionTriage } from "@/lib/ai/runtime";
import { reconcileApprovals } from "@/lib/approvals/reconcile";
import { approvalReconcileDeps } from "@/lib/approvals/runtime";
import { isAuthorizedCron } from "@/lib/cron-auth";
import { env } from "@/lib/env";
import { defaultSyncDeps } from "@/lib/gmail/runtime";
import { runCronSync } from "@/lib/gmail/sync";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Vercel Cron, every 5 minutes: setup, watch renewal within 24h, history sync, backfill/resync
 * listing, hydration; then (Phase 2b) reconciling approval items whose send outcome is unknown.
 */
export async function GET(request: NextRequest) {
  if (!isAuthorizedCron(request.headers.get("authorization"), env().CRON_SECRET)) {
    return new Response(null, { status: 401 });
  }
  // Phase 2c: AI triage of recent INBOX mail runs inside each account's sync when configured.
  const results = await runCronSync({ ...defaultSyncDeps(), triage: productionTriage() });
  const counts: Record<string, number> = {};
  const renders: Record<string, number> = {};
  for (const r of results) {
    counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
    for (const [k, n] of Object.entries(r.renders ?? {})) renders[k] = (renders[k] ?? 0) + n;
  }
  // Content-free render counts by kind and reason (e.g. {"html":12,"text:too_deep":1}); this is the
  // post-merge production check that the render worker runs in the deployed function (SETUP §6.8).
  if (Object.keys(renders).length > 0) console.info("gmail-sync renders", renders);
  // Read-only lookups by our Message-ID; nothing is ever re-sent from here (plan §5.4).
  const approvals = await reconcileApprovals(approvalReconcileDeps()).catch((err: unknown) => {
    console.error("approval reconcile failed", { error: err instanceof Error ? err.name : "unknown" });
    return null;
  });
  return Response.json({ ok: true, accounts: results.length, outcomes: counts, renders, approvals });
}
