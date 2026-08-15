import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { Client, Pool } from "pg";

import {
  createUnmigratedEphemeralDatabase,
  type EphemeralDatabase,
} from "./ephemeral-database";

import {
  activePublicationControllerRelease,
  activatePublicationControllerRelease,
  activateQueueLockGeneration,
  deactivatePublicationControllerRelease,
  deferLegacyReviewForPublicationController,
  PUBLICATION_CONTROLLER_DIRECT_MUTATOR_JOB_KINDS,
  type PublicationControllerNoMutationProbe,
  type PublicationControllerRecoveryStateReader,
  publicationControllerConsumerReady,
  publicationControllerLegacyReviewFenced,
  publicationControllerReleaseActivated,
  readProductionPublicationControllerRecoveryState,
  recordPublicationControllerCliPreflight,
  recordPublicationControllerConsumerReady,
} from "@/lib/release-job-rollout";
import {
  claimJob,
  claimPublicationControllerReviewJob,
  COALESCED_REVIEW_PAYLOAD_KEY,
  continueClaimedJob,
  retryJobIndefinitely,
} from "@/lib/queue";

const TEST_URL = process.env.POSTIL_TEST_DATABASE_URL;
const describeDb = TEST_URL ? describe : describe.skip;
const DRIZZLE_DIRECTORY = join(import.meta.dir, "..", "drizzle");
const RELEASE_A = "a".repeat(40);
const RELEASE_B = "b".repeat(40);
type TestMutatorKind = "review" | "gate-state-sync" | "check-run-cleanup";

test("migration replay follows the Drizzle journal order", async () => {
  const files = await migrationFilesInJournalOrder();
  const first0048 = files.indexOf("0048_woozy_tigra.sql");

  expect(first0048).toBeGreaterThanOrEqual(0);
  expect(files.slice(first0048, first0048 + 2)).toEqual([
    "0048_woozy_tigra.sql",
    "0048_new_jubilee.sql",
  ]);
  await expect(
    Promise.all(
      files.map((file) => readFile(join(DRIZZLE_DIRECTORY, file), "utf8")),
    ),
  ).resolves.toHaveLength(files.length);
});

describeDb("publication-controller release rollout", () => {
  let database: EphemeralDatabase;
  let pool: Pool;

  beforeEach(async () => {
    database = await createUnmigratedEphemeralDatabase(
      "publication_controller_rollout",
    );
    const migration = new Client({ connectionString: database.url });
    await migration.connect();
    for (const file of await migrationFilesInJournalOrder()) {
      const source = await readFile(join(DRIZZLE_DIRECTORY, file), "utf8");
      for (const statement of source.split("--> statement-breakpoint")) {
        if (statement.trim()) await migration.query(statement);
      }
    }
    await migration.end();
    pool = database.pool;
  }, 30_000);

  afterEach(async () => {
    await database?.drop();
  }, 30_000);

  test("dark readiness never fences controller-owned reviews", async () => {
    expect(await deactivatePublicationControllerRelease(pool, RELEASE_A)).toEqual({
      routingRemoved: false,
      state: "dark",
      releaseSha: null,
      restoredLegacyJobs: 0,
      remainingNonterminalGenerations: 0,
      activeMutationLeases: 0,
    });
    await recordPublicationControllerCliPreflight(pool, RELEASE_A);
    await recordPublicationControllerConsumerReady(
      pool,
      RELEASE_A,
      noMutationProbe,
    );
    await activateQueueLockGeneration(pool);

    for (const [index, kind] of PUBLICATION_CONTROLLER_DIRECT_MUTATOR_JOB_KINDS.entries()) {
      const id = await insertQueuedMutator(
        pool,
        kind,
        `2040-01-0${index + 2}T03:04:05.000Z`,
      );
      const claim = await claimAsLegacyWorker(pool, id, `dark-${kind}`);
      expect(claim).toEqual({ status: "running", attempts: 1, held: false });
      await markJobDone(pool, id);
    }

    expect(await publicationControllerLegacyReviewFenced(pool, RELEASE_A)).toBe(false);
    expect(await publicationControllerReleaseActivated(pool, RELEASE_A)).toBe(false);
  });

  test("database fencing rejects malformed active release identities", async () => {
    await deactivatePublicationControllerRelease(pool, RELEASE_A);
    await activateQueueLockGeneration(pool);
    await pool.query(
      `INSERT INTO deployment_capabilities (name)
       VALUES
         ('publication-controller-release:not-a-sha'),
         ('publication-controller-consumer-ready:not-a-sha')`,
    );

    await expect(
      insertQueuedMutator(pool, "review", "2040-01-09T03:04:05.000Z"),
    ).rejects.toThrow("active release identity is malformed");
  });

  test("consumer readiness records only an exercised exact no-mutation probe", async () => {
    await deactivatePublicationControllerRelease(pool, RELEASE_A);
    let calls = 0;
    const probe: PublicationControllerNoMutationProbe = async (input) => {
      calls += 1;
      expect(input.releaseSha).toBe(RELEASE_A);
      expect(input.jobKinds).toEqual(PUBLICATION_CONTROLLER_DIRECT_MUTATOR_JOB_KINDS);
      const before = await input.client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM jobs",
      );
      expect(before.rows[0]?.count).toBe("0");
      return {
        releaseSha: input.releaseSha,
        mode: "no-mutation",
        observedMutationCount: 0,
        checkedJobKinds: input.jobKinds,
      };
    };

    expect(
      await recordPublicationControllerConsumerReady(pool, RELEASE_A, probe),
    ).toBe(true);
    expect(
      await recordPublicationControllerConsumerReady(pool, RELEASE_A, probe),
    ).toBe(false);
    expect(calls).toBe(2);
    expect(await publicationControllerConsumerReady(pool, RELEASE_A)).toBe(true);

    await deactivatePublicationControllerRelease(pool, RELEASE_B);
    await expect(
      recordPublicationControllerConsumerReady(
        pool,
        RELEASE_B,
        async () => ({
          releaseSha: RELEASE_A,
          mode: "no-mutation",
          observedMutationCount: 0,
          checkedJobKinds: PUBLICATION_CONTROLLER_DIRECT_MUTATOR_JOB_KINDS,
        }),
      ),
    ).rejects.toThrow("invalid exact no-mutation result");
    expect(await publicationControllerConsumerReady(pool, RELEASE_B)).toBe(false);

    await expect(
      recordPublicationControllerConsumerReady(
        pool,
        RELEASE_B,
        async (input) => {
          await input.client.query(
            "INSERT INTO deployment_capabilities (name) VALUES ('probe-mutation')",
          );
          return {
            releaseSha: input.releaseSha,
            mode: "no-mutation",
            observedMutationCount: 0,
            checkedJobKinds: input.jobKinds,
          };
        },
      ),
    ).rejects.toThrow();
    expect(await hasCapability(pool, "probe-mutation")).toBe(false);
    expect(await publicationControllerConsumerReady(pool, RELEASE_B)).toBe(false);
  });

  test("activation requires both preflights and leaves failed handoff dark", async () => {
    await deactivatePublicationControllerRelease(pool, RELEASE_A);
    const originalRunAfter = "2040-02-03T04:05:06.000Z";
    const id = await insertQueuedMutator(pool, "review", originalRunAfter);

    await expect(
      activatePublicationControllerRelease(pool, RELEASE_A),
    ).rejects.toThrow("successful CLI-plan preflight");
    await recordPublicationControllerCliPreflight(pool, RELEASE_A);
    await expect(
      activatePublicationControllerRelease(pool, RELEASE_A),
    ).rejects.toThrow("consumer readiness preflight");

    expect(await publicationControllerReleaseActivated(pool, RELEASE_A)).toBe(false);
    expect(await publicationControllerLegacyReviewFenced(pool, RELEASE_A)).toBe(false);
    await activateQueueLockGeneration(pool);
    expect(await queuedJobState(pool, id)).toEqual({
      held: false,
      releaseSha: null,
      scheduledFor: originalRunAfter,
    });
  });

  test("activation refuses every running direct GitHub mutator kind", async () => {
    for (const kind of PUBLICATION_CONTROLLER_DIRECT_MUTATOR_JOB_KINDS) {
      await prepareRelease(pool, RELEASE_A);
      const id = await insertRunningMutator(pool, kind, `running-${kind}`);
      await expect(
        activatePublicationControllerRelease(pool, RELEASE_A, {
          timeoutMs: 0,
        }),
      ).rejects.toThrow("direct GitHub mutator job claim");
      expect(await publicationControllerReleaseActivated(pool, RELEASE_A)).toBe(false);
      await markJobDone(pool, id.id);
    }
  });

  test("activation waits for review claims and rechecks under lock", async () => {
    await prepareRelease(pool, RELEASE_A);
    const running = await insertRunningMutator(
      pool,
      "review",
      "draining-review-worker",
    );
    let signalWait!: () => void;
    const waiting = new Promise<void>((resolve) => {
      signalWait = resolve;
    });
    let signalled = false;
    const activation = activatePublicationControllerRelease(pool, RELEASE_A, {
      timeoutMs: 5_000,
      pollMs: 10,
      onWait: () => {
        if (!signalled) {
          signalled = true;
          signalWait();
        }
      },
    });

    await waiting;
    await markJobDone(pool, running.id);
    await expect(activation).resolves.toEqual({
      activated: true,
      adopted: 0,
    });
  });

  test("activation atomically adopts controller-owned reviews with exact schedules", async () => {
    await prepareRelease(pool, RELEASE_A);
    const jobs = await Promise.all(
      PUBLICATION_CONTROLLER_DIRECT_MUTATOR_JOB_KINDS.map((kind, index) =>
        insertQueuedMutator(
          pool,
          kind,
          `2040-03-0${index + 2}T05:06:07.000Z`,
        ),
      ),
    );

    expect(await activatePublicationControllerRelease(pool, RELEASE_A)).toEqual({
      activated: true,
      adopted: jobs.length,
    });
    expect(await publicationControllerReleaseActivated(pool, RELEASE_A)).toBe(true);
    expect(await activePublicationControllerRelease(pool)).toBe(RELEASE_A);
    expect(await publicationControllerLegacyReviewFenced(pool, RELEASE_A)).toBe(true);

    for (const [index, id] of jobs.entries()) {
      expect(await queuedJobState(pool, id)).toEqual({
        held: true,
        releaseSha: RELEASE_A,
        scheduledFor: `2040-03-0${index + 2}T05:06:07.000Z`,
      });
    }

    await activateQueueLockGeneration(pool);
    for (const [index, id] of jobs.entries()) {
      expect(await queuedJobState(pool, id)).toEqual({
        held: true,
        releaseSha: RELEASE_A,
        scheduledFor: `2040-03-0${index + 2}T05:06:07.000Z`,
      });
      expect(await claimAsLegacyWorker(pool, id, `legacy-${index}`)).toEqual({
        status: "queued",
        attempts: 0,
        held: true,
      });
    }
  });

  test("forward ownership migration releases non-review jobs held by the old trigger", async () => {
    await prepareRelease(pool, RELEASE_A);
    await activatePublicationControllerRelease(pool, RELEASE_A);
    await activateQueueLockGeneration(pool);
    await applyMigrationFile(pool, "0056_publication_controller_queue_fence.sql");

    const gateRunAfter = "2040-03-11T05:06:07.000Z";
    const cleanupRunAfter = "infinity";
    const gate = await insertQueuedMutator(pool, "gate-state-sync", gateRunAfter);
    const cleanup = await insertQueuedMutator(
      pool,
      "check-run-cleanup",
      cleanupRunAfter,
    );
    expect(await queuedJobState(pool, gate)).toEqual({
      held: true,
      releaseSha: RELEASE_A,
      scheduledFor: gateRunAfter,
    });
    const heldCleanup = await pool.query<{
      held: boolean;
      stored_run_after: string | null;
    }>(
      `SELECT run_after = 'infinity'::timestamptz AS held,
              payload->>'_postilPublicationControllerRunAfter' AS stored_run_after
         FROM jobs WHERE id = $1`,
      [cleanup],
    );
    expect(heldCleanup.rows[0]).toEqual({
      held: true,
      stored_run_after: "infinity",
    });

    await applyMigrationFile(
      pool,
      "0058_publication_controller_review_ownership.sql",
    );
    expect(await queuedJobState(pool, gate)).toEqual({
      held: false,
      releaseSha: null,
      scheduledFor: gateRunAfter,
    });
    expect(await queuedJobState(pool, cleanup)).toMatchObject({
      held: false,
      releaseSha: null,
    });
    await pool.query(
      `UPDATE jobs
          SET payload = payload || jsonb_build_object(
                '_postilPublicationControllerFence', true,
                '_postilPublicationControllerRunAfter', to_jsonb(run_after),
                '_postilPublicationControllerReleaseSha', $2::text
              ),
              run_after = 'infinity'::timestamptz
        WHERE id = $1`,
      [gate, RELEASE_A],
    );
    expect(await queuedJobState(pool, gate)).toEqual({
      held: false,
      releaseSha: null,
      scheduledFor: gateRunAfter,
    });
    expect(await claimAsLegacyWorker(pool, gate, "released-gate")).toEqual({
      status: "running",
      attempts: 1,
      held: false,
    });
    expect(await claimAsLegacyWorker(pool, cleanup, "released-cleanup")).toEqual({
      status: "running",
      attempts: 1,
      held: false,
    });
  });

  test("ownership migration fails bounded when queue authority is busy", async () => {
    const blocker = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        ["postil:queue-lock-generation-v1"],
      );
      await expect(
        applyMigrationFile(
          pool,
          "0058_publication_controller_review_ownership.sql",
        ),
      ).rejects.toThrow("could not acquire queue lock");
      await blocker.query("ROLLBACK");
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
    }

    await expect(
      applyMigrationFile(
        pool,
        "0058_publication_controller_review_ownership.sql",
      ),
    ).resolves.toBeUndefined();
  });

  test("controller claim admits only due exact-release reviews", async () => {
    await prepareRelease(pool, RELEASE_A);
    const originalRunAfter = "2020-03-02T05:06:07.000Z";
    const dueReview = await insertQueuedReview(
      pool,
      {
        repositoryId: 42,
        marker: "due-review",
        [COALESCED_REVIEW_PAYLOAD_KEY]: {
          repositoryId: 42,
          marker: "coalesced-review",
        },
      },
      originalRunAfter,
    );
    const futureReview = await insertQueuedReview(
      pool,
      { repositoryId: 43, marker: "future-review" },
      "2099-03-03T05:06:07.000Z",
    );
    const gate = await insertQueuedMutator(
      pool,
      "gate-state-sync",
      "2020-03-04T05:06:07.000Z",
    );
    const cleanup = await insertQueuedMutator(
      pool,
      "check-run-cleanup",
      "2020-03-05T05:06:07.000Z",
    );
    await activatePublicationControllerRelease(pool, RELEASE_A);
    await activateQueueLockGeneration(pool);
    const payloadBeforeClaim = await storedJobPayload(pool, dueReview);

    expect(await claimJob(pool, "legacy-worker", ["review"])).toBeNull();
    expect(
      await claimAsLegacyWorker(pool, dueReview, "direct-legacy-worker"),
    ).toEqual({
      status: "queued",
      attempts: 0,
      held: true,
    });
    expect(await claimAsLegacyWorker(pool, gate, "legacy-gate")).toEqual({
      status: "running",
      attempts: 1,
      held: false,
    });
    expect(await claimAsLegacyWorker(pool, cleanup, "legacy-cleanup")).toEqual({
      status: "running",
      attempts: 1,
      held: false,
    });
    await markJobDone(pool, gate);
    await markJobDone(pool, cleanup);
    expect(
      await claimPublicationControllerReviewJob(
        pool,
        "wrong-release-controller",
        RELEASE_B,
      ),
    ).toBeNull();

    const claimed = await claimPublicationControllerReviewJob(
      pool,
      "exact-release-controller",
      RELEASE_A,
    );
    expect(claimed).toMatchObject({
      id: dueReview,
      kind: "review",
      payload: payloadBeforeClaim,
      attempts: 1,
      lockGeneration: 1n,
      lockedBy: "exact-release-controller",
    });
    expect(claimed?.payload[COALESCED_REVIEW_PAYLOAD_KEY]).toEqual(
      payloadBeforeClaim[COALESCED_REVIEW_PAYLOAD_KEY],
    );
    expect(claimed?.payload).not.toHaveProperty(
      "_postilPublicationControllerClaimReleaseSha",
    );
    expect(await jobLeaseState(pool, dueReview)).toEqual({
      status: "running",
      attempts: 1,
      lockGeneration: 1n,
      releaseSha: RELEASE_A,
      claimReleaseSha: null,
      scheduledFor: originalRunAfter,
    });

    expect(
      await claimPublicationControllerReviewJob(
        pool,
        "future-release-controller",
        RELEASE_A,
      ),
    ).toBeNull();
    expect((await queuedJobState(pool, futureReview)).held).toBe(true);
    expect(await jobLeaseState(pool, gate)).toMatchObject({
      status: "done",
      attempts: 1,
    });
    expect(await jobLeaseState(pool, cleanup)).toMatchObject({
      status: "done",
      attempts: 1,
    });
  });

  test("controller claim terminalizes expired reviews and promotes retained input", async () => {
    await prepareRelease(pool, RELEASE_A);
    const expired = await insertQueuedReview(
      pool,
      {
        marker: "expired-review",
        [COALESCED_REVIEW_PAYLOAD_KEY]: {
          marker: "retained-review",
        },
      },
      "2020-03-05T05:06:07.000Z",
    );
    await pool.query(
      `UPDATE jobs
          SET reconciliation_deadline_at = '2020-03-05T05:07:07.000Z'
        WHERE id = $1`,
      [expired],
    );
    await activatePublicationControllerRelease(pool, RELEASE_A);
    await activateQueueLockGeneration(pool);

    const claimed = await claimPublicationControllerReviewJob(
      pool,
      "deadline-controller",
      RELEASE_A,
    );
    expect(claimed).toMatchObject({
      kind: "review",
      payload: { marker: "retained-review" },
      attempts: 1,
      lockGeneration: 1n,
    });
    expect(claimed?.id).not.toBe(expired);
    const expiredState = await pool.query<{
      status: string;
      last_error: string | null;
    }>("SELECT status, last_error FROM jobs WHERE id = $1", [expired]);
    expect(expiredState.rows[0]).toEqual({
      status: "failed",
      last_error: "reconciliation budget exhausted before claim",
    });
  });

  test("controller claim safely skips malformed durable routing fields", async () => {
    await prepareRelease(pool, RELEASE_A);
    const malformedSchedule = await insertQueuedReview(
      pool,
      { _postilPublicationControllerRunAfter: "not-a-time" },
      "2020-03-05T05:06:07.000Z",
    );
    await activatePublicationControllerRelease(pool, RELEASE_A);
    await activateQueueLockGeneration(pool);
    expect(
      await claimPublicationControllerReviewJob(
        pool,
        "malformed-schedule-controller",
        RELEASE_A,
      ),
    ).toBeNull();
    const malformedScheduleState = await pool.query<{ status: string }>(
      "SELECT status FROM jobs WHERE id = $1",
      [malformedSchedule],
    );
    expect(malformedScheduleState.rows[0]?.status).toBe("queued");

    const malformedRecovery = await insertQueuedReview(
      pool,
      {
        recoveryReviewId: "not-an-id",
        reviewInputSequence: "also-not-an-id",
      },
      "2020-03-05T05:08:07.000Z",
    );
    expect(
      await claimPublicationControllerReviewJob(
        pool,
        "malformed-recovery-controller",
        RELEASE_A,
      ),
    ).toBeNull();
    expect((await jobLeaseState(pool, malformedRecovery)).status).toBe("queued");
  });

  test("controller claim rejects stale and ambiguous release authority", async () => {
    await prepareRelease(pool, RELEASE_A);
    const review = await insertQueuedReview(
      pool,
      { marker: "stale-release-review" },
      "2020-03-06T05:06:07.000Z",
    );
    await activatePublicationControllerRelease(pool, RELEASE_A);
    await activateQueueLockGeneration(pool);

    await pool.query(
      `DELETE FROM deployment_capabilities
        WHERE name = $1`,
      [`publication-controller-release:${RELEASE_A}`],
    );
    await pool.query(
      `INSERT INTO deployment_capabilities (name)
       VALUES ($1), ($2)`,
      [
        `publication-controller-release:${RELEASE_B}`,
        `publication-controller-consumer-ready:${RELEASE_B}`,
      ],
    );
    expect(
      await claimPublicationControllerReviewJob(pool, "stale-a", RELEASE_A),
    ).toBeNull();
    expect(
      await claimPublicationControllerReviewJob(pool, "stale-b", RELEASE_B),
    ).toBeNull();

    await pool.query(
      `INSERT INTO deployment_capabilities (name) VALUES ($1)`,
      [`publication-controller-release:${RELEASE_A}`],
    );
    expect(
      await claimPublicationControllerReviewJob(pool, "ambiguous-a", RELEASE_A),
    ).toBeNull();
    expect(
      await claimPublicationControllerReviewJob(pool, "ambiguous-b", RELEASE_B),
    ).toBeNull();
    expect(await jobLeaseState(pool, review)).toMatchObject({
      status: "queued",
      attempts: 0,
      lockGeneration: 0n,
      releaseSha: RELEASE_A,
    });
  });

  test("activation waits for legacy staged review recovery to drain", async () => {
    await prepareRelease(pool, RELEASE_A);
    const recovery = await insertQueuedReview(
      pool,
      {
        marker: "legacy-staged-recovery",
        recoveryReviewId: 987654,
        reviewInputSequence: "987654",
      },
      "2020-03-06T06:06:07.000Z",
    );

    await expect(
      activatePublicationControllerRelease(pool, RELEASE_A),
    ).rejects.toThrow("legacy staged review recovery job(s) must drain");
    expect(await queuedJobState(pool, recovery)).toMatchObject({
      releaseSha: null,
    });
    expect(
      await claimPublicationControllerReviewJob(
        pool,
        "legacy-recovery-controller",
        RELEASE_A,
      ),
    ).toBeNull();
  });

  test("concurrent controller claims advance one lease generation once", async () => {
    await prepareRelease(pool, RELEASE_A);
    const review = await insertQueuedReview(
      pool,
      { marker: "concurrent-review" },
      "2020-03-07T05:06:07.000Z",
    );
    await activatePublicationControllerRelease(pool, RELEASE_A);
    await activateQueueLockGeneration(pool);

    const claims = await Promise.all([
      claimPublicationControllerReviewJob(pool, "controller-a", RELEASE_A),
      claimPublicationControllerReviewJob(pool, "controller-b", RELEASE_A),
    ]);
    expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
    expect(claims.find((claim) => claim !== null)).toMatchObject({
      id: review,
      attempts: 1,
      lockGeneration: 1n,
    });
    expect(await jobLeaseState(pool, review)).toMatchObject({
      status: "running",
      attempts: 1,
      lockGeneration: 1n,
      releaseSha: RELEASE_A,
      claimReleaseSha: null,
    });
  });

  test("controller continuation and retry re-fence the exact release", async () => {
    await prepareRelease(pool, RELEASE_A);
    const continuedReview = await insertQueuedReview(
      pool,
      {
        marker: "continued-review",
        [COALESCED_REVIEW_PAYLOAD_KEY]: { marker: "retained-coalesced-review" },
      },
      "2020-03-08T05:06:07.000Z",
    );
    const retriedReview = await insertQueuedReview(
      pool,
      { marker: "retried-review" },
      "2020-03-09T05:06:07.000Z",
    );
    await activatePublicationControllerRelease(pool, RELEASE_A);
    await activateQueueLockGeneration(pool);

    const firstClaim = await claimPublicationControllerReviewJob(
      pool,
      "continuation-controller",
      RELEASE_A,
    );
    expect(firstClaim?.id).toBe(continuedReview);
    const continuationRunAfter = new Date("2020-03-10T05:06:07.000Z");
    await continueClaimedJob(
      pool,
      firstClaim!,
      { ...firstClaim!.payload, stage: "continuation" },
      { runAfter: continuationRunAfter },
    );
    expect(await jobLeaseState(pool, continuedReview)).toEqual({
      status: "queued",
      attempts: 0,
      lockGeneration: 1n,
      releaseSha: RELEASE_A,
      claimReleaseSha: null,
      scheduledFor: continuationRunAfter.toISOString(),
    });

    const continuedClaim = await claimPublicationControllerReviewJob(
      pool,
      "continued-controller",
      RELEASE_A,
    );
    expect(continuedClaim).toMatchObject({
      id: retriedReview,
      attempts: 1,
      lockGeneration: 1n,
    });
    const retryStartedAt = Date.now();
    expect(
      await retryJobIndefinitely(
        pool,
        continuedClaim!,
        "publication controller retry",
      ),
    ).toBe("retried");
    const retryState = await jobLeaseState(pool, retriedReview);
    expect(retryState).toMatchObject({
      status: "queued",
      attempts: 1,
      lockGeneration: 1n,
      releaseSha: RELEASE_A,
      claimReleaseSha: null,
    });
    expect(Date.parse(retryState.scheduledFor!)).toBeGreaterThan(retryStartedAt);

    const resumedClaim = await claimPublicationControllerReviewJob(
      pool,
      "resumed-controller",
      RELEASE_A,
    );
    expect(resumedClaim).toMatchObject({
      id: continuedReview,
      attempts: 1,
      lockGeneration: 2n,
      payload: {
        marker: "continued-review",
        stage: "continuation",
        [COALESCED_REVIEW_PAYLOAD_KEY]: {
          marker: "retained-coalesced-review",
        },
      },
    });
    expect(
      await claimPublicationControllerReviewJob(
        pool,
        "retry-controller",
        RELEASE_A,
      ),
    ).toMatchObject({
      id: retriedReview,
      attempts: 2,
      lockGeneration: 2n,
      payload: { marker: "retried-review" },
    });
  });

  test("a stale review worker defers only to the exact active release", async () => {
    await prepareRelease(pool, RELEASE_B);
    await activatePublicationControllerRelease(pool, RELEASE_B);
    const job = await insertRunningMutator(pool, "review", "stale-release-worker");

    await deferLegacyReviewForPublicationController(pool, job, RELEASE_A);
    const state = await pool.query<{
      status: string;
      attempts: number;
      release_sha: string | null;
    }>(
      `SELECT status, attempts,
              payload->>'_postilPublicationControllerReleaseSha' AS release_sha
         FROM jobs WHERE id = $1`,
      [job.id],
    );
    expect(state.rows[0]).toEqual({
      status: "queued",
      attempts: 0,
      release_sha: RELEASE_B,
    });
  });

  test("deactivation removes routing first and restores only unplanned reviews", async () => {
    await prepareRelease(pool, RELEASE_A);
    const review = await insertQueuedMutator(
      pool,
      "review",
      "2040-04-02T03:04:05.000Z",
    );
    const plannedReview = await insertQueuedMutator(
      pool,
      "review",
      "2040-04-03T03:04:05.000Z",
    );
    const gate = await insertQueuedMutator(
      pool,
      "gate-state-sync",
      "2040-04-04T03:04:05.000Z",
    );
    const cleanup = await insertQueuedMutator(
      pool,
      "check-run-cleanup",
      "2040-04-05T03:04:05.000Z",
    );
    await activatePublicationControllerRelease(pool, RELEASE_A);
    const pending = await deactivatePublicationControllerRelease(pool, RELEASE_B);
    expect(pending).toEqual({
      routingRemoved: true,
      state: "recovery",
      releaseSha: RELEASE_A,
      restoredLegacyJobs: 0,
      remainingNonterminalGenerations: null,
      activeMutationLeases: null,
    });
    expect(await publicationControllerReleaseActivated(pool, RELEASE_A)).toBe(false);
    expect(await publicationControllerLegacyReviewFenced(pool, RELEASE_B)).toBe(false);
    expect(await hasCapability(pool, `publication-controller-dark:${RELEASE_B}`)).toBe(true);
    expect(await hasCapability(pool, `publication-controller-recovery:${RELEASE_A}`)).toBe(true);
    expect(await publicationControllerConsumerReady(pool, RELEASE_A)).toBe(true);
    const classified = await deactivatePublicationControllerRelease(
      pool,
      RELEASE_B,
      recoveryState({
        staged: 1,
        nonterminal: 1,
        leases: 0,
        unplannedQueuedJobIds: [String(review)],
      }),
    );
    expect(classified.restoredLegacyJobs).toBe(1);
    await activateQueueLockGeneration(pool);
    expect((await queuedJobState(pool, review)).held).toBe(false);
    expect((await queuedJobState(pool, plannedReview)).held).toBe(true);
    expect((await queuedJobState(pool, gate)).held).toBe(false);
    expect((await queuedJobState(pool, cleanup)).held).toBe(false);
    expect(await claimAsLegacyWorker(pool, review, "rollback-review")).toEqual({
      status: "running",
      attempts: 1,
      held: false,
    });
    await markJobDone(pool, review);
    expect(
      await claimAsLegacyWorker(pool, plannedReview, "planned-review"),
    ).toEqual({ status: "queued", attempts: 0, held: true });
    expect(await claimAsLegacyWorker(pool, gate, "legacy-gate")).toEqual({
      status: "running",
      attempts: 1,
      held: false,
    });
    expect(await claimAsLegacyWorker(pool, cleanup, "legacy-cleanup")).toEqual({
      status: "running",
      attempts: 1,
      held: false,
    });
    const newReview = await insertQueuedMutator(
      pool,
      "review",
      "2040-04-06T03:04:05.000Z",
    );
    expect(await claimAsLegacyWorker(pool, newReview, "new-review")).toEqual({
      status: "running",
      attempts: 1,
      held: false,
    });
    const newGate = await insertQueuedMutator(
      pool,
      "gate-state-sync",
      "2040-04-07T03:04:05.000Z",
    );
    const newCleanup = await insertQueuedMutator(
      pool,
      "check-run-cleanup",
      "2040-04-08T03:04:05.000Z",
    );
    expect(await claimAsLegacyWorker(pool, newGate, "new-gate")).toEqual({
      status: "running",
      attempts: 1,
      held: false,
    });
    expect(await claimAsLegacyWorker(pool, newCleanup, "new-cleanup")).toEqual({
      status: "running",
      attempts: 1,
      held: false,
    });
  });

  test("recovery retains readiness and review fences until state is terminal", async () => {
    await prepareRelease(pool, RELEASE_A);
    const unplannedReview = await insertQueuedMutator(
      pool,
      "review",
      "2040-05-04T03:04:05.000Z",
    );
    const plannedReview = await insertQueuedMutator(
      pool,
      "review",
      "2040-05-05T03:04:05.000Z",
    );
    await activatePublicationControllerRelease(pool, RELEASE_A);
    const before = await jobCount(pool);

    const withLease = await deactivatePublicationControllerRelease(
      pool,
      RELEASE_B,
      recoveryState({
        staged: 2,
        nonterminal: 2,
        leases: 1,
        unplannedQueuedJobIds: [String(unplannedReview)],
      }),
    );
    expect(withLease.state).toBe("recovery");
    expect(withLease.activeMutationLeases).toBe(1);
    expect(withLease.restoredLegacyJobs).toBe(0);
    await activateQueueLockGeneration(pool);
    expect((await queuedJobState(pool, unplannedReview)).held).toBe(true);
    expect((await queuedJobState(pool, plannedReview)).held).toBe(true);
    expect(await publicationControllerConsumerReady(pool, RELEASE_A)).toBe(true);

    const withoutLease = await deactivatePublicationControllerRelease(
      pool,
      RELEASE_B,
      recoveryState({
        staged: 2,
        nonterminal: 1,
        leases: 0,
        unplannedQueuedJobIds: [String(unplannedReview)],
      }),
    );
    expect(withoutLease.state).toBe("recovery");
    expect(withoutLease.restoredLegacyJobs).toBe(1);
    expect(withoutLease.remainingNonterminalGenerations).toBe(1);
    expect((await queuedJobState(pool, unplannedReview)).held).toBe(false);
    expect((await queuedJobState(pool, plannedReview)).held).toBe(true);
    expect(await hasCapability(pool, `publication-controller-recovery:${RELEASE_A}`)).toBe(true);
    expect(await publicationControllerConsumerReady(pool, RELEASE_A)).toBe(true);

    const completed = await deactivatePublicationControllerRelease(
      pool,
      RELEASE_B,
      recoveryState({
        staged: 2,
        nonterminal: 0,
        leases: 0,
        unplannedQueuedJobIds: [String(plannedReview)],
      }),
    );
    expect(completed).toEqual({
      routingRemoved: false,
      state: "dark",
      releaseSha: RELEASE_A,
      restoredLegacyJobs: 1,
      remainingNonterminalGenerations: 0,
      activeMutationLeases: 0,
    });
    expect((await queuedJobState(pool, unplannedReview)).held).toBe(false);
    expect((await queuedJobState(pool, plannedReview)).held).toBe(false);
    expect(await hasCapability(pool, `publication-controller-recovery:${RELEASE_A}`)).toBe(false);
    expect(await publicationControllerConsumerReady(pool, RELEASE_A)).toBe(false);
    expect(await jobCount(pool)).toBe(before);
  });

  test("production recovery reader restores exact held work when no generation exists", async () => {
    await prepareRelease(pool, RELEASE_A);
    const review = await insertQueuedMutator(
      pool,
      "review",
      "2040-05-12T03:04:05.000Z",
    );
    const gate = await insertQueuedMutator(
      pool,
      "gate-state-sync",
      "2040-05-13T03:04:05.000Z",
    );
    const cleanup = await insertQueuedMutator(
      pool,
      "check-run-cleanup",
      "2040-05-14T03:04:05.000Z",
    );
    await activatePublicationControllerRelease(pool, RELEASE_A);

    const result = await deactivatePublicationControllerRelease(
      pool,
      RELEASE_B,
      readProductionPublicationControllerRecoveryState,
    );
    expect(result).toEqual({
      routingRemoved: true,
      state: "dark",
      releaseSha: RELEASE_A,
      restoredLegacyJobs: 1,
      remainingNonterminalGenerations: 0,
      activeMutationLeases: 0,
    });
    await activateQueueLockGeneration(pool);
    expect((await queuedJobState(pool, review)).held).toBe(false);
    expect((await queuedJobState(pool, gate)).held).toBe(false);
    expect((await queuedJobState(pool, cleanup)).held).toBe(false);
  });

  test("recovery reader mismatch fails closed without removing readiness", async () => {
    await prepareRelease(pool, RELEASE_A);
    await insertQueuedMutator(
      pool,
      "gate-state-sync",
      "2040-06-02T03:04:05.000Z",
    );
    await activatePublicationControllerRelease(pool, RELEASE_A);

    await expect(
      deactivatePublicationControllerRelease(
        pool,
        RELEASE_B,
        async () => ({
          releaseSha: RELEASE_B,
          stagedGenerations: 0,
          nonterminalGenerations: 0,
          activeMutationLeases: 0,
          unplannedQueuedJobIds: [],
        }),
      ),
    ).rejects.toThrow("invalid exact release state");
    await expect(
      deactivatePublicationControllerRelease(
        pool,
        RELEASE_B,
        recoveryState({
          staged: 1,
          nonterminal: 1,
          leases: 0,
          unplannedQueuedJobIds: ["999999"],
        }),
      ),
    ).rejects.toThrow("outside the exact held release");
    expect(await hasCapability(pool, `publication-controller-recovery:${RELEASE_A}`)).toBe(true);
    expect(await publicationControllerConsumerReady(pool, RELEASE_A)).toBe(true);
  });

  test("unclassified held work prevents terminal recovery acknowledgement", async () => {
    await prepareRelease(pool, RELEASE_A);
    const planned = await insertQueuedMutator(
      pool,
      "review",
      "2040-07-02T03:04:05.000Z",
    );
    await activatePublicationControllerRelease(pool, RELEASE_A);
    await expect(
      deactivatePublicationControllerRelease(
        pool,
        RELEASE_B,
        recoveryState({ staged: 1, nonterminal: 0, leases: 0 }),
      ),
    ).rejects.toThrow("does not classify every held controller job");
    expect(await hasCapability(pool, `publication-controller-recovery:${RELEASE_A}`)).toBe(true);
    expect(await publicationControllerConsumerReady(pool, RELEASE_A)).toBe(true);

    await markJobDone(pool, planned);
    const completed = await deactivatePublicationControllerRelease(
      pool,
      RELEASE_B,
      recoveryState({ staged: 1, nonterminal: 0, leases: 0 }),
    );
    expect(completed.state).toBe("dark");
    expect(await publicationControllerConsumerReady(pool, RELEASE_A)).toBe(false);
  });
});

const noMutationProbe: PublicationControllerNoMutationProbe = async (input) => {
  await input.client.query("SELECT 1");
  return {
    releaseSha: input.releaseSha,
    mode: "no-mutation",
    observedMutationCount: 0,
    checkedJobKinds: input.jobKinds,
  };
};

async function prepareRelease(pool: Pool, releaseSha: string): Promise<void> {
  const dark = await deactivatePublicationControllerRelease(pool, releaseSha);
  expect(dark.state).toBe("dark");
  await recordPublicationControllerCliPreflight(pool, releaseSha);
  await recordPublicationControllerConsumerReady(
    pool,
    releaseSha,
    noMutationProbe,
  );
}

async function applyMigrationFile(pool: Pool, file: string): Promise<void> {
  const source = await readFile(join(DRIZZLE_DIRECTORY, file), "utf8");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const statement of source.split("--> statement-breakpoint")) {
      if (statement.trim()) await client.query(statement);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function recoveryState(input: {
  staged: number;
  nonterminal: number;
  leases: number;
  unplannedQueuedJobIds?: readonly string[];
}): PublicationControllerRecoveryStateReader {
  return async ({ client, releaseSha }) => {
    await client.query("SELECT 1");
    return {
      releaseSha,
      stagedGenerations: input.staged,
      nonterminalGenerations: input.nonterminal,
      activeMutationLeases: input.leases,
      unplannedQueuedJobIds: input.unplannedQueuedJobIds ?? [],
    };
  };
}

async function insertQueuedMutator(
  pool: Pool,
  kind: TestMutatorKind,
  runAfter: string,
): Promise<number> {
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO jobs (kind, payload, status, run_after)
     VALUES ($1, '{}'::jsonb, 'queued', $2::timestamptz)
     RETURNING id`,
    [kind, runAfter],
  );
  return Number(inserted.rows[0]!.id);
}

async function insertQueuedReview(
  pool: Pool,
  payload: Record<string, unknown>,
  runAfter: string,
): Promise<number> {
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO jobs (kind, payload, status, run_after)
     VALUES ('review', $1::jsonb, 'queued', $2::timestamptz)
     RETURNING id`,
    [JSON.stringify(payload), runAfter],
  );
  return Number(inserted.rows[0]!.id);
}

async function insertRunningMutator(
  pool: Pool,
  kind: TestMutatorKind,
  worker: string,
) {
  const inserted = await pool.query<{ id: string; lock_generation: string }>(
    `INSERT INTO jobs (
       kind, payload, status, attempts, locked_at, locked_by, lock_generation
     ) VALUES ($1, '{}'::jsonb, 'running', 1, now(), $2, 1)
     RETURNING id, lock_generation::text`,
    [kind, worker],
  );
  return {
    id: Number(inserted.rows[0]!.id),
    lockedBy: worker,
    lockGeneration: BigInt(inserted.rows[0]!.lock_generation),
  };
}

async function claimAsLegacyWorker(pool: Pool, id: number, worker: string) {
  const claimed = await pool.query<{
    status: string;
    attempts: number;
    held: boolean;
  }>(
    `UPDATE jobs
        SET status = 'running', attempts = attempts + 1,
            locked_at = clock_timestamp(), locked_by = $2,
            lock_generation = lock_generation + 1
      WHERE id = $1 AND status = 'queued'
     RETURNING status, attempts,
               run_after = 'infinity'::timestamptz AS held`,
    [id, worker],
  );
  return claimed.rows[0];
}

async function queuedJobState(pool: Pool, id: number) {
  const result = await pool.query<{
    held: boolean;
    release_sha: string | null;
    scheduled_for: Date | null;
  }>(
    `SELECT run_after = 'infinity'::timestamptz AS held,
            payload->>'_postilPublicationControllerReleaseSha' AS release_sha,
            COALESCE(
              (payload->>'_postilPublicationControllerRunAfter')::timestamptz,
              CASE
                WHEN run_after <> 'infinity'::timestamptz THEN run_after
                ELSE NULL
              END
            ) AS scheduled_for
       FROM jobs
      WHERE id = $1`,
    [id],
  );
  const row = result.rows[0]!;
  return {
    held: row.held,
    releaseSha: row.release_sha,
    scheduledFor: row.scheduled_for?.toISOString() ?? null,
  };
}

async function storedJobPayload(
  pool: Pool,
  id: number,
): Promise<Record<string, unknown>> {
  const result = await pool.query<{ payload: Record<string, unknown> }>(
    "SELECT payload FROM jobs WHERE id = $1",
    [id],
  );
  return result.rows[0]!.payload;
}

async function jobLeaseState(pool: Pool, id: number) {
  const result = await pool.query<{
    status: string;
    attempts: number;
    lock_generation: string;
    release_sha: string | null;
    claim_release_sha: string | null;
    scheduled_for: Date | null;
  }>(
    `SELECT status, attempts, lock_generation::text,
            payload->>'_postilPublicationControllerReleaseSha' AS release_sha,
            payload->>'_postilPublicationControllerClaimReleaseSha' AS claim_release_sha,
            (payload->>'_postilPublicationControllerRunAfter')::timestamptz
              AS scheduled_for
       FROM jobs
      WHERE id = $1`,
    [id],
  );
  const row = result.rows[0]!;
  return {
    status: row.status,
    attempts: row.attempts,
    lockGeneration: BigInt(row.lock_generation),
    releaseSha: row.release_sha,
    claimReleaseSha: row.claim_release_sha,
    scheduledFor: row.scheduled_for?.toISOString() ?? null,
  };
}

async function markJobDone(pool: Pool, id: number): Promise<void> {
  await pool.query(
    `UPDATE jobs
        SET status = 'done', locked_at = NULL, locked_by = NULL
      WHERE id = $1`,
    [id],
  );
}

async function hasCapability(pool: Pool, name: string): Promise<boolean> {
  const result = await pool.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM deployment_capabilities WHERE name = $1
     ) AS present`,
    [name],
  );
  return result.rows[0]?.present === true;
}

async function jobCount(pool: Pool): Promise<number> {
  const result = await pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM jobs",
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function migrationFilesInJournalOrder(): Promise<string[]> {
  const journal = JSON.parse(
    await readFile(join(DRIZZLE_DIRECTORY, "meta", "_journal.json"), "utf8"),
  ) as { entries: Array<{ tag: string }> };

  return journal.entries.map((entry) => `${entry.tag}.sql`);
}
