import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { Client, Pool } from "pg";

// Mirrors the private sha256() helper in src/lib/cli-auth.ts: tokens and
// device codes are looked up by digest only, so tests reaching into the
// database directly must hash the same way the library does.
function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

const TEST_URL = process.env.POSTIL_TEST_DATABASE_URL;
const describeDb = TEST_URL ? describe : describe.skip;

describeDb("postil login device authorization", () => {
  const databaseName = `postil_cli_device_auth_${process.pid}_${Date.now()}`;
  let adminClient: Client | undefined;
  let pool: Pool | undefined;
  let userId = 0;
  let orgId = 0;

  beforeAll(async () => {
    adminClient = new Client({ connectionString: TEST_URL });
    await adminClient.connect();
    await adminClient.query(`CREATE DATABASE "${databaseName}"`);
    const databaseUrl = new URL(TEST_URL!);
    databaseUrl.pathname = `/${databaseName}`;
    const migrationClient = new Client({
      connectionString: databaseUrl.toString(),
    });
    await migrationClient.connect();
    const migrationsDir = join(import.meta.dir, "..", "drizzle");
    const migrations = (await readdir(migrationsDir))
      .filter((file) => /^\d{4}_.*\.sql$/.test(file))
      .sort();
    for (const file of migrations) {
      const source = await readFile(join(migrationsDir, file), "utf8");
      for (const statement of source.split("--> statement-breakpoint")) {
        if (statement.trim()) await migrationClient.query(statement);
      }
    }
    const user = await migrationClient.query<{ id: string }>(`
      INSERT INTO users (github_id, login) VALUES (990001, 'cli-login-user') RETURNING id;
    `);
    userId = Number(user.rows[0]?.id);
    const org = await migrationClient.query<{ id: string }>(`
      INSERT INTO organizations (slug, name) VALUES ('cli-login-org', 'CLI Login Org') RETURNING id;
    `);
    orgId = Number(org.rows[0]?.id);
    await migrationClient.query(
      `INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'admin')`,
      [orgId, userId],
    );
    await migrationClient.end();

    // getDb() is a lazy singleton keyed off DATABASE_URL at first call, so
    // pointing it at this scratch database before any route module is
    // imported makes every route under test talk to this database.
    process.env.DATABASE_URL = databaseUrl.toString();
    pool = new Pool({ connectionString: databaseUrl.toString(), max: 4 });
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    if (adminClient) {
      if (process.env.POSTIL_KEEP_TEST_DATABASE !== "1") {
        await adminClient.query(
          `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
        );
      }
      await adminClient.end();
    }
  }, 30_000);

  test("start returns an opaque device code and an unambiguous, hyphenated user code", async () => {
    const { POST } = await import("@/app/api/cli/device/start/route");
    const response = await POST(
      new Request("https://postil.dev/api/cli/device/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientVersion: "0.8.4" }),
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.deviceCode).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.userCode).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(body.verificationUri).toBe("https://postil.dev/cli/authorize");
    expect(body.verificationUriComplete).toBe(
      `https://postil.dev/cli/authorize?code=${encodeURIComponent(body.userCode as string)}`,
    );
    expect(body.expiresIn).toBe(600);
    expect(body.interval).toBe(5);
  });

  test("a pending code returns 428 and an approved one returns a redeemable token", async () => {
    const {
      approveDeviceAuthorization,
      findDeviceAuthorizationByUserCode,
      normalizeUserCodeInput,
    } = await import("@/lib/cli-auth");
    const { getDb } = await import("@/lib/db");
    const { POST: startPost } =
      await import("@/app/api/cli/device/start/route");
    const { POST: tokenPost } =
      await import("@/app/api/cli/device/token/route");

    const start = await startPost(
      new Request("https://postil.dev/api/cli/device/start", {
        method: "POST",
      }),
    );
    const { deviceCode, userCode } = (await start.json()) as {
      deviceCode: string;
      userCode: string;
    };

    const pending = await tokenPost(deviceTokenRequest(deviceCode));
    expect(pending.status).toBe(428);
    expect(await pending.json()).toEqual({ status: "pending" });

    const db = getDb();
    const row = await findDeviceAuthorizationByUserCode(
      db,
      normalizeUserCodeInput(userCode),
    );
    expect(row).not.toBeNull();
    const approved = await approveDeviceAuthorization(db, {
      id: row!.id,
      userId,
      orgId,
    });
    expect(approved).toBe(true);

    const claimed = await tokenPost(deviceTokenRequest(deviceCode));
    expect(claimed.status).toBe(200);
    const claimedBody = (await claimed.json()) as Record<string, unknown>;
    expect(claimedBody.status).toBe("approved");
    expect(claimedBody.token).toMatch(/^pcli_[A-Za-z0-9_-]{43}$/);
    expect(claimedBody.refreshToken).toMatch(/^pclr_[A-Za-z0-9_-]{43}$/);
    expect(claimedBody.apiBase).toBe("https://postil.dev/api/inference/v1");
    expect(claimedBody.org).toEqual({
      slug: "cli-login-org",
      name: "CLI Login Org",
    });
    expect(typeof claimedBody.expiresAt).toBe("string");
    expect(typeof claimedBody.refreshExpiresAt).toBe("string");
    expect(
      new Date(claimedBody.refreshExpiresAt as string).getTime(),
    ).toBeGreaterThan(new Date(claimedBody.expiresAt as string).getTime());

    // A device code is redeemable exactly once.
    const replay = await tokenPost(deviceTokenRequest(deviceCode));
    expect(replay.status).toBe(410);
    expect(await replay.json()).toEqual({ status: "expired" });
  });

  test("a denied code reports denial and cannot later be claimed", async () => {
    const {
      denyDeviceAuthorization,
      findDeviceAuthorizationByUserCode,
      normalizeUserCodeInput,
    } = await import("@/lib/cli-auth");
    const { getDb } = await import("@/lib/db");
    const { POST: startPost } =
      await import("@/app/api/cli/device/start/route");
    const { POST: tokenPost } =
      await import("@/app/api/cli/device/token/route");

    const start = await startPost(
      new Request("https://postil.dev/api/cli/device/start", {
        method: "POST",
      }),
    );
    const { deviceCode, userCode } = (await start.json()) as {
      deviceCode: string;
      userCode: string;
    };
    const db = getDb();
    const row = await findDeviceAuthorizationByUserCode(
      db,
      normalizeUserCodeInput(userCode),
    );
    expect(await denyDeviceAuthorization(db, { id: row!.id })).toBe(true);

    const denied = await tokenPost(deviceTokenRequest(deviceCode));
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ status: "denied" });
  });

  test("an approved code cannot be claimed after administrator authority is lost", async () => {
    const {
      approveDeviceAuthorization,
      findDeviceAuthorizationByUserCode,
      normalizeUserCodeInput,
    } = await import("@/lib/cli-auth");
    const { getDb } = await import("@/lib/db");
    const { POST: startPost } =
      await import("@/app/api/cli/device/start/route");
    const { POST: tokenPost } =
      await import("@/app/api/cli/device/token/route");
    const start = await startPost(
      new Request("https://postil.dev/api/cli/device/start", {
        method: "POST",
      }),
    );
    const { deviceCode, userCode } = (await start.json()) as {
      deviceCode: string;
      userCode: string;
    };
    const db = getDb();
    const authorization = await findDeviceAuthorizationByUserCode(
      db,
      normalizeUserCodeInput(userCode),
    );
    expect(
      await approveDeviceAuthorization(db, {
        id: authorization!.id,
        userId,
        orgId,
      }),
    ).toBe(true);
    const tokensBefore = await pool!.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM cli_tokens WHERE user_id = $1 AND org_id = $2`,
      [userId, orgId],
    );
    await pool!.query(
      `UPDATE org_members SET role = 'member' WHERE org_id = $1 AND user_id = $2`,
      [orgId, userId],
    );

    const denied = await tokenPost(deviceTokenRequest(deviceCode));
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ status: "denied" });
    const tokens = await pool!.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM cli_tokens WHERE user_id = $1 AND org_id = $2`,
      [userId, orgId],
    );
    expect(tokens.rows[0]?.count).toBe(tokensBefore.rows[0]?.count);
    await pool!.query(
      `UPDATE org_members SET role = 'admin' WHERE org_id = $1 AND user_id = $2`,
      [orgId, userId],
    );
  });

  test("an expired code returns 410 even though it was approved", async () => {
    const { createDeviceAuthorization } = await import("@/lib/cli-auth");
    const { getDb } = await import("@/lib/db");
    const { POST: tokenPost } =
      await import("@/app/api/cli/device/token/route");

    const db = getDb();
    const longAgo = new Date(Date.now() - 20 * 60 * 1_000);
    const { deviceCode } = await createDeviceAuthorization(db, longAgo);
    const rows = await pool!.query<{ id: string }>(
      `SELECT id FROM cli_device_authorizations WHERE device_code_sha256 = $1`,
      [sha256(deviceCode)],
    );
    const id = Number(rows.rows[0]?.id);
    // approveDeviceAuthorization itself refuses an already-expired row, so
    // force the approval directly to exercise the token endpoint's own
    // expiry check independent of the approval path's.
    await pool!.query(
      `UPDATE cli_device_authorizations SET status = 'approved', user_id = $1, org_id = $2 WHERE id = $3`,
      [userId, orgId, id],
    );

    const expired = await tokenPost(deviceTokenRequest(deviceCode));
    expect(expired.status).toBe(410);
    expect(await expired.json()).toEqual({ status: "expired" });
  });

  test("polling past 200 attempts returns 410", async () => {
    const { createDeviceAuthorization } = await import("@/lib/cli-auth");
    const { getDb } = await import("@/lib/db");
    const { POST: tokenPost } =
      await import("@/app/api/cli/device/token/route");

    const db = getDb();
    const { deviceCode } = await createDeviceAuthorization(db);
    await pool!.query(
      `UPDATE cli_device_authorizations SET poll_count = 200 WHERE device_code_sha256 = $1`,
      [sha256(deviceCode)],
    );

    const overCap = await tokenPost(deviceTokenRequest(deviceCode));
    expect(overCap.status).toBe(410);
    expect(await overCap.json()).toEqual({ status: "expired" });
  });

  test("logout revokes the token and is idempotent", async () => {
    const {
      approveDeviceAuthorization,
      findDeviceAuthorizationByUserCode,
      normalizeUserCodeInput,
    } = await import("@/lib/cli-auth");
    const { getDb } = await import("@/lib/db");
    const { POST: startPost } =
      await import("@/app/api/cli/device/start/route");
    const { POST: tokenPost } =
      await import("@/app/api/cli/device/token/route");
    const { POST: logoutPost } = await import("@/app/api/cli/logout/route");

    const start = await startPost(
      new Request("https://postil.dev/api/cli/device/start", {
        method: "POST",
      }),
    );
    const { deviceCode, userCode } = (await start.json()) as {
      deviceCode: string;
      userCode: string;
    };
    const db = getDb();
    const row = await findDeviceAuthorizationByUserCode(
      db,
      normalizeUserCodeInput(userCode),
    );
    await approveDeviceAuthorization(db, { id: row!.id, userId, orgId });
    const claimed = await tokenPost(deviceTokenRequest(deviceCode));
    const { token } = (await claimed.json()) as { token: string };

    const first = await logoutPost(logoutRequest(token));
    expect(first.status).toBe(204);
    const revoked = await pool!.query<{ revoked_at: string | null }>(
      `SELECT revoked_at FROM cli_tokens WHERE token_sha256 = $1`,
      [sha256(token)],
    );
    expect(revoked.rows).toHaveLength(1);
    expect(revoked.rows[0]?.revoked_at).not.toBeNull();

    // Idempotent: logging out an already-revoked token still returns 204.
    const second = await logoutPost(logoutRequest(token));
    expect(second.status).toBe(204);

    const missingAuth = await logoutPost(
      new Request("https://postil.dev/api/cli/logout", { method: "POST" }),
    );
    expect(missingAuth.status).toBe(401);
  });

  test("refresh rotates credentials, recovers the committed replacement, and revokes later replay", async () => {
    const {
      refreshCliSession,
      CLI_REFRESH_REPLAY_GRACE_MS,
      CLI_REFRESH_SESSION_TTL_MS,
    } = await import("@/lib/cli-auth");
    const { getDb } = await import("@/lib/db");
    const credentials = await mintApprovedCredentials();
    const now = new Date();

    const refreshed = await refreshCliSession(
      getDb(),
      credentials.refreshToken,
      now,
    );
    expect(refreshed.status).toBe("approved");
    if (refreshed.status !== "approved")
      throw new Error("refresh fixture did not mint credentials");
    expect(refreshed.token).toMatch(/^pcli_[A-Za-z0-9_-]{43}$/);
    expect(refreshed.refreshToken).toMatch(/^pclr_[A-Za-z0-9_-]{43}$/);
    expect(refreshed.token).not.toBe(credentials.token);
    expect(refreshed.refreshToken).not.toBe(credentials.refreshToken);
    expect(refreshed.refreshExpiresAt.getTime()).toBe(
      now.getTime() + CLI_REFRESH_SESSION_TTL_MS,
    );

    const session = await pool!.query<{
      expires_at: Date;
      consumed_at: Date | null;
    }>(
      `SELECT session.expires_at, original.consumed_at
       FROM cli_refresh_sessions session
       JOIN cli_refresh_tokens original ON original.session_id = session.id
       WHERE original.token_sha256 = $1`,
      [sha256(credentials.refreshToken)],
    );
    expect(session.rows[0]?.expires_at.getTime()).toBe(
      refreshed.refreshExpiresAt.getTime(),
    );
    expect(session.rows[0]?.consumed_at).not.toBeNull();

    const replay = await refreshCliSession(
      getDb(),
      credentials.refreshToken,
      now,
    );
    expect(replay).toEqual(refreshed);
    const concurrentState = await pool!.query<{
      revoked_at: Date | null;
      active_tokens: string;
    }>(
      `SELECT session.revoked_at,
              count(token.id) FILTER (WHERE token.revoked_at IS NULL)::text AS active_tokens
       FROM cli_refresh_sessions session
       LEFT JOIN cli_tokens token ON token.refresh_session_id = session.id
       JOIN cli_refresh_tokens original ON original.session_id = session.id
       WHERE original.token_sha256 = $1
       GROUP BY session.id`,
      [sha256(credentials.refreshToken)],
    );
    expect(concurrentState.rows[0]?.revoked_at).toBeNull();
    expect(concurrentState.rows[0]?.active_tokens).toBe("2");

    const laterReplay = await refreshCliSession(
      getDb(),
      credentials.refreshToken,
      new Date(now.getTime() + CLI_REFRESH_REPLAY_GRACE_MS + 1),
    );
    expect(laterReplay).toEqual({ status: "invalid" });
    const revoked = await pool!.query<{
      revoked_at: Date | null;
      active_tokens: string;
    }>(
      `SELECT session.revoked_at,
              count(token.id) FILTER (WHERE token.revoked_at IS NULL)::text AS active_tokens
       FROM cli_refresh_sessions session
       LEFT JOIN cli_tokens token ON token.refresh_session_id = session.id
       JOIN cli_refresh_tokens original ON original.session_id = session.id
       WHERE original.token_sha256 = $1
       GROUP BY session.id`,
      [sha256(credentials.refreshToken)],
    );
    expect(revoked.rows[0]?.revoked_at).not.toBeNull();
    expect(revoked.rows[0]?.active_tokens).toBe("0");
  });

  test("expired and revoked refresh sessions cannot mint replacement credentials", async () => {
    const { refreshCliSession } = await import("@/lib/cli-auth");
    const { getDb } = await import("@/lib/db");
    const expired = await mintApprovedCredentials();
    await pool!.query(
      `UPDATE cli_refresh_sessions session
       SET created_at = now() - interval '2 seconds',
           expires_at = now() - interval '1 second'
       FROM cli_refresh_tokens refresh
       WHERE refresh.session_id = session.id AND refresh.token_sha256 = $1`,
      [sha256(expired.refreshToken)],
    );
    expect(await refreshCliSession(getDb(), expired.refreshToken)).toEqual({
      status: "invalid",
    });

    const revoked = await mintApprovedCredentials();
    await pool!.query(
      `UPDATE cli_refresh_sessions session
       SET revoked_at = now()
       FROM cli_refresh_tokens refresh
       WHERE refresh.session_id = session.id AND refresh.token_sha256 = $1`,
      [sha256(revoked.refreshToken)],
    );
    expect(await refreshCliSession(getDb(), revoked.refreshToken)).toEqual({
      status: "invalid",
    });
  });

  test("a removed or demoted administrator loses the entire refresh family", async () => {
    const { refreshCliSession, resolveCliToken } =
      await import("@/lib/cli-auth");
    const { getDb } = await import("@/lib/db");
    const credentials = await mintApprovedCredentials();
    await pool!.query(
      `UPDATE org_members SET role = 'member' WHERE org_id = $1 AND user_id = $2`,
      [orgId, userId],
    );

    expect(await resolveCliToken(getDb(), credentials.token)).toBeNull();
    const revoked = await pool!.query<{
      revoked_at: Date | null;
      active_tokens: string;
    }>(
      `SELECT session.revoked_at,
              count(token.id) FILTER (WHERE token.revoked_at IS NULL)::text AS active_tokens
       FROM cli_refresh_sessions session
       LEFT JOIN cli_tokens token ON token.refresh_session_id = session.id
       JOIN cli_refresh_tokens refresh ON refresh.session_id = session.id
       WHERE refresh.token_sha256 = $1
       GROUP BY session.id`,
      [sha256(credentials.refreshToken)],
    );
    expect(revoked.rows[0]?.revoked_at).not.toBeNull();
    expect(revoked.rows[0]?.active_tokens).toBe("0");
    expect(await refreshCliSession(getDb(), credentials.refreshToken)).toEqual({
      status: "invalid",
    });

    await pool!.query(
      `UPDATE org_members SET role = 'admin' WHERE org_id = $1 AND user_id = $2`,
      [orgId, userId],
    );

    const removed = await mintApprovedCredentials();
    await pool!.query(
      `DELETE FROM org_members WHERE org_id = $1 AND user_id = $2`,
      [orgId, userId],
    );
    expect(await refreshCliSession(getDb(), removed.refreshToken)).toEqual({
      status: "invalid",
    });
    const removedFamily = await pool!.query<{ revoked_at: Date | null }>(
      `SELECT session.revoked_at
       FROM cli_refresh_sessions session
       JOIN cli_refresh_tokens refresh ON refresh.session_id = session.id
       WHERE refresh.token_sha256 = $1`,
      [sha256(removed.refreshToken)],
    );
    expect(removedFamily.rows[0]?.revoked_at).not.toBeNull();
    await pool!.query(
      `INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'admin')`,
      [orgId, userId],
    );
  });

  test("bearer resolution revokes families with expired or revoked sessions", async () => {
    const { resolveCliToken } = await import("@/lib/cli-auth");
    const { getDb } = await import("@/lib/db");

    const expired = await mintApprovedCredentials();
    await pool!.query(
      `UPDATE cli_refresh_sessions session
       SET created_at = now() - interval '2 seconds',
           expires_at = now() - interval '1 second'
       FROM cli_refresh_tokens refresh
       WHERE refresh.session_id = session.id AND refresh.token_sha256 = $1`,
      [sha256(expired.refreshToken)],
    );
    expect(await resolveCliToken(getDb(), expired.token)).toBeNull();
    const expiredState = await pool!.query<{
      session_revoked_at: Date | null;
      token_revoked_at: Date | null;
    }>(
      `SELECT session.revoked_at AS session_revoked_at,
              token.revoked_at AS token_revoked_at
       FROM cli_refresh_sessions session
       JOIN cli_refresh_tokens refresh ON refresh.session_id = session.id
       JOIN cli_tokens token ON token.refresh_session_id = session.id
       WHERE refresh.token_sha256 = $1 AND token.token_sha256 = $2`,
      [sha256(expired.refreshToken), sha256(expired.token)],
    );
    expect(expiredState.rows).toHaveLength(1);
    expect(expiredState.rows[0]?.session_revoked_at).not.toBeNull();
    expect(expiredState.rows[0]?.token_revoked_at).not.toBeNull();

    const revoked = await mintApprovedCredentials();
    await pool!.query(
      `UPDATE cli_refresh_sessions session
       SET revoked_at = now()
       FROM cli_refresh_tokens refresh
       WHERE refresh.session_id = session.id AND refresh.token_sha256 = $1`,
      [sha256(revoked.refreshToken)],
    );
    expect(await resolveCliToken(getDb(), revoked.token)).toBeNull();
    const revokedAccess = await pool!.query<{ revoked_at: Date | null }>(
      `SELECT revoked_at FROM cli_tokens WHERE token_sha256 = $1`,
      [sha256(revoked.token)],
    );
    expect(revokedAccess.rows).toHaveLength(1);
    expect(revokedAccess.rows[0]?.revoked_at).not.toBeNull();
  });

  test("logout revokes a refresh family while legacy tokens remain individually revocable", async () => {
    const { refreshCliSession } = await import("@/lib/cli-auth");
    const { getDb } = await import("@/lib/db");
    const { POST: logoutPost } = await import("@/app/api/cli/logout/route");
    const credentials = await mintApprovedCredentials();
    const refreshed = await refreshCliSession(
      getDb(),
      credentials.refreshToken,
    );
    expect(refreshed.status).toBe("approved");
    if (refreshed.status !== "approved")
      throw new Error("refresh fixture did not mint credentials");

    const familyLogout = await logoutPost(logoutRequest(credentials.token));
    expect(familyLogout.status).toBe(204);
    const family = await pool!.query<{
      revoked_at: Date | null;
      active_tokens: string;
    }>(
      `SELECT session.revoked_at,
              count(token.id) FILTER (WHERE token.revoked_at IS NULL)::text AS active_tokens
       FROM cli_refresh_sessions session
       LEFT JOIN cli_tokens token ON token.refresh_session_id = session.id
       JOIN cli_refresh_tokens refresh ON refresh.session_id = session.id
       WHERE refresh.token_sha256 = $1
       GROUP BY session.id`,
      [sha256(refreshed.refreshToken)],
    );
    expect(family.rows[0]?.revoked_at).not.toBeNull();
    expect(family.rows[0]?.active_tokens).toBe("0");
    expect(await refreshCliSession(getDb(), refreshed.refreshToken)).toEqual({
      status: "invalid",
    });

    const legacyToken = `pcli_${Buffer.from(`legacy-${Math.random()}`).toString("base64url").padEnd(43, "a").slice(0, 43)}`;
    await pool!.query(
      `INSERT INTO cli_tokens (token_sha256, user_id, org_id, scope, expires_at)
       VALUES ($1, $2, $3, 'inference', now() + interval '12 hours')`,
      [sha256(legacyToken), userId, orgId],
    );
    const legacyLogout = await logoutPost(logoutRequest(legacyToken));
    expect(legacyLogout.status).toBe(204);
    const legacy = await pool!.query<{
      revoked_at: Date | null;
      refresh_session_id: string | null;
    }>(
      `SELECT revoked_at, refresh_session_id FROM cli_tokens WHERE token_sha256 = $1`,
      [sha256(legacyToken)],
    );
    expect(legacy.rows[0]).toEqual({
      revoked_at: expect.any(Date),
      refresh_session_id: null,
    });
  });

  async function mintApprovedCredentials(): Promise<{
    token: string;
    refreshToken: string;
  }> {
    const {
      approveDeviceAuthorization,
      findDeviceAuthorizationByUserCode,
      normalizeUserCodeInput,
    } = await import("@/lib/cli-auth");
    const { getDb } = await import("@/lib/db");
    const { POST: startPost } =
      await import("@/app/api/cli/device/start/route");
    const { POST: tokenPost } =
      await import("@/app/api/cli/device/token/route");
    const start = await startPost(
      new Request("https://postil.dev/api/cli/device/start", {
        method: "POST",
      }),
    );
    const { deviceCode, userCode } = (await start.json()) as {
      deviceCode: string;
      userCode: string;
    };
    const row = await findDeviceAuthorizationByUserCode(
      getDb(),
      normalizeUserCodeInput(userCode),
    );
    expect(
      await approveDeviceAuthorization(getDb(), { id: row!.id, userId, orgId }),
    ).toBe(true);
    const claimed = await tokenPost(deviceTokenRequest(deviceCode));
    expect(claimed.status).toBe(200);
    const body = (await claimed.json()) as {
      token: string;
      refreshToken: string;
    };
    return body;
  }
});

function deviceTokenRequest(deviceCode: string): Request {
  return new Request("https://postil.dev/api/cli/device/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceCode }),
  });
}

function logoutRequest(token: string): Request {
  return new Request("https://postil.dev/api/cli/logout", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
}
