import { and, eq, gt, isNull, lte, or, sql } from "drizzle-orm";

import { type Database, schema } from "@/lib/db";

export const MEMBERSHIP_RECHECK_INTERVAL_MS = 15 * 60 * 1000;
const MEMBERSHIP_REFRESH_LEASE_MS = 60 * 1000;
const MEMBERSHIP_REFRESH_WAIT_INITIAL_MS = 100;
const MEMBERSHIP_REFRESH_WAIT_MAX_MS = 2_000;
export const MEMBERSHIP_REFRESH_WAIT_TIMEOUT_MS = 35 * 1000;
export const MEMBERSHIP_REFRESH_RETRY_FALLBACK_MS = 5 * 1000;
const MEMBERSHIP_REFRESH_MAX_RETRY_MS = 60 * 60 * 1000;

type MembershipAuthorityDatabase = Pick<Database, "select" | "update">;
type MembershipWriterDatabase = Pick<Database, "execute">;

/** Mark current-process membership writes for rolling-deploy compatibility triggers. */
export async function markGenerationFencedMembershipWriter(
  db: MembershipWriterDatabase,
): Promise<void> {
  await db.execute(
    sql`SELECT set_config('postil.membership_writer', 'generation-fenced', true)`,
  );
}

export interface MembershipRefreshAuthority {
  generation: number;
  leaseUntil: Date;
}

export type MembershipRefreshClaim =
  | { status: "claimed"; authority: MembershipRefreshAuthority }
  | { status: "fresh"; checkedAt: Date }
  | { status: "backoff"; retryAvailableAt: Date }
  | { status: "waiting"; retryAvailableAt: Date }
  | { status: "missing" };

export type MembershipRefreshWaitResult =
  | { status: "available" }
  | { status: "fresh"; checkedAt: Date }
  | { status: "backoff"; retryAvailableAt: Date }
  | { status: "pending"; retryAvailableAt: Date }
  | { status: "missing" };

export type MembershipRefreshDisposition =
  | { status: "available" }
  | { status: "fresh"; checkedAt: Date }
  | { status: "backoff"; retryAvailableAt: Date }
  | { status: "waiting"; retryAvailableAt: Date };

export type MembershipRefreshDeferral =
  | { status: "deferred"; retryAvailableAt: Date }
  | { status: "lost" };

interface MembershipRefreshWaitScheduler {
  now: () => number;
  sleep: (delayMs: number) => Promise<void>;
}

export async function claimUserMembershipRefresh(
  db: MembershipAuthorityDatabase,
  userId: number,
  force: boolean,
): Promise<MembershipRefreshClaim> {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - MEMBERSHIP_RECHECK_INTERVAL_MS);
  const leaseUntil = new Date(now.getTime() + MEMBERSHIP_REFRESH_LEASE_MS);
  const freshnessCondition = force
    ? undefined
    : or(
        isNull(schema.users.membershipCheckedAt),
        lte(schema.users.membershipCheckedAt, staleBefore),
      );
  const rows = await db
    .update(schema.users)
    .set({
      membershipRefreshGeneration: sql`${schema.users.membershipRefreshGeneration} + 1`,
      membershipRefreshLeaseUntil: leaseUntil,
      membershipRefreshRetryAfter: null,
    })
    .where(
      and(
        eq(schema.users.id, userId),
        or(
          isNull(schema.users.membershipRefreshLeaseUntil),
          lte(schema.users.membershipRefreshLeaseUntil, now),
        ),
        or(
          isNull(schema.users.membershipRefreshRetryAfter),
          lte(schema.users.membershipRefreshRetryAfter, now),
        ),
        freshnessCondition,
      ),
    )
    .returning({
      generation: schema.users.membershipRefreshGeneration,
      leaseUntil: schema.users.membershipRefreshLeaseUntil,
    });
  const claimed = rows[0];
  if (claimed?.leaseUntil) {
    return {
      status: "claimed",
      authority: { generation: claimed.generation, leaseUntil: claimed.leaseUntil },
    };
  }
  const state = await inspectUserMembershipRefresh(db, userId, force);
  return state.status === "available"
    ? {
        status: "waiting",
        retryAvailableAt: new Date(
          Date.now() + MEMBERSHIP_REFRESH_RETRY_FALLBACK_MS,
        ),
      }
    : state;
}

export async function waitForUserMembershipRefresh(
  db: MembershipAuthorityDatabase,
  userId: number,
  force: boolean,
  scheduler: MembershipRefreshWaitScheduler = {
    now: Date.now,
    sleep: (delayMs) =>
      new Promise((resolve) => setTimeout(resolve, delayMs)),
  },
): Promise<MembershipRefreshWaitResult> {
  const deadline = scheduler.now() + MEMBERSHIP_REFRESH_WAIT_TIMEOUT_MS;
  let pendingRetryAvailableAt: Date | undefined;
  let waitMs = MEMBERSHIP_REFRESH_WAIT_INITIAL_MS;
  while (scheduler.now() < deadline) {
    await scheduler.sleep(Math.min(waitMs, deadline - scheduler.now()));
    const state = await inspectUserMembershipRefresh(
      db,
      userId,
      force,
      scheduler.now(),
    );
    waitMs = Math.min(waitMs * 2, MEMBERSHIP_REFRESH_WAIT_MAX_MS);
    if (state.status === "waiting") {
      pendingRetryAvailableAt = state.retryAvailableAt;
      continue;
    }
    if (state.status === "claimed") continue;
    if (state.status === "fresh") return state;
    if (state.status === "backoff") return state;
    if (state.status === "missing") return state;
    return { status: "available" };
  }
  return {
    status: "pending",
    retryAvailableAt:
      pendingRetryAvailableAt ??
      new Date(scheduler.now() + MEMBERSHIP_REFRESH_RETRY_FALLBACK_MS),
  };
}

export async function deferUserMembershipRefresh(
  db: MembershipAuthorityDatabase,
  userId: number,
  authority: MembershipRefreshAuthority,
  retryAfterMs: number,
): Promise<MembershipRefreshDeferral> {
  const finiteRetryAfterMs = Number.isFinite(retryAfterMs)
    ? retryAfterMs
    : MEMBERSHIP_REFRESH_RETRY_FALLBACK_MS;
  const boundedRetryAfterMs = Math.min(
    Math.max(
      Math.ceil(finiteRetryAfterMs),
      MEMBERSHIP_REFRESH_RETRY_FALLBACK_MS,
    ),
    MEMBERSHIP_REFRESH_MAX_RETRY_MS,
  );
  const retryAvailableAt = new Date(Date.now() + boundedRetryAfterMs);
  const deferred = await db
    .update(schema.users)
    .set({
      membershipRefreshLeaseUntil: null,
      membershipRefreshRetryAfter: retryAvailableAt,
    })
    .where(authorityCondition(userId, authority))
    .returning({ retryAvailableAt: schema.users.membershipRefreshRetryAfter });
  return deferred[0]?.retryAvailableAt
    ? { status: "deferred", retryAvailableAt: deferred[0].retryAvailableAt }
    : { status: "lost" };
}

export async function releaseUserMembershipRefresh(
  db: MembershipAuthorityDatabase,
  userId: number,
  authority: MembershipRefreshAuthority,
): Promise<void> {
  await db
    .update(schema.users)
    .set({ membershipRefreshLeaseUntil: null, membershipRefreshRetryAfter: null })
    .where(authorityCondition(userId, authority));
}

export async function completeUserMembershipRefresh(
  db: MembershipAuthorityDatabase,
  userId: number,
  authority: MembershipRefreshAuthority,
  checkedAt: Date,
): Promise<boolean> {
  const completed = await db
    .update(schema.users)
    .set({
      membershipCheckedAt: checkedAt,
      membershipRefreshLeaseUntil: null,
      membershipRefreshRetryAfter: null,
    })
    .where(authorityCondition(userId, authority))
    .returning({ id: schema.users.id });
  return completed.length === 1;
}

export function isUserMembershipFresh(
  checkedAt: Date | null,
  now = Date.now(),
): checkedAt is Date {
  return checkedAt !== null && checkedAt.getTime() > now - MEMBERSHIP_RECHECK_INTERVAL_MS;
}

async function inspectUserMembershipRefresh(
  db: MembershipAuthorityDatabase,
  userId: number,
  force: boolean,
  now = Date.now(),
): Promise<MembershipRefreshClaim | { status: "available" }> {
  const row = (
    await db
      .select({
        checkedAt: schema.users.membershipCheckedAt,
        leaseUntil: schema.users.membershipRefreshLeaseUntil,
        retryAfter: schema.users.membershipRefreshRetryAfter,
      })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1)
  )[0];
  if (!row) return { status: "missing" };
  return membershipRefreshDisposition(row, force, now);
}

export function membershipRefreshDisposition(
  row: {
    checkedAt: Date | null;
    leaseUntil: Date | null;
    retryAfter: Date | null;
  },
  force: boolean,
  now = Date.now(),
): MembershipRefreshDisposition {
  if (!force && isUserMembershipFresh(row.checkedAt, now)) {
    return { status: "fresh", checkedAt: row.checkedAt };
  }
  if (row.retryAfter && row.retryAfter.getTime() > now) {
    return { status: "backoff", retryAvailableAt: row.retryAfter };
  }
  if (row.leaseUntil && row.leaseUntil.getTime() > now) {
    return { status: "waiting", retryAvailableAt: row.leaseUntil };
  }
  return { status: "available" };
}

function authorityCondition(
  userId: number,
  authority: MembershipRefreshAuthority,
) {
  return and(
    eq(schema.users.id, userId),
    eq(schema.users.membershipRefreshGeneration, authority.generation),
    eq(schema.users.membershipRefreshLeaseUntil, authority.leaseUntil),
  );
}
