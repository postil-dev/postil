import { NextResponse } from "next/server";

import { getDb, schema } from "@/lib/db";
import { requireEnv } from "@/lib/env";
import {
  type AccountRef,
  findAccessibleInstallationOrgSlug,
  syncInstallationsFromGithub,
} from "@/lib/github/installation-sync";
import {
  GITHUB_SETUP_INSTALLATION_COOKIE,
  oauthCallbackUrl,
  OAUTH_RETURN_TO_COOKIE,
  OAUTH_STATE_COOKIE,
  publicOrigin,
  safeReturnTarget,
} from "@/lib/oauth";
import {
  createSession,
  refreshUserMembershipsForOAuth,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
} from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface GithubUser {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatar_url: string | null;
}

const GITHUB_OAUTH_REQUEST_TIMEOUT_MS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function accessTokenFrom(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.access_token !== "string") return undefined;
  return value.access_token.length > 0 ? value.access_token : undefined;
}

function githubUserFrom(value: unknown): GithubUser | undefined {
  if (!isRecord(value)) return undefined;
  const nullableString = (candidate: unknown) =>
    candidate === null || typeof candidate === "string";
  if (
    !Number.isSafeInteger(value.id) ||
    Number(value.id) <= 0 ||
    typeof value.login !== "string" ||
    value.login.length === 0 ||
    !nullableString(value.name) ||
    !nullableString(value.email) ||
    !nullableString(value.avatar_url)
  ) {
    return undefined;
  }
  return {
    id: Number(value.id),
    login: value.login,
    name: value.name as string | null,
    email: value.email as string | null,
    avatar_url: value.avatar_url as string | null,
  };
}

async function fetchGithubOAuthJson(
  input: string,
  init: RequestInit,
): Promise<{ response: Response; data: unknown }> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    GITHUB_OAUTH_REQUEST_TIMEOUT_MS,
  );
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    const data = response.ok ? await response.json() : undefined;
    return { response, data };
  } finally {
    clearTimeout(timeout);
  }
}

function getCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

function loginErrorUrl(request: Request, error: string): URL {
  const url = new URL("/login", publicOrigin(request));
  url.searchParams.set("error", error);
  const returnTo = safeReturnTarget(getCookie(request, OAUTH_RETURN_TO_COOKIE));
  if (returnTo) url.searchParams.set("next", returnTo);
  return url;
}

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const origin = publicOrigin(request);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expectedState = getCookie(request, OAUTH_STATE_COOKIE);
  if (!code || !state || !expectedState || state !== expectedState) {
    return NextResponse.redirect(loginErrorUrl(request, "oauth_state"));
  }

  // Exchange the code for a user access token.
  let tokenRes: Response;
  let tokenData: unknown;
  try {
    ({ response: tokenRes, data: tokenData } = await fetchGithubOAuthJson(
      "https://github.com/login/oauth/access_token",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          client_id: requireEnv("GITHUB_OAUTH_CLIENT_ID"),
          client_secret: requireEnv("GITHUB_OAUTH_CLIENT_SECRET"),
          code,
          redirect_uri: oauthCallbackUrl(request),
        }),
      },
    ));
  } catch {
    return NextResponse.redirect(loginErrorUrl(request, "token_exchange"));
  }
  if (!tokenRes.ok) {
    return NextResponse.redirect(loginErrorUrl(request, "token_exchange"));
  }
  const accessToken = accessTokenFrom(tokenData);
  if (!accessToken) {
    return NextResponse.redirect(loginErrorUrl(request, "token_exchange"));
  }

  const ghHeaders = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "postil-control-plane",
  };
  let userRes: Response;
  let userData: unknown;
  try {
    ({ response: userRes, data: userData } = await fetchGithubOAuthJson(
      "https://api.github.com/user",
      { headers: ghHeaders },
    ));
  } catch {
    return NextResponse.redirect(loginErrorUrl(request, "profile"));
  }
  if (!userRes.ok) {
    return NextResponse.redirect(loginErrorUrl(request, "profile"));
  }
  const ghUser = githubUserFrom(userData);
  if (!ghUser) {
    return NextResponse.redirect(loginErrorUrl(request, "profile"));
  }

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
    return NextResponse.redirect(loginErrorUrl(request, "profile"));
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
  const membershipResult = await refreshUserMembershipsForOAuth({
    userId,
    githubId: ghUser.id,
    accessToken,
    onFetchedMemberships: async (memberships) => {
      // Synchronize installation rows before membership reconciliation so every
      // installed account can materialize as an organization. This repair is
      // best effort inside the installation synchronizer.
      const syncAccounts: AccountRef[] = [
        { githubId: ghUser.id, login: ghUser.login, type: "User" },
      ];
      for (const membership of memberships) {
        const org = membership.organization;
        if (typeof org?.id === "number" && typeof org.login === "string") {
          syncAccounts.push({
            githubId: org.id,
            login: org.login,
            type: "Organization",
          });
        }
      }
      await syncInstallationsFromGithub(syncAccounts, ghUser.id);
    },
  });
  if (!membershipResult.ok) {
    const response = NextResponse.redirect(
      loginErrorUrl(request, "organization_memberships"),
    );
    response.cookies.delete(OAUTH_STATE_COOKIE);
    return response;
  }
  const returnTo = safeReturnTarget(getCookie(request, OAUTH_RETURN_TO_COOKIE));
  const setupOrgSlug = returnTo
    ? undefined
    : await findAccessibleInstallationOrgSlug(
        userId,
        getCookie(request, GITHUB_SETUP_INSTALLATION_COOKIE),
      );
  const destination =
    returnTo ?? (setupOrgSlug ? `/orgs/${encodeURIComponent(setupOrgSlug)}` : "/reports");
  const sessionToken = await createSession(
    userId,
    accessToken,
    membershipResult.checkedAt,
  );
  const response = NextResponse.redirect(new URL(destination, origin));
  response.cookies.set(SESSION_COOKIE, sessionToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_TTL_SECONDS,
    path: "/",
  });
  response.cookies.delete(OAUTH_STATE_COOKIE);
  response.cookies.delete(OAUTH_RETURN_TO_COOKIE);
  response.cookies.delete(GITHUB_SETUP_INSTALLATION_COOKIE);
  return response;
}
