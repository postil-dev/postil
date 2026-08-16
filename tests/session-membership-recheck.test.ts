import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { and, eq } from "drizzle-orm";

import { createEphemeralDatabase, type EphemeralDatabase } from "./ephemeral-database";
import { closeDb, getDb, schema } from "@/lib/db";

const TEST_URL = process.env.POSTIL_TEST_DATABASE_URL;
const describeDb = TEST_URL ? describe : describe.skip;
const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_SESSION_SECRET = process.env.POSTIL_SESSION_SECRET;
const ORIGINAL_SEALING_KEY = process.env.POSTIL_SEALING_KEY;

let cookieToken: string | undefined;

mock.module("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "postil_session" && cookieToken ? { value: cookieToken } : undefined,
  }),
}));

const {
  createSession,
  getVerifiedSessionUser,
  MEMBERSHIP_RECHECK_INTERVAL_MS,
  SESSION_TTL_SECONDS,
} = await import("@/lib/session");

describeDb("session organization membership revalidation", () => {
  let ephemeralDb: EphemeralDatabase;
  let db: ReturnType<typeof getDb>;

  beforeAll(async () => {
    ephemeralDb = await createEphemeralDatabase("session_membership_recheck");
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
  }, 30_000);

  test("stores a seven-day session expiry", async () => {
    const userId = await makeUser(1001, "octocat");
    const before = Date.now();

    await createSession(userId, "github-oauth-token", new Date());

    const [session] = await db
      .select({ expiresAt: schema.sessions.expiresAt })
      .from(schema.sessions);
    expect(SESSION_TTL_SECONDS).toBe(7 * 24 * 60 * 60);
    expect(session?.expiresAt.getTime()).toBeGreaterThanOrEqual(
      before + SESSION_TTL_SECONDS * 1_000,
    );
    expect(session?.expiresAt.getTime()).toBeLessThanOrEqual(
      Date.now() + SESSION_TTL_SECONDS * 1_000,
    );
  });

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
        checkedAt: schema.sessions.membershipCheckedAt,
        checkAvailableAt: schema.sessions.membershipCheckAvailableAt,
      })
      .from(schema.sessions);
    expect(storedSession?.ciphertext).toBeInstanceOf(Buffer);
    expect(storedSession?.ciphertext?.includes(Buffer.from(accessToken))).toBe(false);
    expect(storedSession?.checkedAt?.getTime()).toBeGreaterThan(Date.now() - 5_000);
    expect(storedSession?.checkAvailableAt).toBeNull();
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

  test("deletes the session when GitHub rejects the OAuth token", async () => {
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

    expect(await getVerifiedSessionUser()).toEqual({
      ok: false,
      reason: "verification_unavailable",
    });
    expect(
      await db
        .select({ role: schema.orgMembers.role })
        .from(schema.orgMembers)
        .where(and(eq(schema.orgMembers.orgId, orgId), eq(schema.orgMembers.userId, userId))),
    ).toEqual([{ role: "admin" }]);
    const [session] = await db
      .select({ checkAvailableAt: schema.sessions.membershipCheckAvailableAt })
      .from(schema.sessions);
    expect(session?.checkAvailableAt?.getTime()).toBeGreaterThan(Date.now() + 25_000);
    expect(await getVerifiedSessionUser()).toEqual({
      ok: false,
      reason: "verification_unavailable",
    });
    expect(fetchCount).toBe(1);
  });

  test("makes concurrent stale requests share one GitHub refresh", async () => {
    const userId = await makeUser(1001, "octocat");
    cookieToken = await createSession(userId, "valid-token", staleCheckedAt());
    let fetchCount = 0;
    globalThis.fetch = testFetch(async () => {
      fetchCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 100));
      return jsonResponse([]);
    });

    const [first, second] = await Promise.all([
      getVerifiedSessionUser(),
      getVerifiedSessionUser(),
    ]);

    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: true });
    expect(fetchCount).toBe(1);
  });

  test("prevents a stale refresh owner from restoring a revoked membership", async () => {
    const userId = await makeUser(1001, "octocat");
    const orgId = await makeOrg("acme", 2001);
    await db.insert(schema.orgMembers).values({ orgId, userId, role: "admin" });
    cookieToken = await createSession(userId, "valid-token", staleCheckedAt());

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
    const [session] = await db.select({ id: schema.sessions.id }).from(schema.sessions);
    await db
      .update(schema.sessions)
      .set({ membershipCheckAvailableAt: new Date(Date.now() - 1_000) })
      .where(eq(schema.sessions.id, session!.id));

    expect(await getVerifiedSessionUser()).toMatchObject({ ok: true });
    resolveFirstFetch(
      jsonResponse([
        { role: "admin", organization: { id: 2001, login: "acme" } },
      ]),
    );
    expect(await staleRequest).toEqual({ ok: false, reason: "unauthenticated" });

    expect(
      await db
        .select({ role: schema.orgMembers.role })
        .from(schema.orgMembers)
        .where(and(eq(schema.orgMembers.orgId, orgId), eq(schema.orgMembers.userId, userId))),
    ).toEqual([]);
    expect(fetchCount).toBe(2);
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
    const [session] = await db.select({ id: schema.sessions.id }).from(schema.sessions);
    const replacementLease = new Date(Date.now() + 1_000);
    globalThis.fetch = testFetch(async () => {
      await db
        .update(schema.sessions)
        .set({ membershipCheckAvailableAt: replacementLease })
        .where(eq(schema.sessions.id, session!.id));
      return new Response("unavailable", { status: 503 });
    });

    expect(await getVerifiedSessionUser()).toEqual({
      ok: false,
      reason: "verification_unavailable",
    });
    const [stored] = await db
      .select({ availableAt: schema.sessions.membershipCheckAvailableAt })
      .from(schema.sessions)
      .where(eq(schema.sessions.id, session!.id));
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
