import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { and, eq } from "drizzle-orm";

import { createEphemeralDatabase, type EphemeralDatabase } from "./ephemeral-database";
import { closeDb, getDb, schema } from "@/lib/db";

const TEST_URL = process.env.POSTIL_TEST_DATABASE_URL;
const describeDb = TEST_URL ? describe : describe.skip;
const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_SESSION_SECRET = process.env.POSTIL_SESSION_SECRET;
const ORIGINAL_SEALING_KEY = process.env.POSTIL_SEALING_KEY;

let cookieToken: string | undefined;

mock.module("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "postil_session" && cookieToken ? { value: cookieToken } : undefined,
  }),
  headers: async () => ({ get: () => null }),
}));

const {
  createSession,
  getVerifiedSessionUser,
  MEMBERSHIP_CHECK_WAIT_TIMEOUT_MS,
  MEMBERSHIP_RECHECK_INTERVAL_MS,
  refreshUserMembershipsForOAuth,
  SESSION_TTL_SECONDS,
} = await import("@/lib/session");

describeDb("session organization membership revalidation", () => {
  let ephemeralDb: EphemeralDatabase;
  let db: ReturnType<typeof getDb>;

  beforeAll(async () => {
    ephemeralDb = await createEphemeralDatabase("session_membership_recheck");
    await closeDb();
    // getVerifiedSessionUser/createSession reach the database through the
    // getDb() singleton, keyed off DATABASE_URL.
    process.env.DATABASE_URL = ephemeralDb.url;
    process.env.POSTIL_SESSION_SECRET = "test-session-secret-with-at-least-32-bytes";
    process.env.POSTIL_SEALING_KEY = "ab".repeat(32);
    db = getDb();
  }, 30_000);

  beforeEach(async () => {
    cookieToken = undefined;
    globalThis.fetch = ORIGINAL_FETCH;
    await db.execute(
      "TRUNCATE sessions, org_members, organizations, users RESTART IDENTITY CASCADE" as never,
    );
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  afterAll(async () => {
    restoreEnv("POSTIL_SESSION_SECRET", ORIGINAL_SESSION_SECRET);
    restoreEnv("POSTIL_SEALING_KEY", ORIGINAL_SEALING_KEY);
    // Release the getDb() singleton's connection before dropping the
    // database it points at, or the drop fails with "database is being
    // accessed by other users".
    await closeDb();
    await ephemeralDb?.drop();
    restoreEnv("DATABASE_URL", ORIGINAL_DATABASE_URL);
  }, 30_000);

  test("seals the OAuth token and refreshes roles and revocations", async () => {
    const userId = await makeUser(1001, "octocat");
    const personalOrgId = await makeOrg("octocat", 1001);
    const activeOrgId = await makeOrg("active-org", 2001);
    const leftOrgId = await makeOrg("left-org", 2002);
    await db.insert(schema.orgMembers).values([
      { orgId: personalOrgId, userId, role: "admin" },
      { orgId: activeOrgId, userId, role: "member" },
      { orgId: leftOrgId, userId, role: "admin" },
    ]);
    const accessToken = "github-oauth-token-for-test";
    cookieToken = await createSession(userId, accessToken, staleCheckedAt());
    globalThis.fetch = testFetch(async () =>
      jsonResponse([
        { role: "admin", organization: { id: 2001, login: "active-org" } },
      ]));

    const result = await getVerifiedSessionUser();

    expect(result).toMatchObject({ ok: true, user: { id: userId, login: "octocat" } });
    const memberships = await db
      .select({ orgId: schema.orgMembers.orgId, role: schema.orgMembers.role })
      .from(schema.orgMembers)
      .where(eq(schema.orgMembers.userId, userId));
    expect(memberships.sort((a, b) => a.orgId - b.orgId)).toEqual([
      { orgId: personalOrgId, role: "admin" },
      { orgId: activeOrgId, role: "admin" },
    ]);

    const [storedSession] = await db
      .select({
        ciphertext: schema.sessions.githubAccessTokenCiphertext,
      })
      .from(schema.sessions);
    const [storedUser] = await db
      .select({
        checkedAt: schema.users.membershipCheckedAt,
        leaseUntil: schema.users.membershipRefreshLeaseUntil,
        retryAfter: schema.users.membershipRefreshRetryAfter,
      })
      .from(schema.users);
    expect(storedSession?.ciphertext).toBeInstanceOf(Buffer);
    expect(storedSession?.ciphertext?.includes(Buffer.from(accessToken))).toBe(false);
    expect(storedUser?.checkedAt?.getTime()).toBeGreaterThan(Date.now() - 5_000);
    expect(storedUser?.leaseUntil).toBeNull();
    expect(storedUser?.retryAfter).toBeNull();
  });

  test("does not call GitHub while the membership snapshot is fresh", async () => {
    const userId = await makeUser(1001, "octocat");
    cookieToken = await createSession(userId, "token", new Date());
    let fetchCount = 0;
    globalThis.fetch = testFetch(async () => {
      fetchCount += 1;
      return jsonResponse([]);
    });

    expect(await getVerifiedSessionUser()).toMatchObject({ ok: true });
    expect(fetchCount).toBe(0);
  });

  test("stores a seven-day session while retaining the 15-minute membership refresh interval", async () => {
    const userId = await makeUser(1001, "octocat");
    const before = Date.now();
    await createSession(userId, "token", new Date());
    const [session] = await db
      .select({ expiresAt: schema.sessions.expiresAt })
      .from(schema.sessions);

    expect(SESSION_TTL_SECONDS).toBe(7 * 24 * 60 * 60);
    expect(MEMBERSHIP_RECHECK_INTERVAL_MS).toBe(15 * 60 * 1000);
    expect(MEMBERSHIP_CHECK_WAIT_TIMEOUT_MS).toBe(35 * 1000);
    expect(session?.expiresAt?.getTime()).toBeGreaterThanOrEqual(
      before + SESSION_TTL_SECONDS * 1_000,
    );
    expect(session?.expiresAt?.getTime()).toBeLessThanOrEqual(
      Date.now() + SESSION_TTL_SECONDS * 1_000,
    );
  });

  test("signs out the session when GitHub rejects the OAuth token", async () => {
    const userId = await makeUser(1001, "octocat");
    cookieToken = await createSession(userId, "revoked-token", staleCheckedAt());
    globalThis.fetch = testFetch(async () =>
      new Response("bad credentials", { status: 401 }));

    expect(await getVerifiedSessionUser()).toEqual({
      ok: false,
      reason: "unauthenticated",
    });
    expect(await db.select({ id: schema.sessions.id }).from(schema.sessions)).toEqual([]);
  });

  test("fails closed without revoking stored memberships during a GitHub outage", async () => {
    const userId = await makeUser(1001, "octocat");
    const orgId = await makeOrg("acme", 2001);
    await db.insert(schema.orgMembers).values({ orgId, userId, role: "admin" });
    cookieToken = await createSession(userId, "valid-token", staleCheckedAt());
    let fetchCount = 0;
    globalThis.fetch = testFetch(async () => {
      fetchCount += 1;
      return new Response("unavailable", { status: 503 });
    });

    const firstFailure = await getVerifiedSessionUser();
    expect(firstFailure).toMatchObject({
      ok: false,
      reason: "verification_unavailable",
    });
    expect(verificationRetryAvailableAt(firstFailure).getTime()).toBeGreaterThan(
      Date.now() + 25_000,
    );
    expect(
      await db
        .select({ role: schema.orgMembers.role })
        .from(schema.orgMembers)
        .where(and(eq(schema.orgMembers.orgId, orgId), eq(schema.orgMembers.userId, userId))),
    ).toEqual([{ role: "admin" }]);
    const [user] = await db
      .select({
        leaseUntil: schema.users.membershipRefreshLeaseUntil,
        retryAfter: schema.users.membershipRefreshRetryAfter,
      })
      .from(schema.users);
    expect(user?.leaseUntil).toBeNull();
    expect(user?.retryAfter?.getTime()).toBeGreaterThan(Date.now() + 25_000);
    const storedRetryAfter = user?.retryAfter;
    if (!storedRetryAfter) throw new Error("expected stored membership backoff");
    const backoffFailure = await getVerifiedSessionUser();
    expect(backoffFailure).toMatchObject({
      ok: false,
      reason: "verification_unavailable",
    });
    expect(verificationRetryAvailableAt(backoffFailure)).toEqual(
      storedRetryAfter,
    );
    expect(fetchCount).toBe(1);
  });

  test("lets a concurrent stale request share a GitHub refresh lasting more than two seconds", async () => {
    const userId = await makeUser(1001, "octocat");
    cookieToken = await createSession(userId, "valid-token", staleCheckedAt());
    let fetchCount = 0;
    globalThis.fetch = testFetch(async () => {
      fetchCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 2_100));
      return jsonResponse([]);
    });

    const [first, second] = await Promise.all([
      getVerifiedSessionUser(),
      getVerifiedSessionUser(),
    ]);

    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: true });
    expect(fetchCount).toBe(1);
  }, 10_000);

  test("reclaims an expired active refresh lease in the waiting request", async () => {
    const userId = await makeUser(1001, "octocat");
    cookieToken = await createSession(userId, "valid-token", staleCheckedAt());
    await db
      .update(schema.users)
      .set({
        membershipRefreshGeneration: 7,
        membershipRefreshLeaseUntil: new Date(Date.now() + 250),
      })
      .where(eq(schema.users.id, userId));
    let fetchCount = 0;
    globalThis.fetch = testFetch(async () => {
      fetchCount += 1;
      return jsonResponse([]);
    });

    const startedAt = Date.now();
    expect(await getVerifiedSessionUser()).toMatchObject({ ok: true });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(200);
    expect(fetchCount).toBe(1);
  });

  test("fails fast during backoff and recovers after it expires", async () => {
    const userId = await makeUser(1001, "octocat");
    cookieToken = await createSession(userId, "valid-token", staleCheckedAt());
    let unavailable = true;
    let fetchCount = 0;
    globalThis.fetch = testFetch(async () => {
      fetchCount += 1;
      return unavailable
        ? new Response("unavailable", {
            status: 503,
            headers: { "retry-after": "0" },
          })
        : jsonResponse([]);
    });

    expect(await getVerifiedSessionUser()).toMatchObject({
      ok: false,
      reason: "verification_unavailable",
    });

    const retryStartedAt = Date.now();
    expect(await getVerifiedSessionUser()).toMatchObject({
      ok: false,
      reason: "verification_unavailable",
    });
    expect(Date.now() - retryStartedAt).toBeLessThan(1_000);
    expect(fetchCount).toBe(1);

    unavailable = false;
    await new Promise((resolve) => setTimeout(resolve, 5_100));
    expect(await getVerifiedSessionUser()).toMatchObject({ ok: true });
    expect(fetchCount).toBe(2);
  }, 15_000);

  test("stops a concurrent wait when the refresh owner defers after failure", async () => {
    const userId = await makeUser(1001, "octocat");
    cookieToken = await createSession(userId, "valid-token", staleCheckedAt());
    let markFetchStarted!: () => void;
    let resolveFetch!: (response: Response) => void;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    const fetchResponse = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    globalThis.fetch = testFetch(async () => {
      markFetchStarted();
      return fetchResponse;
    });

    const owner = getVerifiedSessionUser();
    await fetchStarted;
    const startedAt = Date.now();
    const follower = getVerifiedSessionUser();
    resolveFetch(new Response("unavailable", { status: 503 }));

    expect(await owner).toMatchObject({
      ok: false,
      reason: "verification_unavailable",
    });
    expect(await follower).toMatchObject({
      ok: false,
      reason: "verification_unavailable",
    });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  }, 10_000);

  test("rejects shared freshness when a waiting follower session is deleted", async () => {
    const userId = await makeUser(1001, "octocat");
    const ownerToken = await createSession(
      userId,
      "owner-token",
      staleCheckedAt(),
    );
    const [ownerSession] = await db
      .select({ id: schema.sessions.id })
      .from(schema.sessions);
    const followerToken = await createSession(
      userId,
      "follower-token",
      staleCheckedAt(),
    );
    const followerSession = (
      await db.select({ id: schema.sessions.id }).from(schema.sessions)
    ).find((session) => session.id !== ownerSession?.id);
    let markFetchStarted!: () => void;
    let resolveFetch!: (response: Response) => void;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    const fetchResponse = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    globalThis.fetch = testFetch(async () => {
      markFetchStarted();
      return fetchResponse;
    });

    cookieToken = ownerToken;
    const owner = getVerifiedSessionUser();
    await fetchStarted;
    cookieToken = followerToken;
    const follower = getVerifiedSessionUser();
    await new Promise((resolve) => setTimeout(resolve, 150));
    await db
      .delete(schema.sessions)
      .where(eq(schema.sessions.id, followerSession!.id));
    resolveFetch(jsonResponse([]));

    expect(await owner).toMatchObject({ ok: true });
    expect(await follower).toEqual({ ok: false, reason: "unauthenticated" });
  });

  test("rejects shared freshness when a waiting follower session expires", async () => {
    const userId = await makeUser(1001, "octocat");
    const ownerToken = await createSession(
      userId,
      "owner-token",
      staleCheckedAt(),
    );
    const [ownerSession] = await db
      .select({ id: schema.sessions.id })
      .from(schema.sessions);
    const followerToken = await createSession(
      userId,
      "follower-token",
      staleCheckedAt(),
    );
    const followerSession = (
      await db.select({ id: schema.sessions.id }).from(schema.sessions)
    ).find((session) => session.id !== ownerSession?.id);
    let markFetchStarted!: () => void;
    let resolveFetch!: (response: Response) => void;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    const fetchResponse = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    globalThis.fetch = testFetch(async () => {
      markFetchStarted();
      return fetchResponse;
    });

    cookieToken = ownerToken;
    const owner = getVerifiedSessionUser();
    await fetchStarted;
    cookieToken = followerToken;
    const follower = getVerifiedSessionUser();
    await new Promise((resolve) => setTimeout(resolve, 150));
    await db
      .update(schema.sessions)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(schema.sessions.id, followerSession!.id));
    resolveFetch(jsonResponse([]));

    expect(await owner).toMatchObject({ ok: true });
    expect(await follower).toEqual({ ok: false, reason: "unauthenticated" });
  });

  test("prevents a stale refresh owner from restoring a revoked membership", async () => {
    const userId = await makeUser(1001, "octocat");
    const orgId = await makeOrg("acme", 2001);
    await db.insert(schema.orgMembers).values({ orgId, userId, role: "admin" });
    const firstSessionToken = await createSession(
      userId,
      "first-valid-token",
      staleCheckedAt(),
    );
    const secondSessionToken = await createSession(
      userId,
      "second-valid-token",
      staleCheckedAt(),
    );
    cookieToken = firstSessionToken;

    let fetchCount = 0;
    let markFirstFetchStarted!: () => void;
    let resolveFirstFetch!: (response: Response) => void;
    const firstFetchStarted = new Promise<void>((resolve) => {
      markFirstFetchStarted = resolve;
    });
    const firstFetchResponse = new Promise<Response>((resolve) => {
      resolveFirstFetch = resolve;
    });
    globalThis.fetch = testFetch(async () => {
      fetchCount += 1;
      if (fetchCount === 1) {
        markFirstFetchStarted();
        return firstFetchResponse;
      }
      return jsonResponse([]);
    });

    const staleRequest = getVerifiedSessionUser();
    await firstFetchStarted;
    const [user] = await db.select({ id: schema.users.id }).from(schema.users);
    await db
      .update(schema.users)
      .set({ membershipRefreshLeaseUntil: new Date(Date.now() - 1_000) })
      .where(eq(schema.users.id, user!.id));

    cookieToken = secondSessionToken;
    expect(await getVerifiedSessionUser()).toMatchObject({ ok: true });
    resolveFirstFetch(
      jsonResponse([
        { role: "admin", organization: { id: 2001, login: "acme" } },
      ]),
    );
    expect(await staleRequest).toMatchObject({ ok: true });

    expect(
      await db
        .select({ role: schema.orgMembers.role })
        .from(schema.orgMembers)
        .where(and(eq(schema.orgMembers.orgId, orgId), eq(schema.orgMembers.userId, userId))),
    ).toEqual([]);
    expect(fetchCount).toBe(2);
  });

  test("prevents an older session snapshot from overwriting a newer OAuth callback", async () => {
    const userId = await makeUser(1001, "octocat");
    const orgId = await makeOrg("example-org", 2001);
    await db.insert(schema.orgMembers).values({ orgId, userId, role: "admin" });
    cookieToken = await createSession(userId, "session-token", staleCheckedAt());

    let fetchCount = 0;
    let markFirstFetchStarted!: () => void;
    let resolveFirstFetch!: (response: Response) => void;
    const firstFetchStarted = new Promise<void>((resolve) => {
      markFirstFetchStarted = resolve;
    });
    const firstFetchResponse = new Promise<Response>((resolve) => {
      resolveFirstFetch = resolve;
    });
    globalThis.fetch = testFetch(async () => {
      fetchCount += 1;
      if (fetchCount === 1) {
        markFirstFetchStarted();
        return firstFetchResponse;
      }
      return jsonResponse([]);
    });

    const staleSessionRequest = getVerifiedSessionUser();
    await firstFetchStarted;
    await db
      .update(schema.users)
      .set({ membershipRefreshLeaseUntil: new Date(Date.now() - 1_000) })
      .where(eq(schema.users.id, userId));

    expect(
      await refreshUserMembershipsForOAuth({
        userId,
        githubId: 1001,
        accessToken: "oauth-token",
        onFetchedMemberships: async () => undefined,
      }),
    ).toMatchObject({ ok: true });
    resolveFirstFetch(
      jsonResponse([
        { role: "admin", organization: { id: 2001, login: "example-org" } },
      ]),
    );

    expect(await staleSessionRequest).toMatchObject({ ok: true });
    expect(
      await db
        .select({ role: schema.orgMembers.role })
        .from(schema.orgMembers)
        .where(and(eq(schema.orgMembers.orgId, orgId), eq(schema.orgMembers.userId, userId))),
    ).toEqual([]);
    expect(fetchCount).toBe(2);
  });

  test("lets a current reconciliation overwrite a legacy write that committed first", async () => {
    const userId = await makeUser(1001, "octocat");
    const orgId = await makeOrg("legacy-org", 2001);
    await db
      .insert(schema.orgMembers)
      .values({ orgId, userId, role: "admin" });
    globalThis.fetch = testFetch(async () => jsonResponse([]));

    expect(
      await refreshUserMembershipsForOAuth({
        userId,
        githubId: 1001,
        accessToken: "oauth-token",
        onFetchedMemberships: async () => undefined,
      }),
    ).toMatchObject({ ok: true });
    expect(
      await db
        .select({ id: schema.orgMembers.id })
        .from(schema.orgMembers)
        .where(eq(schema.orgMembers.userId, userId)),
    ).toEqual([]);
  });

  test("serializes a generation claim behind an in-flight legacy membership write", async () => {
    const userId = await makeUser(1001, "octocat");
    const orgId = await makeOrg("legacy-race", 2001);
    const legacyWriter = await ephemeralDb.pool.connect();
    let transactionOpen = false;
    let refreshPromise:
      | ReturnType<typeof refreshUserMembershipsForOAuth>
      | undefined;
    let fetchCount = 0;
    globalThis.fetch = testFetch(async () => {
      fetchCount += 1;
      return jsonResponse([]);
    });

    try {
      await legacyWriter.query("BEGIN");
      transactionOpen = true;
      await legacyWriter.query(
        `INSERT INTO org_members (org_id, user_id, role)
         VALUES ($1, $2, 'admin')`,
        [orgId, userId],
      );

      refreshPromise = refreshUserMembershipsForOAuth({
        userId,
        githubId: 1001,
        accessToken: "oauth-token",
        onFetchedMemberships: async () => undefined,
      });
      await waitForBlockedMembershipClaim(ephemeralDb.pool);
      expect(fetchCount).toBe(0);

      await legacyWriter.query("COMMIT");
      transactionOpen = false;
      expect(await refreshPromise).toMatchObject({ ok: true });

      const [user] = await db
        .select({ generation: schema.users.membershipRefreshGeneration })
        .from(schema.users)
        .where(eq(schema.users.id, userId));
      expect(user?.generation).toBe(1);
      expect(
        await db
          .select({ id: schema.orgMembers.id })
          .from(schema.orgMembers)
          .where(eq(schema.orgMembers.userId, userId)),
      ).toEqual([]);
      expect(fetchCount).toBe(1);
    } finally {
      if (transactionOpen) await legacyWriter.query("ROLLBACK");
      await refreshPromise?.catch(() => undefined);
      legacyWriter.release();
    }
  }, 15_000);

  test("serializes a generation claim behind in-flight legacy session freshness", async () => {
    const userId = await makeUser(1001, "octocat");
    const legacyCheckedAt = new Date(Date.now() - 60_000);
    const legacyWriter = await ephemeralDb.pool.connect();
    let transactionOpen = false;
    let refreshPromise:
      | ReturnType<typeof refreshUserMembershipsForOAuth>
      | undefined;
    let fetchCount = 0;
    globalThis.fetch = testFetch(async () => {
      fetchCount += 1;
      return jsonResponse([]);
    });

    try {
      await legacyWriter.query("BEGIN");
      transactionOpen = true;
      await legacyWriter.query(
        `INSERT INTO sessions
           (id, user_id, expires_at, membership_checked_at)
         VALUES ('legacy-racing-session', $1, now() + interval '1 hour', $2)`,
        [userId, legacyCheckedAt],
      );

      refreshPromise = refreshUserMembershipsForOAuth({
        userId,
        githubId: 1001,
        accessToken: "oauth-token",
        onFetchedMemberships: async () => undefined,
      });
      await waitForBlockedMembershipClaim(ephemeralDb.pool);
      expect(fetchCount).toBe(0);

      await legacyWriter.query("COMMIT");
      transactionOpen = false;
      const result = await refreshPromise;
      if (!result.ok) throw new Error("expected membership refresh to succeed");

      const [session] = await db
        .select({ checkedAt: schema.sessions.membershipCheckedAt })
        .from(schema.sessions)
        .where(eq(schema.sessions.id, "legacy-racing-session"));
      const [user] = await db
        .select({
          checkedAt: schema.users.membershipCheckedAt,
          generation: schema.users.membershipRefreshGeneration,
        })
        .from(schema.users)
        .where(eq(schema.users.id, userId));
      expect(session?.checkedAt).toEqual(result.checkedAt);
      expect(user?.checkedAt).toEqual(result.checkedAt);
      expect(user?.generation).toBe(1);
      expect(fetchCount).toBe(1);
    } finally {
      if (transactionOpen) await legacyWriter.query("ROLLBACK");
      await refreshPromise?.catch(() => undefined);
      legacyWriter.release();
    }
  }, 15_000);

  test("rejects legacy membership inserts, user-changing updates, and deletes after fencing", async () => {
    const fencedUserId = await makeUser(1001, "octocat");
    const legacyUserId = await makeUser(1002, "hubot");
    const insertOrgId = await makeOrg("insert-org", 2001);
    const updateOrgId = await makeOrg("update-org", 2002);
    const deleteOrgId = await makeOrg("delete-org", 2003);
    await db.insert(schema.orgMembers).values([
      { orgId: updateOrgId, userId: legacyUserId, role: "member" },
      { orgId: deleteOrgId, userId: fencedUserId, role: "admin" },
    ]);
    await db
      .update(schema.users)
      .set({ membershipRefreshGeneration: 1 })
      .where(eq(schema.users.id, fencedUserId));

    await expectDatabaseError(
      db
        .insert(schema.orgMembers)
        .values({ orgId: insertOrgId, userId: fencedUserId, role: "member" }),
      "55000",
    );
    await expectDatabaseError(
      db
        .update(schema.orgMembers)
        .set({ userId: fencedUserId })
        .where(
          and(
            eq(schema.orgMembers.orgId, updateOrgId),
            eq(schema.orgMembers.userId, legacyUserId),
          ),
        ),
      "55000",
    );
    await expectDatabaseError(
      db
        .delete(schema.orgMembers)
        .where(
          and(
            eq(schema.orgMembers.orgId, deleteOrgId),
            eq(schema.orgMembers.userId, fencedUserId),
          ),
        ),
      "55000",
    );
  });

  test("clears legacy session freshness after fencing while current sessions remain fresh", async () => {
    const userId = await makeUser(1001, "octocat");
    const legacyCheckedAt = new Date();
    await db.insert(schema.sessions).values({
      id: "legacy-before-fence",
      userId,
      expiresAt: new Date(Date.now() + 60_000),
      membershipCheckedAt: legacyCheckedAt,
      membershipCheckAvailableAt: new Date(Date.now() + 30_000),
    });
    await db
      .update(schema.users)
      .set({ membershipRefreshGeneration: 1 })
      .where(eq(schema.users.id, userId));

    await db.insert(schema.sessions).values({
      id: "legacy-after-fence",
      userId,
      expiresAt: new Date(Date.now() + 60_000),
      membershipCheckedAt: new Date(),
      membershipCheckAvailableAt: new Date(Date.now() + 30_000),
    });
    await db
      .update(schema.sessions)
      .set({ membershipCheckedAt: new Date() })
      .where(eq(schema.sessions.id, "legacy-before-fence"));
    const currentCheckedAt = new Date();
    await createSession(userId, "current-token", currentCheckedAt);

    const sessions = await db
      .select({
        id: schema.sessions.id,
        checkedAt: schema.sessions.membershipCheckedAt,
        availableAt: schema.sessions.membershipCheckAvailableAt,
      })
      .from(schema.sessions);
    expect(sessions.find((session) => session.id === "legacy-before-fence")).toMatchObject({
      checkedAt: null,
      availableAt: null,
    });
    expect(sessions.find((session) => session.id === "legacy-after-fence")).toMatchObject({
      checkedAt: null,
      availableAt: null,
    });
    expect(
      sessions.find(
        (session) =>
          session.id !== "legacy-before-fence" &&
          session.id !== "legacy-after-fence",
      )?.checkedAt,
    ).toEqual(currentCheckedAt);
  });

  test("does not grant access when the session expires during refresh", async () => {
    const userId = await makeUser(1001, "octocat");
    cookieToken = await createSession(userId, "valid-token", staleCheckedAt());
    const [session] = await db.select({ id: schema.sessions.id }).from(schema.sessions);
    globalThis.fetch = testFetch(async () => {
      await db
        .update(schema.sessions)
        .set({ expiresAt: new Date(Date.now() - 1_000) })
        .where(eq(schema.sessions.id, session!.id));
      return jsonResponse([]);
    });

    expect(await getVerifiedSessionUser()).toEqual({
      ok: false,
      reason: "unauthenticated",
    });
  });

  test("does not clear a replacement refresh lease after an older request fails", async () => {
    const userId = await makeUser(1001, "octocat");
    cookieToken = await createSession(userId, "valid-token", staleCheckedAt());
    const [user] = await db.select({ id: schema.users.id }).from(schema.users);
    const replacementLease = new Date(Date.now() + 30_000);
    globalThis.fetch = testFetch(async () => {
      await db
        .update(schema.users)
        .set({
          membershipRefreshGeneration: 99,
          membershipRefreshLeaseUntil: replacementLease,
        })
        .where(eq(schema.users.id, user!.id));
      return new Response("unavailable", { status: 503 });
    });

    const failure = await getVerifiedSessionUser();
    expect(failure).toMatchObject({
      ok: false,
      reason: "verification_unavailable",
    });
    expect(verificationRetryAvailableAt(failure)).toEqual(replacementLease);
    const [stored] = await db
      .select({ availableAt: schema.users.membershipRefreshLeaseUntil })
      .from(schema.users)
      .where(eq(schema.users.id, user!.id));
    expect(stored?.availableAt).toEqual(replacementLease);
  });

  test("requires a new sign-in for a rolling session without a sealed token", async () => {
    const userId = await makeUser(1001, "octocat");
    const sessionId = "legacy-session";
    await db.insert(schema.sessions).values({
      id: sessionId,
      userId,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const { signSessionToken } = await import("@/lib/session-token");
    cookieToken = await signSessionToken(
      sessionId,
      process.env.POSTIL_SESSION_SECRET!,
    );

    expect(await getVerifiedSessionUser()).toEqual({
      ok: false,
      reason: "unauthenticated",
    });
    expect(await db.select({ id: schema.sessions.id }).from(schema.sessions)).toEqual([]);
  });

  async function makeUser(githubId: number, login: string): Promise<number> {
    const [row] = await db
      .insert(schema.users)
      .values({ githubId, login })
      .returning({ id: schema.users.id });
    return row!.id;
  }

  async function makeOrg(slug: string, githubOrgId: number): Promise<number> {
    const [row] = await db
      .insert(schema.organizations)
      .values({ slug, name: slug, githubOrgId })
      .returning({ id: schema.organizations.id });
    return row!.id;
  }

  function staleCheckedAt(): Date {
    return new Date(Date.now() - MEMBERSHIP_RECHECK_INTERVAL_MS - 1_000);
  }
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function testFetch(handler: () => Promise<Response>): typeof fetch {
  return Object.assign(handler, { preconnect: ORIGINAL_FETCH.preconnect }) as typeof fetch;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function verificationRetryAvailableAt(
  result: Awaited<ReturnType<typeof getVerifiedSessionUser>>,
): Date {
  if (result.ok || result.reason !== "verification_unavailable") {
    throw new Error("expected membership verification to be unavailable");
  }
  expect(result.retryAvailableAt).toBeInstanceOf(Date);
  return result.retryAvailableAt;
}

async function expectDatabaseError(
  operation: PromiseLike<unknown>,
  expectedCode: string,
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    const databaseError = error as {
      code?: string;
      cause?: { code?: string };
    };
    expect(databaseError.cause?.code ?? databaseError.code).toBe(expectedCode);
    return;
  }
  throw new Error(`expected database error ${expectedCode}`);
}

async function waitForBlockedMembershipClaim(
  pool: EphemeralDatabase["pool"],
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const waiting = await pool.query<{ blocked: boolean }>(`
      SELECT EXISTS (
        SELECT 1
          FROM pg_stat_activity
         WHERE datname = current_database()
           AND cardinality(pg_blocking_pids(pid)) > 0
           AND query ILIKE '%update "users"%'
           AND query ILIKE '%membership_refresh_generation%'
      ) AS blocked
    `);
    if (waiting.rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("membership generation claim did not wait for the legacy writer");
}
