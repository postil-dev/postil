import { randomBytes } from "node:crypto";

import { and, eq, gt, isNull, lt, or } from "drizzle-orm";
import { cookies } from "next/headers";

import { getDb, schema } from "@/lib/db";
import { getSealingKey, seal, unseal } from "@/lib/crypto/seal";
import { requireEnv } from "@/lib/env";
import { fetchAllActiveOrgMemberships } from "@/lib/github/user-memberships";
import { reconcileOrgMemberships } from "@/lib/org-sync";
import {
  SESSION_COOKIE,
  signSessionToken,
  verifySessionToken,
} from "@/lib/session-token";

// Session lifetime is shared by the server-side row and browser cookie.
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const SESSION_TTL_MS = SESSION_TTL_SECONDS * 1000;
export const MEMBERSHIP_RECHECK_INTERVAL_MS = 15 * 60 * 1000;
const MEMBERSHIP_CHECK_LEASE_MS = 60 * 1000;
const MEMBERSHIP_CHECK_WAIT_MS = 100;
const MEMBERSHIP_CHECK_WAIT_ATTEMPTS = 20;

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
  | { ok: false; reason: "unauthenticated" | "verification_unavailable" };

interface SessionIdentity {
  sessionId: string;
  user: SessionUser;
  githubAccessTokenCiphertext: Buffer | null;
  membershipCheckedAt: Date | null;
}

class MembershipLeaseLostError extends Error {}

export async function createSession(
  userId: number,
  githubAccessToken: string,
  membershipCheckedAt: Date,
): Promise<string> {
  const db = getDb();
  const id = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const githubAccessTokenCiphertext = seal(githubAccessToken, getSealingKey());
  await db.insert(schema.sessions).values({
    id,
    userId,
    expiresAt,
    githubAccessTokenCiphertext,
    membershipCheckedAt,
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

  if (isMembershipFresh(identity.membershipCheckedAt)) {
    return { ok: true, user: identity.user };
  }
  if (!identity.githubAccessTokenCiphertext) {
    await getDb().delete(schema.sessions).where(eq(schema.sessions.id, identity.sessionId));
    return { ok: false, reason: "unauthenticated" };
  }

  const leaseAvailableAt = await claimMembershipCheck(identity.sessionId);
  if (!leaseAvailableAt) {
    const completed = await waitForMembershipCheck(identity.sessionId);
    if (completed === "fresh") return { ok: true, user: identity.user };
    return {
      ok: false,
      reason: completed === "missing" ? "unauthenticated" : "verification_unavailable",
    };
  }

  let accessToken: string;
  try {
    accessToken = unseal(identity.githubAccessTokenCiphertext, getSealingKey());
  } catch {
    await getDb().delete(schema.sessions).where(eq(schema.sessions.id, identity.sessionId));
    return { ok: false, reason: "unauthenticated" };
  }

  const result = await fetchAllActiveOrgMemberships(accessToken);
  if (!result.ok) {
    if (result.reason === "unauthorized") {
      await getDb().delete(schema.sessions).where(eq(schema.sessions.id, identity.sessionId));
      return { ok: false, reason: "unauthenticated" };
    }
    await deferMembershipCheck(
      identity.sessionId,
      leaseAvailableAt,
      result.retryAfterMs,
    );
    return { ok: false, reason: "verification_unavailable" };
  }

  const accounts = [
    { githubOrgId: identity.user.githubId, role: "admin" },
    ...result.memberships.flatMap((membership) => {
      const orgId = membership.organization?.id;
      if (typeof orgId !== "number") return [];
      return [{ githubOrgId: orgId, role: membership.role === "admin" ? "admin" : "member" }];
    }),
  ];

  try {
    const db = getDb();
    await db.transaction(async (tx) => {
      const completed = await tx
        .update(schema.sessions)
        .set({ membershipCheckedAt: new Date(), membershipCheckAvailableAt: null })
        .where(
          and(
            eq(schema.sessions.id, identity.sessionId),
            eq(schema.sessions.membershipCheckAvailableAt, leaseAvailableAt),
            gt(schema.sessions.expiresAt, new Date()),
          ),
        )
        .returning({ id: schema.sessions.id });
      if (completed.length !== 1) throw new MembershipLeaseLostError();
      await reconcileOrgMemberships(tx, identity.user.id, accounts);
    });
  } catch (error) {
    if (error instanceof MembershipLeaseLostError) {
      return { ok: false, reason: "unauthenticated" };
    }
    await deferMembershipCheck(identity.sessionId, leaseAvailableAt);
    return { ok: false, reason: "verification_unavailable" };
  }

  return { ok: true, user: identity.user };
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
      membershipCheckedAt: schema.sessions.membershipCheckedAt,
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

function isMembershipFresh(checkedAt: Date | null, now = Date.now()): boolean {
  return checkedAt !== null && checkedAt.getTime() > now - MEMBERSHIP_RECHECK_INTERVAL_MS;
}

async function claimMembershipCheck(sessionId: string): Promise<Date | null> {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - MEMBERSHIP_RECHECK_INTERVAL_MS);
  const availableAt = new Date(now.getTime() + MEMBERSHIP_CHECK_LEASE_MS);
  const rows = await getDb()
    .update(schema.sessions)
    .set({ membershipCheckAvailableAt: availableAt })
    .where(
      and(
        eq(schema.sessions.id, sessionId),
        gt(schema.sessions.expiresAt, now),
        or(
          isNull(schema.sessions.membershipCheckedAt),
          lt(schema.sessions.membershipCheckedAt, staleBefore),
        ),
        or(
          isNull(schema.sessions.membershipCheckAvailableAt),
          lt(schema.sessions.membershipCheckAvailableAt, now),
        ),
      ),
    )
    .returning({ availableAt: schema.sessions.membershipCheckAvailableAt });
  return rows[0]?.availableAt ?? null;
}

async function waitForMembershipCheck(
  sessionId: string,
): Promise<"fresh" | "pending" | "missing"> {
  for (let attempt = 0; attempt < MEMBERSHIP_CHECK_WAIT_ATTEMPTS; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, MEMBERSHIP_CHECK_WAIT_MS));
    const row = (
      await getDb()
        .select({ membershipCheckedAt: schema.sessions.membershipCheckedAt })
        .from(schema.sessions)
        .where(
          and(
            eq(schema.sessions.id, sessionId),
            gt(schema.sessions.expiresAt, new Date()),
          ),
        )
        .limit(1)
    )[0];
    if (!row) return "missing";
    if (isMembershipFresh(row.membershipCheckedAt)) return "fresh";
  }
  return "pending";
}

async function deferMembershipCheck(
  sessionId: string,
  leaseAvailableAt: Date,
  retryAfterMs = MEMBERSHIP_CHECK_LEASE_MS,
): Promise<void> {
  const retryAt = new Date(Date.now() + retryAfterMs);
  await getDb()
    .update(schema.sessions)
    .set({ membershipCheckAvailableAt: retryAt })
    .where(
      and(
        eq(schema.sessions.id, sessionId),
        eq(schema.sessions.membershipCheckAvailableAt, leaseAvailableAt),
      ),
    );
}

export { SESSION_COOKIE };
