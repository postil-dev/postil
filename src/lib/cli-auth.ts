import { createHash, createHmac, hkdfSync, randomBytes } from "node:crypto";

import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";

import { getSealingKey } from "@/lib/crypto/seal";
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
export const CLI_REFRESH_TOKEN_PREFIX = "pclr_";
export const CLI_REFRESH_SESSION_TTL_MS = 180 * 24 * 60 * 60 * 1_000;
export const CLI_JSON_BODY_MAX_BYTES = 4 * 1_024;
const CLI_TOKEN_RANDOM_BYTES = 32;
const CLI_TOKEN_PATTERN = /^pcli_[A-Za-z0-9_-]{43}$/;
const CLI_REFRESH_TOKEN_PATTERN = /^pclr_[A-Za-z0-9_-]{43}$/;

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
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
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

/** Validate a raw CLI refresh token without retaining or logging it. */
export function isCliRefreshToken(value: unknown): value is string {
  return typeof value === "string" && CLI_REFRESH_TOKEN_PATTERN.test(value);
}

function mintCliTokenString(): string {
  return `${CLI_TOKEN_PREFIX}${randomBytes(CLI_TOKEN_RANDOM_BYTES).toString("base64url")}`;
}

function mintCliRefreshTokenString(): string {
  return `${CLI_REFRESH_TOKEN_PREFIX}${randomBytes(CLI_TOKEN_RANDOM_BYTES).toString("base64url")}`;
}

function deriveRotatedCliToken(
  consumedRefreshDigest: Buffer,
  kind: "access" | "refresh",
): string {
  const derivationKey = Buffer.from(
    hkdfSync(
      "sha256",
      getSealingKey(),
      "postil-cli-refresh-v1",
      "token-derivation",
      32,
    ),
  );
  const bytes = createHmac("sha256", derivationKey)
    .update("postil-cli-refresh-rotation-v1\0", "utf8")
    .update(kind, "utf8")
    .update("\0", "utf8")
    .update(consumedRefreshDigest)
    .digest();
  const prefix =
    kind === "access" ? CLI_TOKEN_PREFIX : CLI_REFRESH_TOKEN_PREFIX;
  return `${prefix}${bytes.toString("base64url")}`;
}

export type CliJsonBodyReadResult =
  { ok: true; body: unknown | null } | { ok: false; status: 400 | 413 };

/**
 * Read the small JSON credential bodies without trusting Content-Length or
 * buffering an unbounded stream. An empty body is distinct from malformed JSON
 * so legacy authorization-only logout requests remain valid.
 */
export async function readCliJsonBody(
  request: Request,
  maxBytes = CLI_JSON_BODY_MAX_BYTES,
): Promise<CliJsonBodyReadResult> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("CLI JSON body limit must be a positive safe integer");
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/u.test(contentLength)) return { ok: false, status: 400 };
    const declaredBytes = Number(contentLength);
    if (!Number.isSafeInteger(declaredBytes)) return { ok: false, status: 400 };
    if (declaredBytes > maxBytes) return { ok: false, status: 413 };
  }
  if (!request.body) return { ok: true, body: null };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytesRead += chunk.value.byteLength;
      if (bytesRead > maxBytes) {
        await reader.cancel();
        return { ok: false, status: 413 };
      }
      chunks.push(chunk.value);
    }
    if (bytesRead === 0) return { ok: true, body: null };
    return {
      ok: true,
      body: JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          Buffer.concat(chunks, bytesRead),
        ),
      ),
    };
  } catch {
    return { ok: false, status: 400 };
  } finally {
    reader.releaseLock();
  }
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
  for (
    let attempt = 0;
    attempt < DEVICE_AUTHORIZATION_CODE_ATTEMPTS;
    attempt++
  ) {
    const deviceCode = randomBytes(DEVICE_CODE_RANDOM_BYTES).toString(
      "base64url",
    );
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
  | {
      status: "approved";
      token: string;
      expiresAt: Date;
      refreshToken: string;
      refreshExpiresAt: Date;
      userId: number;
      orgId: number;
    };

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
        .set({
          pollCount: sql`${schema.cliDeviceAuthorizations.pollCount} + 1`,
        })
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
      if (row.pollCount > DEVICE_AUTHORIZATION_MAX_POLLS)
        return { status: "expired" } as const;
      if (row.status === "denied") return { status: "denied" } as const;
      if (row.status === "pending") return { status: "pending" } as const;
      if (
        row.status !== "approved" ||
        row.userId === null ||
        row.orgId === null
      ) {
        // Already claimed, or an inconsistent approved row missing its
        // grantee - either way this device code cannot be redeemed again.
        return { status: "expired" } as const;
      }

      const activeAdmin = await tx
        .select({ userId: schema.orgMembers.userId })
        .from(schema.orgMembers)
        .where(
          and(
            eq(schema.orgMembers.orgId, row.orgId),
            eq(schema.orgMembers.userId, row.userId),
            eq(schema.orgMembers.role, "admin"),
          ),
        )
        .limit(1);
      if (!activeAdmin[0]) {
        await tx
          .update(schema.cliDeviceAuthorizations)
          .set({ status: "denied" })
          .where(
            and(
              eq(schema.cliDeviceAuthorizations.id, row.id),
              eq(schema.cliDeviceAuthorizations.status, "approved"),
            ),
          );
        return { status: "denied" } as const;
      }

      const token = mintCliTokenString();
      const expiresAt = new Date(now.getTime() + CLI_TOKEN_TTL_MS);
      const refreshToken = mintCliRefreshTokenString();
      const refreshExpiresAt = new Date(
        now.getTime() + CLI_REFRESH_SESSION_TTL_MS,
      );
      const session = await tx
        .insert(schema.cliRefreshSessions)
        .values({
          userId: row.userId,
          orgId: row.orgId,
          expiresAt: refreshExpiresAt,
          lastUsedAt: now,
        })
        .returning({ id: schema.cliRefreshSessions.id });
      const refreshSessionId = session[0]?.id;
      if (!refreshSessionId)
        throw new Error("CLI refresh session insert returned no row");
      const inserted = await tx
        .insert(schema.cliTokens)
        .values({
          tokenSha256: sha256(token),
          userId: row.userId,
          orgId: row.orgId,
          scope: CLI_TOKEN_SCOPE,
          expiresAt,
          refreshSessionId,
        })
        .returning({ id: schema.cliTokens.id });
      const tokenId = inserted[0]?.id;
      if (!tokenId) throw new Error("cli token insert returned no row");

      await tx.insert(schema.cliRefreshTokens).values({
        tokenSha256: sha256(refreshToken),
        sessionId: refreshSessionId,
        expiresAt: refreshExpiresAt,
      });

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

      return {
        status: "approved",
        token,
        expiresAt,
        refreshToken,
        refreshExpiresAt,
        userId: row.userId,
        orgId: row.orgId,
      } as const;
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
  refreshSessionId: number | null;
}

/** Resolve a bearer CLI token and recheck its current administrator authority. */
export async function resolveCliToken(
  db: Database,
  token: string,
  now = new Date(),
): Promise<ResolvedCliToken | null> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: schema.cliTokens.id,
        userId: schema.cliTokens.userId,
        orgId: schema.cliTokens.orgId,
        refreshSessionId: schema.cliTokens.refreshSessionId,
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
    const resolved = rows[0];
    if (!resolved) return null;

    const activeAdmin = await tx
      .select({ userId: schema.orgMembers.userId })
      .from(schema.orgMembers)
      .where(
        and(
          eq(schema.orgMembers.orgId, resolved.orgId),
          eq(schema.orgMembers.userId, resolved.userId),
          eq(schema.orgMembers.role, "admin"),
        ),
      )
      .limit(1);
    const activeSession =
      resolved.refreshSessionId === null
        ? [{ id: 0 }]
        : await tx
            .select({ id: schema.cliRefreshSessions.id })
            .from(schema.cliRefreshSessions)
            .where(
              and(
                eq(schema.cliRefreshSessions.id, resolved.refreshSessionId),
                eq(schema.cliRefreshSessions.userId, resolved.userId),
                eq(schema.cliRefreshSessions.orgId, resolved.orgId),
                isNull(schema.cliRefreshSessions.revokedAt),
                gt(schema.cliRefreshSessions.expiresAt, now),
              ),
            )
            .limit(1);
    if (activeAdmin[0] && activeSession[0]) return resolved;

    if (resolved.refreshSessionId !== null) {
      await tx
        .update(schema.cliRefreshSessions)
        .set({ revokedAt: now })
        .where(
          and(
            eq(schema.cliRefreshSessions.id, resolved.refreshSessionId),
            isNull(schema.cliRefreshSessions.revokedAt),
          ),
        );
      await tx
        .update(schema.cliTokens)
        .set({ revokedAt: now })
        .where(
          and(
            eq(schema.cliTokens.refreshSessionId, resolved.refreshSessionId),
            isNull(schema.cliTokens.revokedAt),
          ),
        );
    } else {
      await tx
        .update(schema.cliTokens)
        .set({ revokedAt: now })
        .where(
          and(
            eq(schema.cliTokens.id, resolved.id),
            isNull(schema.cliTokens.revokedAt),
          ),
        );
    }
    return null;
  });
}

export type RefreshCliSessionResult =
  | { status: "invalid" }
  | {
      status: "approved";
      token: string;
      expiresAt: Date;
      refreshToken: string;
      refreshExpiresAt: Date;
    };

export const CLI_REFRESH_REPLAY_GRACE_MS = 60 * 1_000;

/**
 * Rotate one refresh credential and slide its session's inactivity deadline.
 * The consumed-token update serializes concurrent exchanges. A duplicate in a
 * short post-rotation grace window receives the exact committed replacement,
 * allowing recovery from a lost HTTP response or failed local credential write
 * without retaining raw tokens in the database. Later reuse, or losing
 * organization-admin eligibility, revokes the whole family before reporting
 * failure.
 */
export async function refreshCliSession(
  db: Database,
  refreshToken: string,
  now = new Date(),
): Promise<RefreshCliSessionResult> {
  const refreshDigest = sha256(refreshToken);
  return db.transaction(async (tx) => {
    const consumed = await tx
      .update(schema.cliRefreshTokens)
      .set({ consumedAt: now })
      .where(
        and(
          eq(schema.cliRefreshTokens.tokenSha256, refreshDigest),
          isNull(schema.cliRefreshTokens.consumedAt),
          gt(schema.cliRefreshTokens.expiresAt, now),
        ),
      )
      .returning({ sessionId: schema.cliRefreshTokens.sessionId });
    const consumedToken = consumed[0];
    if (!consumedToken) {
      const replay = await tx
        .select({
          sessionId: schema.cliRefreshTokens.sessionId,
          consumedAt: schema.cliRefreshTokens.consumedAt,
        })
        .from(schema.cliRefreshTokens)
        .where(
          and(
            eq(schema.cliRefreshTokens.tokenSha256, refreshDigest),
            sql`${schema.cliRefreshTokens.consumedAt} IS NOT NULL`,
          ),
        )
        .limit(1);
      const replayedToken = replay[0];
      const insideRecoveryGrace =
        replayedToken?.consumedAt != null &&
        replayedToken.consumedAt.getTime() >
          now.getTime() - CLI_REFRESH_REPLAY_GRACE_MS;
      if (replayedToken && insideRecoveryGrace) {
        const token = deriveRotatedCliToken(refreshDigest, "access");
        const replacementRefreshToken = deriveRotatedCliToken(
          refreshDigest,
          "refresh",
        );
        const activeSession = await tx
          .select({ id: schema.cliRefreshSessions.id })
          .from(schema.cliRefreshSessions)
          .where(
            and(
              eq(schema.cliRefreshSessions.id, replayedToken.sessionId),
              isNull(schema.cliRefreshSessions.revokedAt),
              gt(schema.cliRefreshSessions.expiresAt, now),
              sql`EXISTS (
                SELECT 1
                FROM ${schema.orgMembers}
                WHERE ${schema.orgMembers.orgId} = ${schema.cliRefreshSessions.orgId}
                  AND ${schema.orgMembers.userId} = ${schema.cliRefreshSessions.userId}
                  AND ${schema.orgMembers.role} = 'admin'
              )`,
            ),
          )
          .limit(1);
        if (!activeSession[0]) {
          await tx
            .update(schema.cliRefreshSessions)
            .set({ revokedAt: now })
            .where(
              and(
                eq(schema.cliRefreshSessions.id, replayedToken.sessionId),
                isNull(schema.cliRefreshSessions.revokedAt),
              ),
            );
          await tx
            .update(schema.cliTokens)
            .set({ revokedAt: now })
            .where(
              and(
                eq(schema.cliTokens.refreshSessionId, replayedToken.sessionId),
                isNull(schema.cliTokens.revokedAt),
              ),
            );
          return { status: "invalid" } as const;
        }
        const access = await tx
          .select({ expiresAt: schema.cliTokens.expiresAt })
          .from(schema.cliTokens)
          .where(
            and(
              eq(schema.cliTokens.tokenSha256, sha256(token)),
              eq(schema.cliTokens.refreshSessionId, replayedToken.sessionId),
              isNull(schema.cliTokens.revokedAt),
              gt(schema.cliTokens.expiresAt, now),
            ),
          )
          .limit(1);
        const replacement = await tx
          .select({ expiresAt: schema.cliRefreshTokens.expiresAt })
          .from(schema.cliRefreshTokens)
          .where(
            and(
              eq(
                schema.cliRefreshTokens.tokenSha256,
                sha256(replacementRefreshToken),
              ),
              eq(schema.cliRefreshTokens.sessionId, replayedToken.sessionId),
              isNull(schema.cliRefreshTokens.consumedAt),
              gt(schema.cliRefreshTokens.expiresAt, now),
            ),
          )
          .limit(1);
        if (access[0] && replacement[0]) {
          return {
            status: "approved",
            token,
            expiresAt: access[0].expiresAt,
            refreshToken: replacementRefreshToken,
            refreshExpiresAt: replacement[0].expiresAt,
          } as const;
        }
      }
      if (replayedToken && !insideRecoveryGrace) {
        await tx
          .update(schema.cliRefreshSessions)
          .set({ revokedAt: now })
          .where(
            and(
              eq(schema.cliRefreshSessions.id, replayedToken.sessionId),
              isNull(schema.cliRefreshSessions.revokedAt),
            ),
          );
        await tx
          .update(schema.cliTokens)
          .set({ revokedAt: now })
          .where(
            and(
              eq(schema.cliTokens.refreshSessionId, replayedToken.sessionId),
              isNull(schema.cliTokens.revokedAt),
            ),
          );
      }
      return { status: "invalid" } as const;
    }

    const refreshExpiresAt = new Date(
      now.getTime() + CLI_REFRESH_SESSION_TTL_MS,
    );
    const session = await tx
      .update(schema.cliRefreshSessions)
      .set({ expiresAt: refreshExpiresAt, lastUsedAt: now })
      .where(
        and(
          eq(schema.cliRefreshSessions.id, consumedToken.sessionId),
          isNull(schema.cliRefreshSessions.revokedAt),
          gt(schema.cliRefreshSessions.expiresAt, now),
          sql`EXISTS (
            SELECT 1
            FROM ${schema.orgMembers}
            WHERE ${schema.orgMembers.orgId} = ${schema.cliRefreshSessions.orgId}
              AND ${schema.orgMembers.userId} = ${schema.cliRefreshSessions.userId}
              AND ${schema.orgMembers.role} = 'admin'
          )`,
        ),
      )
      .returning({
        id: schema.cliRefreshSessions.id,
        userId: schema.cliRefreshSessions.userId,
        orgId: schema.cliRefreshSessions.orgId,
      });
    const activeSession = session[0];
    if (!activeSession) {
      // The session became unusable after the refresh token was consumed. This
      // includes a removed or demoted administrator, so fail closed by ending
      // every access token in the family rather than leaving one usable.
      await tx
        .update(schema.cliRefreshSessions)
        .set({ revokedAt: now })
        .where(
          and(
            eq(schema.cliRefreshSessions.id, consumedToken.sessionId),
            isNull(schema.cliRefreshSessions.revokedAt),
          ),
        );
      await tx
        .update(schema.cliTokens)
        .set({ revokedAt: now })
        .where(
          and(
            eq(schema.cliTokens.refreshSessionId, consumedToken.sessionId),
            isNull(schema.cliTokens.revokedAt),
          ),
        );
      return { status: "invalid" } as const;
    }

    const token = deriveRotatedCliToken(refreshDigest, "access");
    const expiresAt = new Date(now.getTime() + CLI_TOKEN_TTL_MS);
    const replacementRefreshToken = deriveRotatedCliToken(
      refreshDigest,
      "refresh",
    );
    await tx.insert(schema.cliTokens).values({
      tokenSha256: sha256(token),
      userId: activeSession.userId,
      orgId: activeSession.orgId,
      scope: CLI_TOKEN_SCOPE,
      expiresAt,
      refreshSessionId: activeSession.id,
    });
    await tx.insert(schema.cliRefreshTokens).values({
      tokenSha256: sha256(replacementRefreshToken),
      sessionId: activeSession.id,
      expiresAt: refreshExpiresAt,
    });
    return {
      status: "approved",
      token,
      expiresAt,
      refreshToken: replacementRefreshToken,
      refreshExpiresAt,
    } as const;
  });
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
    .where(
      and(eq(schema.cliTokens.id, tokenId), isNull(schema.cliTokens.revokedAt)),
    );
}

/**
 * Revoke any resolved session family and the supplied legacy access token.
 * Lookup intentionally accepts already-used and already-revoked credentials so
 * logout remains idempotent and an old refresh credential can still end its
 * family after a client loses a rotation response.
 */
export async function revokeCliCredentials(
  db: Database,
  input: { accessToken?: string; refreshToken?: string; now?: Date },
): Promise<void> {
  const now = input.now ?? new Date();
  await db.transaction(async (tx) => {
    const access = input.accessToken
      ? await tx
          .select({
            id: schema.cliTokens.id,
            refreshSessionId: schema.cliTokens.refreshSessionId,
          })
          .from(schema.cliTokens)
          .where(eq(schema.cliTokens.tokenSha256, sha256(input.accessToken)))
          .limit(1)
      : [];
    const refresh = input.refreshToken
      ? await tx
          .select({ sessionId: schema.cliRefreshTokens.sessionId })
          .from(schema.cliRefreshTokens)
          .where(
            eq(schema.cliRefreshTokens.tokenSha256, sha256(input.refreshToken)),
          )
          .limit(1)
      : [];
    const accessToken = access[0];
    const refreshToken = refresh[0];
    const sessionIds = [
      accessToken?.refreshSessionId,
      refreshToken?.sessionId,
    ].filter((id): id is number => id !== null && id !== undefined);

    if (sessionIds.length > 0) {
      await tx
        .update(schema.cliRefreshSessions)
        .set({ revokedAt: now })
        .where(
          and(
            inArray(schema.cliRefreshSessions.id, sessionIds),
            isNull(schema.cliRefreshSessions.revokedAt),
          ),
        );
      await tx
        .update(schema.cliTokens)
        .set({ revokedAt: now })
        .where(
          and(
            inArray(schema.cliTokens.refreshSessionId, sessionIds),
            isNull(schema.cliTokens.revokedAt),
          ),
        );
    }
    if (accessToken) {
      await tx
        .update(schema.cliTokens)
        .set({ revokedAt: now })
        .where(
          and(
            eq(schema.cliTokens.id, accessToken.id),
            isNull(schema.cliTokens.revokedAt),
          ),
        );
    }
  });
}
