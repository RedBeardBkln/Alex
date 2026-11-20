import { createHash, timingSafeEqual } from "node:crypto";

/** CRON_SECRET must be letters and digits, at least 16 characters; anything else fails closed. */
export const CRON_SECRET_PATTERN = /^[A-Za-z0-9]{16,}$/;

function digest(s: string): Buffer {
  return createHash("sha256").update(s, "utf8").digest();
}

/**
 * Checks the `Authorization: Bearer <CRON_SECRET>` header Vercel Cron sends. Returns false when the
 * secret is unset or malformed, so cron endpoints are closed until it is configured.
 */
export function isAuthorizedCron(authorization: string | null, secret: string | undefined): boolean {
  if (!secret || !CRON_SECRET_PATTERN.test(secret)) return false;
  if (!authorization) return false;
  // Compare fixed-length digests so neither the length nor the content leaks through timing.
  return timingSafeEqual(digest(authorization), digest(`Bearer ${secret}`));
}
