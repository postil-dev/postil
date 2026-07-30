import { createHash, randomBytes } from "node:crypto";

import { and, eq, gt, isNull, sql } from "drizzle-orm";

import { type Database, schema } from "@/lib/db";

/**
 * `postil login` device authorization and the CLI bearer token it mints.
 *
 * Modelled on RFC 8628 but deliberately minimal: the CLI never runs a
 * localhost callback (it works over SSH and in containers), so it polls
 * `/api/cli/device/token` while the operator approves the request in a
 * browser at `/cli/authorize`. Every secret here (device code, CLI token) is
 * looked up by SHA-256 digest; the raw value exists only in the HTTP
 * response that mints it and is never stored, logged, or echoed back.
 */

export const CLI_TOKEN_PREFIX = "pcli_";
export const CLI_TOKEN_SCOPE = "inference" as const;
export const CLI_TOKEN_TTL_MS = 12 * 60 * 60 * 1_000;
const CLI_TOKEN_RANDOM_BYTES = 32;
const CLI_TOKEN_PATTERN = /^pcli_[A-Za-z0-9_-]{43}$/;

export const DEVICE_AUTHORIZATION_TTL_MS = 10 * 60 * 1_000;
export const DEVICE_AUTHORIZATION_POLL_INTERVAL_SECONDS = 5;
export const DEVICE_AUTHORIZATION_MAX_POLLS = 200;
const DEVICE_CODE_RANDOM_BYTES = 32;
const DEVICE_AUTHORIZATION_CODE_ATTEMPTS = 5;

// Unambiguous alphabet (no I, O, 0, 1) so a user reading the code aloud or
// typing it by hand cannot confuse a letter for a digit. Exactly 32 entries:
// each random byte selects one via its low 5 bits with no modulo bias.
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const USER_CODE_LENGTH = 8;

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

/** Raised inside the claim transaction to abort a losing concurrent claim. */
class ConcurrentClaimError extends Error {}

function generateRawUserCode(): string {
  const bytes = randomBytes(USER_CODE_LENGTH);
  let code = "";
  for (const byte of bytes) code += USER_CODE_ALPHABET[byte & 0x1f];
  return code;
}

/** `WDJF3K9Q` -> `WDJF-3K9Q`, matching the code shown to the operator. */
export function formatUserCode(rawUserCode: string): string {
  return `${rawUserCode.slice(0, 4)}-${rawUserCode.slice(4)}`;
}

/** Undo `formatUserCode` and tolerate hand-typed casing and stray whitespace. */
export function normalizeUserCodeInput(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

/** Extract and validate the CLI bearer token from an Authorization header. */
export function bearerCliToken(authHeader: string | null): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice("Bearer ".length).trim();
  return CLI_TOKEN_PATTERN.test(token) ? token : null;
}

function mintCliTokenString(): string {
  return `${CLI_TOKEN_PREFIX}${randomBytes(CLI_TOKEN_RANDOM_BYTES).toString("base64url")}`;
}

export interface DeviceAuthorizationStart {
  deviceCode: string;
  userCode: string;
  expiresAt: Date;
}

/** Create a new pending device authorization; retries on a rare code collision. */
export async function createDeviceAuthorization(
  db: Database,
  now = new Date(),
): Promise<DeviceAuthorizationStart> {
  const expiresAt = new Date(now.getTime() + DEVICE_AUTHORIZATION_TTL_MS);
  for (let attempt = 0; attempt < DEVICE_AUTHORIZATION_CODE_ATTEMPTS; attempt++) {
    const deviceCode = randomBytes(DEVICE_CODE_RANDOM_BYTES).toString("base64url");
    const rawUserCode = generateRawUserCode();
    try {
      const inserted = await db
        .insert(schema.cliDeviceAuthorizations)
        .values({
          deviceCodeSha256: sha256(deviceCode),
          userCode: rawUserCode,
          status: "pending",
          expiresAt,
        })
        .onConflictDoNothing()
        .returning({ id: schema.cliDeviceAuthorizations.id });
      if (inserted.length === 0) continue;
      return { deviceCode, userCode: formatUserCode(rawUserCode), expiresAt };
    } catch (error) {
      if (isUniqueConstraintError(error)) continue;
      throw error;
    }
  }
  throw new Error("could not allocate a unique CLI device authorization code");
}

export interface DeviceAuthorizationRow {
  id: number;
  status: string;
  expiresAt: Date;
  orgId: number | null;
}

/** Look up a device authorization for the `/cli/authorize` confirmation page. */
export async function findDeviceAuthorizationByUserCode(
  db: Database,
  normalizedUserCode: string,
): Promise<DeviceAuthorizationRow | null> {
  if (normalizedUserCode.length !== USER_CODE_LENGTH) return null;
  const rows = await db
    .select({
      id: schema.cliDeviceAuthorizations.id,
      status: schema.cliDeviceAuthorizations.status,
      expiresAt: schema.cliDeviceAuthorizations.expiresAt,
      orgId: schema.cliDeviceAuthorizations.orgId,
    })
    .from(schema.cliDeviceAuthorizations)
    .where(eq(schema.cliDeviceAuthorizations.userCode, normalizedUserCode))
    .limit(1);
  return rows[0] ?? null;
}

/** Approve a still-pending, unexpired device authorization for one organization. */
export async function approveDeviceAuthorization(
  db: Database,
  input: { id: number; userId: number; orgId: number; now?: Date },
): Promise<boolean> {
  const now = input.now ?? new Date();
  const updated = await db
    .update(schema.cliDeviceAuthorizations)
    .set({
      status: "approved",
      userId: input.userId,
      orgId: input.orgId,
      approvedAt: now,
    })
    .where(
      and(
        eq(schema.cliDeviceAuthorizations.id, input.id),
        eq(schema.cliDeviceAuthorizations.status, "pending"),
        gt(schema.cliDeviceAuthorizations.expiresAt, now),
      ),
    )
    .returning({ id: schema.cliDeviceAuthorizations.id });
  return updated.length === 1;
}

/** Deny a still-pending device authorization. */
export async function denyDeviceAuthorization(
  db: Database,
  input: { id: number; now?: Date },
): Promise<boolean> {
  const now = input.now ?? new Date();
  const updated = await db
    .update(schema.cliDeviceAuthorizations)
    .set({ status: "denied" })
    .where(
      and(
        eq(schema.cliDeviceAuthorizations.id, input.id),
        eq(schema.cliDeviceAuthorizations.status, "pending"),
        gt(schema.cliDeviceAuthorizations.expiresAt, now),
      ),
    )
    .returning({ id: schema.cliDeviceAuthorizations.id });
  return updated.length === 1;
}

export type ClaimDeviceAuthorizationTokenResult =
  | { status: "pending" }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "approved"; token: string; expiresAt: Date; userId: number; orgId: number };

/**
 * Redeem a device code exactly once. The initial `poll_count` update takes
 * Postgres's row lock, so a concurrent claim blocks on it and observes the
 * already-`claimed` status once this transaction commits - no advisory lock
 * is needed. Polling is capped so a client that ignores `interval` cannot
 * hammer this endpoint indefinitely.
 */
export async function claimDeviceAuthorizationToken(
  db: Database,
  deviceCode: string,
  now = new Date(),
): Promise<ClaimDeviceAuthorizationTokenResult> {
  const digest = sha256(deviceCode);
  try {
    return await db.transaction(async (tx) => {
      const rows = await tx
        .update(schema.cliDeviceAuthorizations)
        .set({ pollCount: sql`${schema.cliDeviceAuthorizations.pollCount} + 1` })
        .where(eq(schema.cliDeviceAuthorizations.deviceCodeSha256, digest))
        .returning({
          id: schema.cliDeviceAuthorizations.id,
          status: schema.cliDeviceAuthorizations.status,
          expiresAt: schema.cliDeviceAuthorizations.expiresAt,
          userId: schema.cliDeviceAuthorizations.userId,
          orgId: schema.cliDeviceAuthorizations.orgId,
          pollCount: schema.cliDeviceAuthorizations.pollCount,
        });
      const row = rows[0];
      if (!row) return { status: "expired" } as const;
      if (row.expiresAt <= now) return { status: "expired" } as const;
      if (row.pollCount > DEVICE_AUTHORIZATION_MAX_POLLS) return { status: "expired" } as const;
      if (row.status === "denied") return { status: "denied" } as const;
      if (row.status === "pending") return { status: "pending" } as const;
      if (row.status !== "approved" || row.userId === null || row.orgId === null) {
        // Already claimed, or an inconsistent approved row missing its
        // grantee - either way this device code cannot be redeemed again.
        return { status: "expired" } as const;
      }

      const token = mintCliTokenString();
      const expiresAt = new Date(now.getTime() + CLI_TOKEN_TTL_MS);
      const inserted = await tx
        .insert(schema.cliTokens)
        .values({
          tokenSha256: sha256(token),
          userId: row.userId,
          orgId: row.orgId,
          scope: CLI_TOKEN_SCOPE,
          expiresAt,
        })
        .returning({ id: schema.cliTokens.id });
      const tokenId = inserted[0]?.id;
      if (!tokenId) throw new Error("cli token insert returned no row");

      const claimed = await tx
        .update(schema.cliDeviceAuthorizations)
        .set({ status: "claimed", tokenId })
        .where(
          and(
            eq(schema.cliDeviceAuthorizations.id, row.id),
            eq(schema.cliDeviceAuthorizations.status, "approved"),
          ),
        )
        .returning({ id: schema.cliDeviceAuthorizations.id });
      if (claimed.length !== 1) throw new ConcurrentClaimError();

      return { status: "approved", token, expiresAt, userId: row.userId, orgId: row.orgId } as const;
    });
  } catch (error) {
    if (error instanceof ConcurrentClaimError) return { status: "expired" };
    throw error;
  }
}

export interface ResolvedCliToken {
  id: number;
  userId: number;
  orgId: number;
}

/** Resolve a bearer CLI token to its grantee. Lookup is by digest only. */
export async function resolveCliToken(
  db: Database,
  token: string,
  now = new Date(),
): Promise<ResolvedCliToken | null> {
  const rows = await db
    .select({
      id: schema.cliTokens.id,
      userId: schema.cliTokens.userId,
      orgId: schema.cliTokens.orgId,
    })
    .from(schema.cliTokens)
    .where(
      and(
        eq(schema.cliTokens.tokenSha256, sha256(token)),
        isNull(schema.cliTokens.revokedAt),
        gt(schema.cliTokens.expiresAt, now),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Best-effort activity stamp; a failure here must never fail the gateway request. */
export async function touchCliTokenLastUsed(
  db: Database,
  tokenId: number,
  now = new Date(),
): Promise<void> {
  try {
    await db
      .update(schema.cliTokens)
      .set({ lastUsedAt: now })
      .where(eq(schema.cliTokens.id, tokenId));
  } catch (error) {
    console.warn("cli token last-used update failed", error);
  }
}

/** Revoke a CLI token. Idempotent: revoking an already-revoked token is a no-op. */
export async function revokeCliToken(
  db: Database,
  tokenId: number,
  now = new Date(),
): Promise<void> {
  await db
    .update(schema.cliTokens)
    .set({ revokedAt: now })
    .where(and(eq(schema.cliTokens.id, tokenId), isNull(schema.cliTokens.revokedAt)));
}
