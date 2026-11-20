import { headers } from "next/headers";
import { ForbiddenOriginError, isAllowedOrigin } from "@/lib/approvals/origin";
import { env } from "@/lib/env";
import { requireUser } from "@/lib/session";

/**
 * Sign-in plus the strict Origin check for Server Actions outside the queue (Phase 2c's AI
 * actions), the same rule as the queue actions' guard: Next.js lets a Server Action with no
 * Origin header through, so it must be present and equal to APP_URL's origin.
 */
export async function requireActionUser() {
  const user = await requireUser();
  if (!isAllowedOrigin((await headers()).get("origin"), env().APP_URL)) throw new ForbiddenOriginError();
  return user;
}
