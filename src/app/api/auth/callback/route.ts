import { NextResponse } from "next/server";

import { getDb, schema } from "@/lib/db";
import { requireEnv } from "@/lib/env";
import { OAUTH_STATE_COOKIE } from "@/lib/oauth";
import { type GithubAccountMembership, reconcileOrgMemberships } from "@/lib/org-sync";
import { createSession, SESSION_COOKIE } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface GithubUser {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatar_url: string | null;
}

interface GithubOrg {
  id: number;
  login: string;
}

function getCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expectedState = getCookie(request, OAUTH_STATE_COOKIE);
  if (!code || !state || !expectedState || state !== expectedState) {
    return NextResponse.redirect(new URL("/login?error=oauth_state", url.origin));
  }

  // Exchange the code for a user access token.
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: requireEnv("GITHUB_OAUTH_CLIENT_ID"),
      client_secret: requireEnv("GITHUB_OAUTH_CLIENT_SECRET"),
      code,
      redirect_uri: `${url.origin}/api/auth/callback`,
    }),
  });
  if (!tokenRes.ok) {
    return NextResponse.redirect(new URL("/login?error=token_exchange", url.origin));
  }
  const tokenData = (await tokenRes.json()) as { access_token?: string };
  const accessToken = tokenData.access_token;
  if (!accessToken) {
    return NextResponse.redirect(new URL("/login?error=token_exchange", url.origin));
  }

  const ghHeaders = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "postil-control-plane",
  };
  const userRes = await fetch("https://api.github.com/user", { headers: ghHeaders });
  if (!userRes.ok) {
    return NextResponse.redirect(new URL("/login?error=profile", url.origin));
  }
  const ghUser = (await userRes.json()) as GithubUser;

  const db = getDb();
  const upserted = await db
    .insert(schema.users)
    .values({
      githubId: ghUser.id,
      login: ghUser.login,
      name: ghUser.name,
      email: ghUser.email,
      avatarUrl: ghUser.avatar_url,
    })
    .onConflictDoUpdate({
      target: schema.users.githubId,
      set: {
        login: ghUser.login,
        name: ghUser.name,
        email: ghUser.email,
        avatarUrl: ghUser.avatar_url,
      },
    })
    .returning({ id: schema.users.id });
  const userId = upserted[0]?.id;
  if (userId === undefined) {
    return NextResponse.redirect(new URL("/login?error=profile", url.origin));
  }

  // Map the user onto organizations we know about: their GitHub orgs plus
  // their personal account (user-scoped installations). This is the full,
  // current set of accounts the user belongs to on GitHub; reconciliation
  // below both grants new memberships and revokes ones they have lost.
  //
  // Only reconcile org membership when GitHub returns the org list. If
  // /user/orgs fails we cannot tell "left every org" from "GitHub blipped",
  // so we keep the user's last-known memberships rather than revoke them all.
  const orgsRes = await fetch("https://api.github.com/user/orgs", { headers: ghHeaders });
  if (orgsRes.ok) {
    const accounts: GithubAccountMembership[] = [{ githubOrgId: ghUser.id, role: "admin" }];
    const orgs = (await orgsRes.json()) as GithubOrg[];
    for (const org of orgs) accounts.push({ githubOrgId: org.id, role: "member" });
    await reconcileOrgMemberships(db, userId, accounts);
  }

  const sessionToken = await createSession(userId);
  const response = NextResponse.redirect(new URL("/reports", url.origin));
  response.cookies.set(SESSION_COOKIE, sessionToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 30 * 24 * 60 * 60,
    path: "/",
  });
  response.cookies.delete(OAUTH_STATE_COOKIE);
  return response;
}
