import { after, type NextRequest } from "next/server";
import { db } from "@/db";
import { env } from "@/lib/env";
import { handlePush } from "@/lib/gmail/push";
import { defaultSyncDeps } from "@/lib/gmail/runtime";
import { syncAfterPush } from "@/lib/gmail/sync";
import { verifyPubSubToken } from "@/lib/pubsub-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Pub/Sub push endpoint for Gmail notifications. OIDC-verified; a notification only triggers a fetch from Gmail. */
export async function POST(request: NextRequest) {
  const e = env();
  const status = await handlePush(
    { authorization: request.headers.get("authorization"), body: await request.text() },
    { audience: e.PUBSUB_PUSH_AUDIENCE, serviceAccount: e.PUBSUB_PUSH_SERVICE_ACCOUNT },
    {
      db: db(),
      verify: (authorization, config) => verifyPubSubToken(authorization, config),
      schedule: (accountId) =>
        after(async () => {
          await syncAfterPush(defaultSyncDeps(), accountId).catch((err) =>
            console.error("push-triggered sync failed", { accountId, name: err instanceof Error ? err.name : "unknown" }),
          );
        }),
    },
  );
  return new Response(null, { status });
}
