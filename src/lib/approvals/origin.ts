/**
 * CSRF guard for the approval Server Actions (plan §6). Next.js rejects a Server Action whose
 * `Origin` host differs from the app's host, but lets a request with no `Origin` header through
 * with a warning (bundled docs: 01-app/03-api-reference/05-config/01-next-config-js/serverActions.md,
 * "allowedOrigins"). So every approval action also requires `Origin` to be present and equal to
 * APP_URL's origin. Import-free.
 */
export function isAllowedOrigin(origin: string | null, appUrl: string): boolean {
  if (!origin || origin === "null") return false;
  let expected: string;
  let actual: string;
  try {
    expected = new URL(appUrl).origin;
    actual = new URL(origin).origin;
  } catch {
    return false;
  }
  return actual === expected && origin.replace(/\/+$/, "") === expected;
}

export class ForbiddenOriginError extends Error {
  constructor() {
    super("Request origin not allowed");
    this.name = "ForbiddenOriginError";
  }
}
