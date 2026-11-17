import { asc } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { db, schema } from "@/db";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { googleClient, identityFromTokens, isAllowedEmail } from "@/lib/google";
import { redirectTo } from "@/lib/http";
import { finishOAuth } from "@/lib/oauth-state";
import { createSession } from "@/lib/session";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const pending = await finishOAuth("login", params.get("state"));
  if (params.get("error")) return redirectTo("/login", { error: "cancelled" });
  const code = params.get("code");
  if (!pending || !code) return redirectTo("/login", { error: "state" });

  let identity;
  try {
    const tokens = await googleClient("login").validateAuthorizationCode(code, pending.codeVerifier);
    identity = identityFromTokens(tokens);
  } catch (err) {
    console.error("Login token exchange failed", err);
    return redirectTo("/login", { error: "google" });
  }

  if (!isAllowedEmail(identity.email, env().ALEX_ALLOWED_EMAILS)) {
    await audit({ userId: null, action: "login.denied", detail: { email: identity.email } });
    return redirectTo("/login", { error: "not_allowed" });
  }

  // Single-owner app: every allowed email signs in as the one owner record.
  const database = db();
  let [owner] = await database.select().from(schema.users).orderBy(asc(schema.users.createdAt)).limit(1);
  if (!owner) {
    [owner] = await database.insert(schema.users).values({ email: identity.email, name: identity.name }).returning();
  }
  if (!owner) throw new Error("Could not create owner user");

  await createSession(owner.id);
  await audit({ userId: owner.id, action: "login", detail: { email: identity.email } });
  return redirectTo("/");
}
