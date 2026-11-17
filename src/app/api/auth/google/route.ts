import { authorizationUrl } from "@/lib/google";
import { beginOAuth } from "@/lib/oauth-state";
import { NextResponse } from "next/server";

export async function GET() {
  const { state, codeVerifier } = await beginOAuth("login");
  return NextResponse.redirect(authorizationUrl("login", state, codeVerifier));
}
