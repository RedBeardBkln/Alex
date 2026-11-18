import type { NextRequest } from "next/server";
import { authorizationUrl } from "@/lib/google";
import { redirectTo } from "@/lib/http";
import { beginOAuth } from "@/lib/oauth-state";
import { currentUser } from "@/lib/session";
import { NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  if (!(await currentUser())) return redirectTo("/login");
  const label = request.nextUrl.searchParams.get("label") === "business" ? "business" : "personal";
  const { state, codeVerifier } = await beginOAuth("connect", label);
  return NextResponse.redirect(authorizationUrl("connect", state, codeVerifier));
}
