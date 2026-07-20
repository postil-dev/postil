import { and, asc, eq, gt, isNotNull } from "drizzle-orm";

import { getDb, schema, type Database } from "@/lib/db";
import { requireEnv } from "@/lib/env";
import {
  fetchGateEnforcementObservation,
  GithubRateLimitError,
  type GateEnforcementObservation,
} from "@/lib/github/gate-enforcement";
import { getInstallationToken } from "@/lib/github/app-auth";
import type { GateEnforcementSweepJobPayload } from "@/lib/queue";
import { redactSecrets } from "@/lib/redact";

export const GATE_ENFORCEMENT_SWEEP_BATCH_SIZE = 20;
export const GATE_ENFORCEMENT_SWEEP_CONCURRENCY = 4;

export interface GateEnforcementSweepContinuation {
  payload: GateEnforcementSweepJobPayload;
  runAfter?: Date;
}

interface SweepRepository {
  id: number;
  fullName: string;
  githubInstallationId: number;
}

export async function runGateEnforcementSweepJob(
  payload: GateEnforcementSweepJobPayload,
  database: Database = getDb(),
): Promise<GateEnforcementSweepContinuation | undefined> {
  validatePayload(payload);
  const appId = parseAppId(requireEnv("GITHUB_APP_ID"));
  const predicates = [
    gt(schema.repositories.id, payload.afterRepositoryId ?? 0),
    eq(schema.repositories.enabled, true),
    eq(schema.installations.suspended, false),
  ];
  if (payload.orgId !== undefined) {
    predicates.push(eq(schema.installations.orgId, payload.orgId));
  } else {
    predicates.push(isNotNull(schema.installations.orgId));
  }
  const installationTokens = new Map<number, Promise<string>>();
  const repositories = await database
    .select({
      id: schema.repositories.id,
      fullName: schema.repositories.fullName,
      githubInstallationId: schema.installations.githubInstallationId,
    })
    .from(schema.repositories)
    .innerJoin(
      schema.installations,
      eq(schema.installations.id, schema.repositories.installationId),
    )
    .where(and(...predicates))
    .orderBy(asc(schema.repositories.id))
    .limit(GATE_ENFORCEMENT_SWEEP_BATCH_SIZE);

  let completedThrough = payload.afterRepositoryId ?? 0;
  for (let offset = 0; offset < repositories.length; offset += GATE_ENFORCEMENT_SWEEP_CONCURRENCY) {
    const chunk = repositories.slice(offset, offset + GATE_ENFORCEMENT_SWEEP_CONCURRENCY);
    const results = await Promise.all(
      chunk.map((repository) =>
        checkRepository(database, repository, appId, installationTokens),
      ),
    );
    const rateLimit = results
      .filter((result): result is GithubRateLimitError => result instanceof GithubRateLimitError)
      .sort((left, right) => right.retryAt.getTime() - left.retryAt.getTime())[0];
    if (rateLimit) {
      return {
        payload: { ...payload, afterRepositoryId: completedThrough },
        runAfter: rateLimit.retryAt,
      };
    }
    completedThrough = chunk.at(-1)?.id ?? completedThrough;
  }

  if (repositories.length === GATE_ENFORCEMENT_SWEEP_BATCH_SIZE) {
    return {
      payload: { ...payload, afterRepositoryId: completedThrough },
    };
  }
  return undefined;
}

async function checkRepository(
  database: Database,
  repository: SweepRepository,
  appId: number,
  installationTokens: Map<number, Promise<string>>,
): Promise<GithubRateLimitError | null> {
  const checkedAt = new Date();
  try {
    let tokenPromise = installationTokens.get(repository.githubInstallationId);
    if (!tokenPromise) {
      tokenPromise = getInstallationToken(repository.githubInstallationId);
      installationTokens.set(repository.githubInstallationId, tokenPromise);
    }
    const token = await tokenPromise;
    const observation = await fetchGateEnforcementObservation(
      token,
      repository.fullName,
      appId,
    );
    await persistObservation(database, repository.id, observation, checkedAt);
    return null;
  } catch (error) {
    if (error instanceof GithubRateLimitError) return error;
    const message = redactSecrets(error).slice(0, 500);
    await persistUnknownObservation(database, repository.id, checkedAt, message);
    return null;
  }
}

async function persistUnknownObservation(
  database: Database,
  repositoryId: number,
  checkedAt: Date,
  lastError: string,
): Promise<void> {
  await database
    .insert(schema.repositoryGateEnforcement)
    .values({
      repositoryId,
      status: "unknown",
      branchProtection: "unknown",
      checkedAt,
      lastError,
    })
    .onConflictDoUpdate({
      target: schema.repositoryGateEnforcement.repositoryId,
      set: {
        status: "unknown",
        branchProtection: "unknown",
        checkedAt,
        lastError,
        updatedAt: checkedAt,
      },
    });
}

async function persistObservation(
  database: Database,
  repositoryId: number,
  observation: GateEnforcementObservation,
  checkedAt: Date,
): Promise<void> {
  const successfulAt = observation.status === "unknown" ? null : checkedAt;
  await database
    .insert(schema.repositoryGateEnforcement)
    .values({
      repositoryId,
      status: observation.status,
      defaultBranch: observation.defaultBranch,
      branchProtection: observation.branchProtection,
      evidence: observation.evidence,
      checkedAt,
      lastSuccessfulAt: successfulAt,
      lastError: observation.error,
      updatedAt: checkedAt,
    })
    .onConflictDoUpdate({
      target: schema.repositoryGateEnforcement.repositoryId,
      set: {
        status: observation.status,
        defaultBranch: observation.defaultBranch,
        branchProtection: observation.branchProtection,
        evidence: observation.evidence,
        checkedAt,
        ...(successfulAt ? { lastSuccessfulAt: successfulAt } : {}),
        lastError: observation.error,
        updatedAt: checkedAt,
      },
    });
}

function parseAppId(value: string): number {
  const appId = Number(value);
  if (!Number.isInteger(appId) || appId <= 0) {
    throw new Error("GITHUB_APP_ID must be a positive integer");
  }
  return appId;
}

function validatePayload(payload: GateEnforcementSweepJobPayload): void {
  const expectedScope = payload.orgId === undefined ? "global" : `org:${payload.orgId}`;
  if (
    payload.scopeKey !== expectedScope ||
    !Number.isFinite(Date.parse(payload.requestedAt)) ||
    (payload.orgId !== undefined && (!Number.isInteger(payload.orgId) || payload.orgId <= 0)) ||
    (payload.afterRepositoryId !== undefined &&
      (!Number.isInteger(payload.afterRepositoryId) || payload.afterRepositoryId < 0))
  ) {
    throw new Error("gate enforcement sweep job payload is malformed");
  }
}
