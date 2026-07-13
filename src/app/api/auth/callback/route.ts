import { NextResponse } from "next/server";

import { getDb, schema } from "@/lib/db";
import { requireEnv } from "@/lib/env";
import {
  type AccountRef,
  syncInstallationsFromGithub,
} from "@/lib/github/installation-sync";
import { oauthCallbackUrl, OAUTH_STATE_COOKIE, publicOrigin } from "@/lib/oauth";
import { type GithubAccountMembership, reconcileOrgMemberships } from "@/lib/org-sync";
import { createSession, SESSION_COOKIE, SESSION_TTL_SECONDS } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface GithubUser {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatar_url: string | null;
}

interface GithubOrgMembership {
  role?: string;
  state?: string;
  organization?: { id?: number; login?: string };
}

/**
 * Page through GET /user/memberships/orgs, which returns the authenticated
 * user's org memberships WITH role (admin/member) and paginates via the Link
 * rel="next" header. Returns the complete list, or null if any page fails. The
 * callback rejects sign-in on null rather than reconciling from a truncated set
 * that could silently hide or revoke accounts.
 */
async function fetchAllOrgMemberships(
  headers: Record<string, string>,
): Promise<GithubOrgMembership[] | null> {
  const memberships: GithubOrgMembership[] = [];
  // Active memberships only: a pending invite is not a membership yet.
  let next: string | null = "https://api.github.com/user/memberships/orgs?per_page=100&state=active";
  // Bound the loop defensively against a malformed Link header cycle.
  for (let page = 0; next && page < 100; page++) {
    const res: Response = await fetch(next, { headers });
    if (!res.ok) return null;
    const batch = (await res.json()) as GithubOrgMembership[];
    memberships.push(...batch);
    next = nextPageUrl(res.headers.get("link"));
  }
  return memberships;
}

/** Extract the rel="next" URL from a GitHub Link header, or null when absent. */
function nextPageUrl(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part.trim());
    if (m) return m[1]!;
  }
  return null;
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
  const origin = publicOrigin(request);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expectedState = getCookie(request, OAUTH_STATE_COOKIE);
  if (!code || !state || !expectedState || state !== expectedState) {
    return NextResponse.redirect(new URL("/login?error=oauth_state", origin));
  }

  // Exchange the code for a user access token.
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: requireEnv("GITHUB_OAUTH_CLIENT_ID"),
      client_secret: requireEnv("GITHUB_OAUTH_CLIENT_SECRET"),
      code,
      redirect_uri: oauthCallbackUrl(request),
    }),
  });
  if (!tokenRes.ok) {
    return NextResponse.redirect(new URL("/login?error=token_exchange", origin));
  }
  const tokenData = (await tokenRes.json()) as { access_token?: string };
  const accessToken = tokenData.access_token;
  if (!accessToken) {
    return NextResponse.redirect(new URL("/login?error=token_exchange", origin));
  }

  const ghHeaders = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "postil-control-plane",
  };
  const userRes = await fetch("https://api.github.com/user", { headers: ghHeaders });
  if (!userRes.ok) {
    return NextResponse.redirect(new URL("/login?error=profile", origin));
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
    return NextResponse.redirect(new URL("/login?error=profile", origin));
  }

  // Map the user onto organizations we know about: their GitHub orgs plus
  // their personal account (user-scoped installations). This is the full,
  // current set of accounts the user belongs to on GitHub; reconciliation
  // below both grants new memberships and revokes ones they have lost, and
  // records the real per-org role so write actions can gate on it.
  //
  // /user/memberships/orgs carries the caller's role (admin/member) per org
  // and paginates. Reconciliation requires the full list: on any page failure
  // we cannot tell "left every org" from a temporary GitHub failure or a
  // truncated page. Sign-in fails with a retryable error instead of creating a
  // session from stale or incomplete account access.
  const memberships = await fetchAllOrgMemberships(ghHeaders);
  if (!memberships) {
    const response = NextResponse.redirect(
      new URL("/login?error=organization_memberships", origin),
    );
    response.cookies.delete(OAUTH_STATE_COOKIE);
    return response;
  }

  // Bring installation rows in line with GitHub before linking memberships:
  // an installation that predates this database (or whose webhooks were
  // missed) would otherwise never materialize as an organization, and the
  // dashboard would greet an installed, signed-in user with "no
  // organizations". Best-effort by design; login never fails on it.
  const syncAccounts: AccountRef[] = [
    { githubId: ghUser.id, login: ghUser.login, type: "User" },
  ];
  for (const m of memberships) {
    const org = m.organization;
    if (typeof org?.id === "number" && typeof org.login === "string") {
      syncAccounts.push({ githubId: org.id, login: org.login, type: "Organization" });
    }
  }
  await syncInstallationsFromGithub(syncAccounts);

  // The user owns their personal account; user-scoped installations are
  // always administered by the account holder.
  const accounts: GithubAccountMembership[] = [{ githubOrgId: ghUser.id, role: "admin" }];
  for (const m of memberships) {
    const orgId = m.organization?.id;
    if (typeof orgId !== "number") continue;
    // GitHub reports "admin" or "member"; keep it verbatim and default any
    // unexpected value to the least-privileged role.
    accounts.push({ githubOrgId: orgId, role: m.role === "admin" ? "admin" : "member" });
  }
  await reconcileOrgMemberships(db, userId, accounts);

  const sessionToken = await createSession(userId);
  const response = NextResponse.redirect(new URL("/reports", origin));
  response.cookies.set(SESSION_COOKIE, sessionToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_TTL_SECONDS,
    path: "/",
  });
  response.cookies.delete(OAUTH_STATE_COOKIE);
  return response;
}
