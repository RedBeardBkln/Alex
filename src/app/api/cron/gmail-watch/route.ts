import type { NextRequest } from "next/server";
import { isAuthorizedCron } from "@/lib/cron-auth";
import { env } from "@/lib/env";
import { defaultSyncDeps } from "@/lib/gmail/runtime";
import { runWatchRenewal } from "@/lib/gmail/sync";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Vercel Cron, daily: renew the Gmail watch (push registration) for every active account. */
export async function GET(request: NextRequest) {
  if (!isAuthorizedCron(request.headers.get("authorization"), env().CRON_SECRET)) {
    return new Response(null, { status: 401 });
  }
  const results = await runWatchRenewal(defaultSyncDeps());
  return Response.json({
    ok: true,
    renewed: results.filter((r) => r.outcome === "renewed").length,
    skipped: results.filter((r) => r.outcome === "skipped").length,
  });
}
