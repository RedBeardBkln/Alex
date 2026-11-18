import { generateCodeVerifier, generateState } from "arctic";
import { cookies } from "next/headers";
import { z } from "zod";
import { isProduction } from "@/lib/env";
import type { OAuthFlow } from "@/lib/google";

const COOKIE = "alex_oauth";

const stateSchema = z.object({
  flow: z.enum(["login", "connect"]),
  state: z.string(),
  codeVerifier: z.string(),
  label: z.enum(["personal", "business"]).optional(),
});

export type OAuthState = z.infer<typeof stateSchema>;

/** Starts an OAuth round trip: state + PKCE verifier live in a short-lived httpOnly cookie. */
export async function beginOAuth(flow: OAuthFlow, label?: "personal" | "business"): Promise<OAuthState> {
  const value: OAuthState = { flow, state: generateState(), codeVerifier: generateCodeVerifier(), label };
  (await cookies()).set(COOKIE, JSON.stringify(value), {
    httpOnly: true,
    secure: isProduction(),
    sameSite: "lax",
    path: "/api",
    maxAge: 10 * 60,
  });
  return value;
}

/** Validates the callback's state against the cookie and clears it. Returns null on any mismatch. */
export async function finishOAuth(flow: OAuthFlow, returnedState: string | null): Promise<OAuthState | null> {
  const store = await cookies();
  const raw = store.get(COOKIE)?.value;
  store.delete({ name: COOKIE, path: "/api" });
  if (!raw || !returnedState) return null;
  let parsed: OAuthState;
  try {
    parsed = stateSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
  return parsed.flow === flow && parsed.state === returnedState ? parsed : null;
}
