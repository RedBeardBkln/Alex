import { NextResponse } from "next/server";
import { env } from "@/lib/env";

/** Redirect to an app path, always on APP_URL (never to a caller-supplied host). */
export function redirectTo(path: string, params?: Record<string, string>): NextResponse {
  const url = new URL(path, env().APP_URL);
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);
  return NextResponse.redirect(url, { status: 303 });
}
