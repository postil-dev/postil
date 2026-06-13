import { randomBytes } from "node:crypto";

import { and, eq, gt } from "drizzle-orm";
import { cookies } from "next/headers";

import { getDb, schema } from "@/lib/db";
import { requireEnv } from "@/lib/env";
import {
  SESSION_COOKIE,
  signSessionToken,
  verifySessionToken,
} from "@/lib/session-token";

// Session lifetime, single source of truth so the server-side expiry and the
// OAuth callback's cookie maxAge cannot drift. This also bounds how long a user
// removed from a GitHub org keeps dashboard access without re-logging in
// (membership is reconciled at login); a shorter window narrows that residual
// gap. See org-membership-ttl-plan for the per-request re-check follow-up.
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const SESSION_TTL_MS = SESSION_TTL_SECONDS * 1000;

export interface SessionUser {
  id: number;
  githubId: number;
  login: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
}

export async function createSession(userId: number): Promise<string> {
  const db = getDb();
  const id = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(schema.sessions).values({ id, userId, expiresAt });
  return signSessionToken(id, requireEnv("POSTIL_SESSION_SECRET"));
}

export async function destroySessionByToken(token: string | undefined): Promise<void> {
  const sessionId = await verifySessionToken(token, requireEnv("POSTIL_SESSION_SECRET"));
  if (!sessionId) return;
  await getDb().delete(schema.sessions).where(eq(schema.sessions.id, sessionId));
}

/** Resolve the current request's user, or null when not signed in. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  const sessionId = await verifySessionToken(token, requireEnv("POSTIL_SESSION_SECRET"));
  if (!sessionId) return null;
  const db = getDb();
  const rows = await db
    .select({
      id: schema.users.id,
      githubId: schema.users.githubId,
      login: schema.users.login,
      name: schema.users.name,
      email: schema.users.email,
      avatarUrl: schema.users.avatarUrl,
    })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(and(eq(schema.sessions.id, sessionId), gt(schema.sessions.expiresAt, new Date())))
    .limit(1);
  return rows[0] ?? null;
}

export { SESSION_COOKIE };
