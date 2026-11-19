import type { NextRequest } from "next/server";
import { isAuthorizedCron } from "@/lib/cron-auth";
import { env } from "@/lib/env";
import { defaultSyncDeps } from "@/lib/gmail/runtime";
import { runCronSync } from "@/lib/gmail/sync";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Vercel Cron, every 5 minutes: setup, watch renewal within 24h, history sync, backfill/resync listing, hydration. */
export async function GET(request: NextRequest) {
  if (!isAuthorizedCron(request.headers.get("authorization"), env().CRON_SECRET)) {
    return new Response(null, { status: 401 });
  }
  const results = await runCronSync(defaultSyncDeps());
  const counts: Record<string, number> = {};
  const renders: Record<string, number> = {};
  for (const r of results) {
    counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
    for (const [k, n] of Object.entries(r.renders ?? {})) renders[k] = (renders[k] ?? 0) + n;
  }
  // Content-free render counts by kind and reason (e.g. {"html":12,"text:too_deep":1}); this is the
  // post-merge production check that the render worker runs in the deployed function (SETUP §6.8).
  if (Object.keys(renders).length > 0) console.info("gmail-sync renders", renders);
  return Response.json({ ok: true, accounts: results.length, outcomes: counts, renders });
}
