import { randomBytes } from "node:crypto";

import { and, eq, gt, sql } from "drizzle-orm";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

import {
  boundedMembershipRetryAvailableAt,
  MEMBERSHIP_RETRY_FALLBACK_MS,
  MembershipVerificationUnavailableError,
  PROTECTED_RETURN_TO_HEADER,
} from "@/lib/auth-navigation";
import { getDb, schema } from "@/lib/db";
import { getSealingKey, seal, unseal } from "@/lib/crypto/seal";
import { requireEnv } from "@/lib/env";
import {
  fetchAllActiveOrgMemberships,
  type GithubOrgMembership,
} from "@/lib/github/user-memberships";
import {
  claimUserMembershipRefresh,
  completeUserMembershipRefresh,
  deferUserMembershipRefresh,
  isUserMembershipFresh,
  markGenerationFencedMembershipWriter,
  MEMBERSHIP_RECHECK_INTERVAL_MS,
  MEMBERSHIP_REFRESH_WAIT_TIMEOUT_MS,
  type MembershipRefreshAuthority,
  releaseUserMembershipRefresh,
  waitForUserMembershipRefresh,
} from "@/lib/membership-authority";
import { safeReturnTarget } from "@/lib/oauth";
import { reconcileOrgMemberships } from "@/lib/org-sync";
import {
  SESSION_COOKIE,
  signSessionToken,
  verifySessionToken,
} from "@/lib/session-token";

// Session lifetime is shared by the server-side row and browser cookie.
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const SESSION_TTL_MS = SESSION_TTL_SECONDS * 1000;
const MEMBERSHIP_REFRESH_FAILURE_BACKOFF_MS = 60 * 1000;

export interface SessionUser {
  id: number;
  githubId: number;
  login: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
}

export type VerifiedSessionResult =
  | { ok: true; user: SessionUser }
  | MembershipFailureResult;

export type MembershipFailureResult =
  | { ok: false; reason: "unauthenticated" }
  | {
      ok: false;
      reason: "verification_unavailable";
      retryAvailableAt: Date;
    };

interface SessionIdentity {
  sessionId: string;
  user: SessionUser;
  githubAccessTokenCiphertext: Buffer | null;
  membershipCheckedAt: Date | null;
}

class MembershipLeaseLostError extends Error {}
class SessionExpiredDuringRefreshError extends Error {}

interface UserMembershipRefreshInput {
  userId: number;
  githubId: number;
  accessToken: string;
  force: boolean;
  sessionId?: string;
  onFetchedMemberships?: (
    memberships: GithubOrgMembership[],
  ) => Promise<void>;
}

type UserMembershipRefreshResult =
  | { ok: true; checkedAt: Date }
  | MembershipFailureResult;

export async function createSession(
  userId: number,
  githubAccessToken: string,
  membershipCheckedAt: Date,
): Promise<string> {
  const db = getDb();
  const id = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const githubAccessTokenCiphertext = seal(githubAccessToken, getSealingKey());
  await db.transaction(async (tx) => {
    await markGenerationFencedMembershipWriter(tx);
    await tx
      .update(schema.users)
      .set({
        membershipCheckedAt: sql`GREATEST(COALESCE(${schema.users.membershipCheckedAt}, ${membershipCheckedAt}), ${membershipCheckedAt})`,
      })
      .where(eq(schema.users.id, userId));
    await tx.insert(schema.sessions).values({
      id,
      userId,
      expiresAt,
      githubAccessTokenCiphertext,
      membershipCheckedAt,
    });
  });
  return signSessionToken(id, requireEnv("POSTIL_SESSION_SECRET"));
}

export async function destroySessionByToken(token: string | undefined): Promise<void> {
  const sessionId = await verifySessionToken(token, requireEnv("POSTIL_SESSION_SECRET"));
  if (!sessionId) return;
  await getDb().delete(schema.sessions).where(eq(schema.sessions.id, sessionId));
}

/** Resolve the current request's user, or null when not signed in. */
export async function getSessionUser(): Promise<SessionUser | null> {
  return (await getSessionIdentity())?.user ?? null;
}

/** Resolve a session after refreshing its GitHub organization memberships when stale. */
export async function getVerifiedSessionUser(): Promise<VerifiedSessionResult> {
  const identity = await getSessionIdentity();
  if (!identity) return { ok: false, reason: "unauthenticated" };

  if (isUserMembershipFresh(identity.membershipCheckedAt)) {
    return { ok: true, user: identity.user };
  }
  if (!identity.githubAccessTokenCiphertext) {
    await getDb().delete(schema.sessions).where(eq(schema.sessions.id, identity.sessionId));
    return { ok: false, reason: "unauthenticated" };
  }

  let accessToken: string;
  try {
    accessToken = unseal(identity.githubAccessTokenCiphertext, getSealingKey());
  } catch {
    await getDb().delete(schema.sessions).where(eq(schema.sessions.id, identity.sessionId));
    return { ok: false, reason: "unauthenticated" };
  }

  const refreshed = await refreshUserMemberships({
    userId: identity.user.id,
    githubId: identity.user.githubId,
    accessToken,
    force: false,
    sessionId: identity.sessionId,
  });
  return refreshed.ok ? { ok: true, user: identity.user } : refreshed;
}

/** Reconcile an OAuth login through the same per-user authority as session refreshes. */
export async function refreshUserMembershipsForOAuth(input: {
  userId: number;
  githubId: number;
  accessToken: string;
  onFetchedMemberships: (memberships: GithubOrgMembership[]) => Promise<void>;
}): Promise<UserMembershipRefreshResult> {
  return refreshUserMemberships({ ...input, force: true });
}

/** Resolve a verified page session or invoke the matching App Router control flow. */
export async function requireVerifiedPageSessionUser(): Promise<SessionUser> {
  const verification = await getVerifiedSessionUser();
  if (!verification.ok) {
    return handlePageSessionFailure(
      verification.reason,
      verification.reason === "verification_unavailable"
        ? verification.retryAvailableAt
        : undefined,
    );
  }
  return verification.user;
}

/** Keep transient verification failures distinct from signed-out navigation. */
export async function handlePageSessionFailure(
  reason: "unauthenticated" | "verification_unavailable",
  retryAvailableAt?: Date,
): Promise<never> {
  if (reason === "verification_unavailable") {
    throw new MembershipVerificationUnavailableError(retryAvailableAt);
  }
  return redirectToLoginForCurrentProtectedRoute();
}

/** Redirect a signed-out page request while preserving its protected target. */
export async function redirectToLoginForCurrentProtectedRoute(): Promise<never> {
  const returnTo = safeReturnTarget(
    (await headers()).get(PROTECTED_RETURN_TO_HEADER),
  );
  redirect(returnTo ? `/login?next=${encodeURIComponent(returnTo)}` : "/login");
}

async function getSessionIdentity(): Promise<SessionIdentity | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  const sessionId = await verifySessionToken(token, requireEnv("POSTIL_SESSION_SECRET"));
  if (!sessionId) return null;
  const db = getDb();
  const rows = await db
    .select({
      sessionId: schema.sessions.id,
      id: schema.users.id,
      githubId: schema.users.githubId,
      login: schema.users.login,
      name: schema.users.name,
      email: schema.users.email,
      avatarUrl: schema.users.avatarUrl,
      githubAccessTokenCiphertext: schema.sessions.githubAccessTokenCiphertext,
      membershipCheckedAt: schema.users.membershipCheckedAt,
    })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(and(eq(schema.sessions.id, sessionId), gt(schema.sessions.expiresAt, new Date())))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    sessionId: row.sessionId,
    user: {
      id: row.id,
      githubId: row.githubId,
      login: row.login,
      name: row.name,
      email: row.email,
      avatarUrl: row.avatarUrl,
    },
    githubAccessTokenCiphertext: row.githubAccessTokenCiphertext,
    membershipCheckedAt: row.membershipCheckedAt,
  };
}

async function acceptSharedMembershipFreshness(
  input: UserMembershipRefreshInput,
  checkedAt: Date,
): Promise<UserMembershipRefreshResult> {
  if (!input.sessionId) return { ok: true, checkedAt };
  const activeSession = (
    await getDb()
      .select({ id: schema.sessions.id })
      .from(schema.sessions)
      .where(
        and(
          eq(schema.sessions.id, input.sessionId),
          eq(schema.sessions.userId, input.userId),
          gt(schema.sessions.expiresAt, new Date()),
        ),
      )
      .limit(1)
  )[0];
  return activeSession
    ? { ok: true, checkedAt }
    : { ok: false, reason: "unauthenticated" };
}

async function classifyMembershipLeaseLoss(
  input: UserMembershipRefreshInput,
): Promise<UserMembershipRefreshResult> {
  const db = getDb();
  const sharedState = input.sessionId
    ? (
        await db
          .select({
            membershipCheckedAt: schema.users.membershipCheckedAt,
            leaseUntil: schema.users.membershipRefreshLeaseUntil,
            retryAfter: schema.users.membershipRefreshRetryAfter,
          })
          .from(schema.sessions)
          .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
          .where(
            and(
              eq(schema.sessions.id, input.sessionId),
              eq(schema.sessions.userId, input.userId),
              gt(schema.sessions.expiresAt, new Date()),
            ),
          )
          .limit(1)
      )[0]
    : (
        await db
          .select({
            membershipCheckedAt: schema.users.membershipCheckedAt,
            leaseUntil: schema.users.membershipRefreshLeaseUntil,
            retryAfter: schema.users.membershipRefreshRetryAfter,
          })
          .from(schema.users)
          .where(eq(schema.users.id, input.userId))
          .limit(1)
      )[0];
  if (!sharedState) return { ok: false, reason: "unauthenticated" };
  if (isUserMembershipFresh(sharedState.membershipCheckedAt)) {
    return { ok: true, checkedAt: sharedState.membershipCheckedAt };
  }
  const now = Date.now();
  const retryAvailableAt = [sharedState.retryAfter, sharedState.leaseUntil]
    .filter((value): value is Date => value !== null && value.getTime() > now)
    .reduce<Date | undefined>(
      (latest, value) =>
        !latest || value.getTime() > latest.getTime() ? value : latest,
      undefined,
    );
  return membershipVerificationUnavailable(retryAvailableAt);
}

function membershipVerificationUnavailable(
  retryAvailableAt?: Date | number,
): MembershipFailureResult {
  return {
    ok: false,
    reason: "verification_unavailable",
    retryAvailableAt: boundedMembershipRetryAvailableAt(retryAvailableAt),
  };
}

async function refreshUserMemberships(
  input: UserMembershipRefreshInput,
): Promise<UserMembershipRefreshResult> {
  const db = getDb();
  let authority: MembershipRefreshAuthority;
  for (;;) {
    const claim = await claimUserMembershipRefresh(db, input.userId, input.force);
    if (claim.status === "missing") return { ok: false, reason: "unauthenticated" };
    if (claim.status === "fresh") {
      return acceptSharedMembershipFreshness(input, claim.checkedAt);
    }
    if (claim.status === "backoff") {
      return membershipVerificationUnavailable(claim.retryAvailableAt);
    }
    if (claim.status === "waiting") {
      const waited = await waitForUserMembershipRefresh(db, input.userId, input.force);
      if (waited.status === "fresh") {
        return acceptSharedMembershipFreshness(input, waited.checkedAt);
      }
      if (waited.status === "missing") return { ok: false, reason: "unauthenticated" };
      if (waited.status === "backoff" || waited.status === "pending") {
        return membershipVerificationUnavailable(waited.retryAvailableAt);
      }
      continue;
    }
    authority = claim.authority;
    break;
  }

  const checkedAt = new Date();
  const result = await fetchAllActiveOrgMemberships(input.accessToken);
  if (!result.ok) {
    if (result.reason === "unauthorized") {
      await releaseUserMembershipRefresh(db, input.userId, authority);
      if (input.sessionId) {
        await db.delete(schema.sessions).where(eq(schema.sessions.id, input.sessionId));
      }
      return { ok: false, reason: "unauthenticated" };
    }
    const deferral = await deferUserMembershipRefresh(
      db,
      input.userId,
      authority,
      result.retryAfterMs,
    );
    return deferral.status === "deferred"
      ? membershipVerificationUnavailable(deferral.retryAvailableAt)
      : classifyMembershipLeaseLoss(input);
  }

  try {
    await input.onFetchedMemberships?.(result.memberships);
    const accounts = [
      { githubOrgId: input.githubId, role: "admin" },
      ...result.memberships.flatMap((membership) => {
        const orgId = membership.organization?.id;
        if (typeof orgId !== "number") return [];
        return [
          {
            githubOrgId: orgId,
            role: membership.role === "admin" ? "admin" : "member",
          },
        ];
      }),
    ];

    await db.transaction(async (tx) => {
      await markGenerationFencedMembershipWriter(tx);
      if (input.sessionId) {
        const activeSession = (
          await tx
            .select({ id: schema.sessions.id })
            .from(schema.sessions)
            .where(
              and(
                eq(schema.sessions.id, input.sessionId),
                gt(schema.sessions.expiresAt, new Date()),
              ),
            )
            .limit(1)
        )[0];
        if (!activeSession) throw new SessionExpiredDuringRefreshError();
      }

      await reconcileOrgMemberships(tx, input.userId, accounts);
      await tx
        .update(schema.sessions)
        .set({ membershipCheckedAt: checkedAt, membershipCheckAvailableAt: null })
        .where(eq(schema.sessions.userId, input.userId));
      const completed = await completeUserMembershipRefresh(
        tx,
        input.userId,
        authority,
        checkedAt,
      );
      if (!completed) throw new MembershipLeaseLostError();
    });
  } catch (error) {
    if (error instanceof SessionExpiredDuringRefreshError) {
      await releaseUserMembershipRefresh(db, input.userId, authority);
      return { ok: false, reason: "unauthenticated" };
    }
    if (error instanceof MembershipLeaseLostError) {
      return classifyMembershipLeaseLoss(input);
    }
    const deferral = await deferUserMembershipRefresh(
      db,
      input.userId,
      authority,
      MEMBERSHIP_REFRESH_FAILURE_BACKOFF_MS,
    );
    return deferral.status === "deferred"
      ? membershipVerificationUnavailable(deferral.retryAvailableAt)
      : classifyMembershipLeaseLoss(input);
  }

  return { ok: true, checkedAt };
}

export {
  MEMBERSHIP_RECHECK_INTERVAL_MS,
  MEMBERSHIP_REFRESH_WAIT_TIMEOUT_MS as MEMBERSHIP_CHECK_WAIT_TIMEOUT_MS,
  MEMBERSHIP_RETRY_FALLBACK_MS,
  SESSION_COOKIE,
};
