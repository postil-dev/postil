import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { Client, Pool } from "pg";

import {
  createUnmigratedEphemeralDatabase,
  type EphemeralDatabase,
} from "./ephemeral-database";
import { closeDb } from "@/lib/db";

// Mirrors the private sha256() helper in src/lib/cli-auth.ts: tokens and
// device codes are looked up by digest only, so tests reaching into the
// database directly must hash the same way the library does.
function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

const TEST_URL = process.env.POSTIL_TEST_DATABASE_URL;
const describeDb = TEST_URL ? describe : describe.skip;
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

describeDb("postil login device authorization", () => {
  let database: EphemeralDatabase;
  let pool: Pool | undefined;
  let userId = 0;
  let orgId = 0;

  beforeAll(async () => {
    database = await createUnmigratedEphemeralDatabase("cli_device_auth", {
      forceDrop: true,
      maxConnections: 4,
    });
    const migrationClient = new Client({ connectionString: database.url });
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
    await migrationClient.end();

    await closeDb();
    // getDb() is a lazy singleton keyed off DATABASE_URL at first call, so
    // pointing it at this scratch database before any route module is
    // imported makes every route under test talk to this database.
    process.env.DATABASE_URL = database.url;
    pool = database.pool;
  }, 30_000);

  afterAll(async () => {
    await closeDb();
    await database?.drop();
    restoreDatabaseUrl();
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
    const { approveDeviceAuthorization, findDeviceAuthorizationByUserCode, normalizeUserCodeInput } =
      await import("@/lib/cli-auth");
    const { getDb } = await import("@/lib/db");
    const { POST: startPost } = await import("@/app/api/cli/device/start/route");
    const { POST: tokenPost } = await import("@/app/api/cli/device/token/route");

    const start = await startPost(
      new Request("https://postil.dev/api/cli/device/start", { method: "POST" }),
    );
    const { deviceCode, userCode } = (await start.json()) as {
      deviceCode: string;
      userCode: string;
    };

    const pending = await tokenPost(deviceTokenRequest(deviceCode));
    expect(pending.status).toBe(428);
    expect(await pending.json()).toEqual({ status: "pending" });

    const db = getDb();
    const row = await findDeviceAuthorizationByUserCode(db, normalizeUserCodeInput(userCode));
    expect(row).not.toBeNull();
    const approved = await approveDeviceAuthorization(db, { id: row!.id, userId, orgId });
    expect(approved).toBe(true);

    const claimed = await tokenPost(deviceTokenRequest(deviceCode));
    expect(claimed.status).toBe(200);
    const claimedBody = (await claimed.json()) as Record<string, unknown>;
    expect(claimedBody.status).toBe("approved");
    expect(claimedBody.token).toMatch(/^pcli_[A-Za-z0-9_-]{43}$/);
    expect(claimedBody.apiBase).toBe("https://postil.dev/api/inference/v1");
    expect(claimedBody.org).toEqual({ slug: "cli-login-org", name: "CLI Login Org" });
    expect(typeof claimedBody.expiresAt).toBe("string");

    // A device code is redeemable exactly once.
    const replay = await tokenPost(deviceTokenRequest(deviceCode));
    expect(replay.status).toBe(410);
    expect(await replay.json()).toEqual({ status: "expired" });
  });

  test("a denied code reports denial and cannot later be claimed", async () => {
    const { denyDeviceAuthorization, findDeviceAuthorizationByUserCode, normalizeUserCodeInput } =
      await import("@/lib/cli-auth");
    const { getDb } = await import("@/lib/db");
    const { POST: startPost } = await import("@/app/api/cli/device/start/route");
    const { POST: tokenPost } = await import("@/app/api/cli/device/token/route");

    const start = await startPost(
      new Request("https://postil.dev/api/cli/device/start", { method: "POST" }),
    );
    const { deviceCode, userCode } = (await start.json()) as {
      deviceCode: string;
      userCode: string;
    };
    const db = getDb();
    const row = await findDeviceAuthorizationByUserCode(db, normalizeUserCodeInput(userCode));
    expect(await denyDeviceAuthorization(db, { id: row!.id })).toBe(true);

    const denied = await tokenPost(deviceTokenRequest(deviceCode));
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ status: "denied" });
  });

  test("an expired code returns 410 even though it was approved", async () => {
    const { createDeviceAuthorization } = await import("@/lib/cli-auth");
    const { getDb } = await import("@/lib/db");
    const { POST: tokenPost } = await import("@/app/api/cli/device/token/route");

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
    const { POST: tokenPost } = await import("@/app/api/cli/device/token/route");

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
    const { approveDeviceAuthorization, findDeviceAuthorizationByUserCode, normalizeUserCodeInput } =
      await import("@/lib/cli-auth");
    const { getDb } = await import("@/lib/db");
    const { POST: startPost } = await import("@/app/api/cli/device/start/route");
    const { POST: tokenPost } = await import("@/app/api/cli/device/token/route");
    const { POST: logoutPost } = await import("@/app/api/cli/logout/route");

    const start = await startPost(
      new Request("https://postil.dev/api/cli/device/start", { method: "POST" }),
    );
    const { deviceCode, userCode } = (await start.json()) as {
      deviceCode: string;
      userCode: string;
    };
    const db = getDb();
    const row = await findDeviceAuthorizationByUserCode(db, normalizeUserCodeInput(userCode));
    await approveDeviceAuthorization(db, { id: row!.id, userId, orgId });
    const claimed = await tokenPost(deviceTokenRequest(deviceCode));
    const { token } = (await claimed.json()) as { token: string };

    const first = await logoutPost(logoutRequest(token));
    expect(first.status).toBe(204);
    const revoked = await pool!.query<{ revoked_at: string | null }>(
      `SELECT revoked_at FROM cli_tokens WHERE token_sha256 = $1`,
      [sha256(token)],
    );
    expect(revoked.rows[0]?.revoked_at).not.toBeNull();

    // Idempotent: logging out an already-revoked token still returns 204.
    const second = await logoutPost(logoutRequest(token));
    expect(second.status).toBe(204);

    const missingAuth = await logoutPost(
      new Request("https://postil.dev/api/cli/logout", { method: "POST" }),
    );
    expect(missingAuth.status).toBe(401);
  });
});

function restoreDatabaseUrl(): void {
  if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
}

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
