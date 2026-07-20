import { beforeEach, describe, expect, mock, test } from "bun:test";

let repositories: Array<{ id: number; fullName: string; githubInstallationId: number }> = [];
let persisted: Array<Record<string, unknown>> = [];
let observationHandler: (repo: string) => Promise<Record<string, unknown>>;
let tokenHandler: () => Promise<string>;

class TestRateLimitError extends Error {
  constructor(
    message: string,
    readonly retryAt: Date,
  ) {
    super(message);
  }
}

const schema = {
  repositories: {
    id: "repositories.id",
    fullName: "repositories.full_name",
    enabled: "repositories.enabled",
    available: "repositories.available",
    installationId: "repositories.installation_id",
  },
  installations: {
    id: "installations.id",
    orgId: "installations.org_id",
    suspended: "installations.suspended",
    githubInstallationId: "installations.github_installation_id",
  },
  repositoryGateEnforcement: {
    repositoryId: "repository_gate_enforcement.repository_id",
  },
};

mock.module("@/lib/db", () => ({
  schema,
  getDb: () => fakeDb(),
}));

mock.module("@/lib/env", () => ({
  requireEnv: (name: string) => {
    if (name !== "GITHUB_APP_ID") throw new Error(`unexpected env ${name}`);
    return "12345";
  },
}));

mock.module("@/lib/github/app-auth", () => ({
  getInstallationToken: () => tokenHandler(),
}));

mock.module("@/lib/github/gate-enforcement", () => ({
  GithubRateLimitError: TestRateLimitError,
  fetchGateEnforcementObservation: async (
    _token: string,
    repo: string,
  ) => observationHandler(repo),
}));

mock.module("@/lib/redact", () => ({
  redactSecrets: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

const {
  GATE_ENFORCEMENT_SWEEP_BATCH_SIZE,
  GATE_ENFORCEMENT_SWEEP_CONCURRENCY,
  runGateEnforcementSweepJob,
} = await import("@/worker/gate-enforcement-sweep");

beforeEach(() => {
  repositories = [];
  persisted = [];
  observationHandler = async () => observation();
  tokenHandler = async () => "token";
});

describe("gate enforcement sweep", () => {
  test("processes a bounded keyset page and retains its cursor", async () => {
    repositories = Array.from({ length: GATE_ENFORCEMENT_SWEEP_BATCH_SIZE }, (_, index) => ({
      id: index + 1,
      fullName: `acme/repo-${index + 1}`,
      githubInstallationId: 9,
    }));

    const continuation = await runGateEnforcementSweepJob({
      scopeKey: "global",
      requestedAt: "2026-07-15T12:00:00.000Z",
    }, fakeDb() as never);

    expect(persisted).toHaveLength(GATE_ENFORCEMENT_SWEEP_BATCH_SIZE);
    expect(continuation?.payload.afterRepositoryId).toBe(GATE_ENFORCEMENT_SWEEP_BATCH_SIZE);
  });

  test("limits concurrent GitHub checks to four", async () => {
    repositories = Array.from({ length: 9 }, (_, index) => ({
      id: index + 1,
      fullName: `acme/repo-${index + 1}`,
      githubInstallationId: 9,
    }));
    let active = 0;
    let maximum = 0;
    observationHandler = async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return observation();
    };

    await runGateEnforcementSweepJob({
      scopeKey: "org:7",
      orgId: 7,
      requestedAt: "2026-07-15T12:00:00.000Z",
    }, fakeDb() as never);

    expect(GATE_ENFORCEMENT_SWEEP_CONCURRENCY).toBe(4);
    expect(maximum).toBe(4);
  });

  test("retries the same keyset chunk at GitHub's reset time", async () => {
    repositories = Array.from({ length: 5 }, (_, index) => ({
      id: index + 11,
      fullName: `acme/repo-${index + 11}`,
      githubInstallationId: 9,
    }));
    const retryAt = new Date("2026-07-15T12:10:00.000Z");
    const attempted: string[] = [];
    observationHandler = async (repo) => {
      attempted.push(repo);
      if (repo.endsWith("11")) throw new TestRateLimitError("rate limited", retryAt);
      return observation();
    };

    const continuation = await runGateEnforcementSweepJob({
      scopeKey: "global",
      requestedAt: "2026-07-15T12:00:00.000Z",
    }, fakeDb() as never);

    expect(continuation?.payload.afterRepositoryId).toBe(0);
    expect(continuation?.runAfter).toEqual(retryAt);
    expect(persisted.find((row) => row.repositoryId === 11)).toBeUndefined();
    expect(attempted).not.toContain("acme/repo-15");
  });

  test("durably pauses when installation-token minting is rate limited", async () => {
    repositories = [{ id: 21, fullName: "acme/repo-21", githubInstallationId: 9 }];
    const retryAt = new Date("2026-07-15T12:10:00.000Z");
    tokenHandler = async () => {
      throw new TestRateLimitError("rate limited", retryAt);
    };

    const continuation = await runGateEnforcementSweepJob({
      scopeKey: "global",
      requestedAt: "2026-07-15T12:00:00.000Z",
    }, fakeDb() as never);

    expect(continuation?.payload.afterRepositoryId).toBe(0);
    expect(continuation?.runAfter).toEqual(retryAt);
    expect(persisted).toHaveLength(0);
  });

  test("persists operational errors as unknown without stopping the sweep", async () => {
    repositories = [{ id: 3, fullName: "acme/repo", githubInstallationId: 9 }];
    observationHandler = async () => {
      throw new Error("permission unavailable");
    };

    expect(await runGateEnforcementSweepJob({
      scopeKey: "global",
      requestedAt: "2026-07-15T12:00:00.000Z",
    }, fakeDb() as never)).toBeUndefined();
    expect(persisted[0]).toMatchObject({
      repositoryId: 3,
      status: "unknown",
      branchProtection: "unknown",
      lastError: "permission unavailable",
    });
  });
});

function observation(): Record<string, unknown> {
  return {
    status: "required",
    defaultBranch: "main",
    branchProtection: "protected",
    evidence: {
      expectedContext: "postil/gate",
      expectedAppId: 12345,
      branchProtection: { available: true, requiredStatusChecksPresent: true, exactMatch: true },
      activeRules: { available: true, pagesRead: 1, exactMatch: false },
    },
    error: null,
  };
}

function fakeDb(): Record<string, unknown> {
  return {
    select() {
      const chain = {
        from() { return chain; },
        innerJoin() { return chain; },
        where() { return chain; },
        orderBy() { return chain; },
        limit(limit: number) { return Promise.resolve(repositories.slice(0, limit)); },
      };
      return chain;
    },
    insert() {
      return {
        values(value: Record<string, unknown>) {
          persisted.push(value);
          return {
            onConflictDoUpdate: async () => undefined,
          };
        },
      };
    },
  };
}
