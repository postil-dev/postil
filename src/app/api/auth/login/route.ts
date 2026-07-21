import { randomBytes } from "node:crypto";

import { NextResponse } from "next/server";

import { requireEnv } from "@/lib/env";
import {
  oauthCallbackUrl,
  OAUTH_RETURN_TO_COOKIE,
  OAUTH_STATE_COOKIE,
  safeReturnTarget,
} from "@/lib/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const clientId = requireEnv("GITHUB_OAUTH_CLIENT_ID");
  const state = randomBytes(16).toString("hex");
  const returnTo = safeReturnTarget(new URL(request.url).searchParams.get("next"));

  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", oauthCallbackUrl(request));
  authorize.searchParams.set("scope", "read:user user:email read:org");
  authorize.searchParams.set("state", state);

  const response = NextResponse.redirect(authorize);
  response.cookies.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 600,
    path: "/",
  });
  if (returnTo) {
    response.cookies.set(OAUTH_RETURN_TO_COOKIE, returnTo, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 600,
      path: "/",
    });
  } else {
    response.cookies.delete(OAUTH_RETURN_TO_COOKIE);
  }
  return response;
}
