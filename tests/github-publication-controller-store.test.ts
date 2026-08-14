import { createHash } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Pool } from "pg";

import {
  buildGitHubPublicationControllerManifest,
} from "@/lib/github-publication-controller-manifest";
import {
  parseGitHubPublicationPlanBytes,
  type ExpectedGitHubPublicationPlan,
} from "@/lib/github-publication-plan";
import {
  GitHubPublicationControllerStoreRejectedError,
  stageGitHubPublicationControllerGeneration,
} from "@/lib/github-publication-controller-store";
import {
  createEphemeralDatabase,
  type EphemeralDatabase,
} from "./ephemeral-database";

const TEST_URL = process.env.POSTIL_TEST_DATABASE_URL;
const describeDb = TEST_URL ? describe : describe.skip;
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const TARGET = "c".repeat(40);
const TITLE = "Store publication plans before any GitHub mutation";
const BODY = "The service seals exact accepted bytes before it executes an operation.";

describeDb("GitHub publication controller store", () => {
  let database: EphemeralDatabase;
  let pool: Pool;

  beforeAll(async () => {
    database = await createEphemeralDatabase("publication_controller_store");
    pool = database.pool;
  }, 60_000);

  afterAll(async () => {
    await database.drop();
  });

  test("stages, seals, exactly replays, and serializes a complete controller generation", async () => {
    const context = await createContext(1, 71, "17");
    const input = buildStageInput(context);

    const first = await stageGitHubPublicationControllerGeneration({ ...input, database: pool });
    expect(first).toMatchObject({
      repositoryId: BigInt(context.repositoryId),
      pullRequestNumber: 71,
      publicationGeneration: 17n,
      reviewId: BigInt(context.reviewId),
      acceptedPlanDigest: input.acceptedPlan.digest,
      controllerManifestDigest: input.controllerManifest.digest,
      status: "sealed",
      idempotent: false,
    });
    expect(first.sealedAt).toBeInstanceOf(Date);

    const stored = await pool.query<{
      sealed_at: Date | null;
      accepted_plan_bytes: Buffer;
      accepted_plan_digest: string;
      controller_manifest_bytes: Buffer;
      controller_manifest_digest: string;
      operation_count: number;
      controller_operation_count: number;
      operation_manifest_digest: string;
      controller_operation_manifest_digest: string;
    }>(
      `SELECT sealed_at, accepted_plan_bytes, accepted_plan_digest,
              controller_manifest_bytes, controller_manifest_digest, operation_count,
              controller_operation_count, operation_manifest_digest,
              controller_operation_manifest_digest
       FROM review_publication_generations
       WHERE repository_id = $1 AND pr_number = $2 AND publication_generation = $3`,
      [context.repositoryId, 71, "17"],
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]!.sealed_at).toBeInstanceOf(Date);
    expect(stored.rows[0]!.accepted_plan_bytes).toEqual(Buffer.from(input.acceptedPlan.bytes));
    expect(stored.rows[0]!.accepted_plan_digest).toBe(input.acceptedPlan.digest);
    expect(stored.rows[0]!.controller_manifest_bytes).toEqual(Buffer.from(input.controllerManifest.bytes));
    expect(stored.rows[0]!.controller_manifest_digest).toBe(input.controllerManifest.digest);
    expect(stored.rows[0]!.operation_count).toBe(input.acceptedPlan.value.operationCount);
    expect(stored.rows[0]!.controller_operation_count).toBe(input.controllerManifest.value.operationCount);
    expect(stored.rows[0]!.operation_manifest_digest).toBe(input.acceptedPlan.value.operationManifestDigest);
    expect(stored.rows[0]!.controller_operation_manifest_digest)
      .toBe(input.controllerManifest.value.operationManifestDigest);

    const edges = await pool.query<{ operation_key: string; dependency_operation_key: string }>(
      `SELECT operation_key, dependency_operation_key
       FROM review_publication_operation_dependencies
       WHERE repository_id = $1 AND pr_number = $2 AND publication_generation = $3
       ORDER BY operation_key, dependency_position`,
      [context.repositoryId, 71, "17"],
    );
    expect(edges.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        operation_key: input.acceptedPlan.value.operations[1]!.operationKey,
        dependency_operation_key: input.acceptedPlan.value.operations[0]!.operationKey,
      }),
    ]));

    const replay = await stageGitHubPublicationControllerGeneration({ ...input, database: pool });
    expect(replay).toMatchObject({ generationId: first.generationId, idempotent: true, status: "sealed" });

    const concurrentContext = await createContext(2, 72, "18");
    const concurrent = buildStageInput(concurrentContext);
    const both = await Promise.all([
      stageGitHubPublicationControllerGeneration({ ...concurrent, database: pool }),
      stageGitHubPublicationControllerGeneration({ ...concurrent, database: pool }),
    ]);
    expect(both.map((result) => result.generationId)).toEqual([both[0]!.generationId, both[0]!.generationId]);
    expect(both.map((result) => result.idempotent).sort()).toEqual([false, true]);
    const count = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM review_publication_generations
       WHERE repository_id = $1 AND pr_number = $2 AND publication_generation = $3`,
      [concurrentContext.repositoryId, 72, "18"],
    );
    expect(count.rows[0]!.count).toBe("1");
  }, 60_000);

  test("rejects mismatched artifacts and dependency records without partial generations", async () => {
    const context = await createContext(3, 73, "19");
    const input = buildStageInput(context);
    const mismatchedBytes = structuredClone(input.controllerManifest);
    mismatchedBytes.operationBytes[0] = Buffer.from("{}", "utf8");
    await expect(stageGitHubPublicationControllerGeneration({
      ...input,
      controllerManifest: mismatchedBytes,
      database: pool,
    })).rejects.toBeInstanceOf(GitHubPublicationControllerStoreRejectedError);

    const mismatchedDigest = structuredClone(input.controllerManifest);
    mismatchedDigest.digest = `sha256:${"f".repeat(64)}`;
    await expect(stageGitHubPublicationControllerGeneration({
      ...input,
      controllerManifest: mismatchedDigest,
      database: pool,
    })).rejects.toBeInstanceOf(GitHubPublicationControllerStoreRejectedError);

    const mismatchedDependencies = structuredClone(input.controllerManifest);
    mismatchedDependencies.value.operations[1]!.operation.dependencies = ["missing-operation"];
    await expect(stageGitHubPublicationControllerGeneration({
      ...input,
      controllerManifest: mismatchedDependencies,
      database: pool,
    })).rejects.toBeInstanceOf(GitHubPublicationControllerStoreRejectedError);

    const partial = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM review_publication_generations
       WHERE repository_id = $1 AND pr_number = $2`,
      [context.repositoryId, 73],
    );
    expect(partial.rows[0]!.count).toBe("0");
  });

  async function createContext(seed: number, prNumber: number, generation: string) {
    const organization = await pool.query<{ id: string }>(
      `INSERT INTO organizations (slug, name, github_org_id)
       VALUES ($1, $2, $3) RETURNING id`,
      [`controller-store-${seed}`, `Controller Store ${seed}`, 700_000 + seed],
    );
    const installation = await pool.query<{ id: string }>(
      `INSERT INTO installations (github_installation_id, account_login, account_type, org_id)
       VALUES ($1, $2, 'Organization', $3) RETURNING id`,
      [710_000 + seed, `controller-store-${seed}`, organization.rows[0]!.id],
    );
    const repository = await pool.query<{ id: string }>(
      `INSERT INTO repositories (github_repo_id, installation_id, full_name, private, enabled)
       VALUES ($1, $2, $3, false, true) RETURNING id`,
      [720_000 + seed, installation.rows[0]!.id, `controller-store-${seed}/service`],
    );
    const review = await pool.query<{ id: string }>(
      `INSERT INTO reviews
         (repository_id, pr_number, head_sha, base_sha, status, trigger_source, queued_at)
       VALUES ($1, $2, $3, $4, 'queued', 'unknown', now()) RETURNING id`,
      [repository.rows[0]!.id, prNumber, HEAD, BASE],
    );
    return {
      repositoryId: Number(repository.rows[0]!.id),
      repositoryFullName: `controller-store-${seed}/service`,
      reviewId: Number(review.rows[0]!.id),
      prNumber,
      generation,
    };
  }
});

function buildStageInput(context: {
  repositoryId: number;
  repositoryFullName: string;
  reviewId: number;
  prNumber: number;
  generation: string;
}) {
  const expected: ExpectedGitHubPublicationPlan = {
    controllerGeneration: context.generation,
    inputIdentity: digest(`input:${context.generation}`),
    reviewOutputDigest: digest(`output:${context.generation}`),
    repositoryId: String(context.repositoryId),
    repositoryFullName: context.repositoryFullName,
    pullRequestNumber: String(context.prNumber),
    headSha: HEAD,
    mergeBaseSha: BASE,
    targetSha: TARGET,
    pullRequestTitle: TITLE,
    pullRequestBody: BODY,
  };
  const raw = validPlan(expected);
  const acceptedPlan = parseGitHubPublicationPlanBytes(
    Buffer.from(`${JSON.stringify(raw)}\n`, "utf8"),
    expected,
  );
  const controllerManifest = buildGitHubPublicationControllerManifest({
    acceptedPlan: acceptedPlan.value,
    acceptedPlanBytesDigest: `sha256:${acceptedPlan.digest}`,
    requiredTerminalOperationKeys: [acceptedPlan.value.operations[1]!.operationKey],
    gateOutput: {
      conclusion: "success",
      title: "Publication gate complete",
      summary: "Every required publication operation reached a terminal state.",
      detailsUrl: "https://postil.dev/orgs/acme/runs/controller-store",
    },
  });
  return {
    acceptedPlan,
    controllerManifest,
    snapshot: {
      reviewId: context.reviewId,
      reviewInputSequence: context.generation,
      expectedPullRequestUpdatedAt: "2026-08-14T00:00:00.000Z",
      envelopeDigest: digestRaw(`envelope:${context.generation}`),
      targetBranch: "main",
      pullRequestTitle: TITLE,
      pullRequestBody: BODY,
    },
  };
}

function validPlan(expected: ExpectedGitHubPublicationPlan): Record<string, unknown> {
  const create = {
    ordinal: 1,
    operationKey: operationKey(expected, "advisory-check-create"),
    dependencies: [],
    activation: { anyOf: [{ condition: "always" }] },
    reconciliation: {
      logicalIdentity: `postil:postil/review:${HEAD}`,
      exclusive: true,
    },
    desiredDigest: "",
    kind: "advisoryCheckCreate",
    name: "postil/review",
    headSha: HEAD,
    status: "in_progress",
    externalId: `postil:postil/review:${HEAD}`,
  };
  create.desiredDigest = digestJson(desiredPayload(create));
  const complete = {
    ordinal: 2,
    operationKey: operationKey(expected, "advisory-check-complete"),
    dependencies: [create.operationKey],
    activation: { anyOf: [{ condition: "always" }] },
    reconciliation: { logicalIdentity: operationKey(expected, "advisory-check-complete"), exclusive: true },
    desiredDigest: "",
    kind: "advisoryCheckComplete",
    name: "postil/review",
    headSha: HEAD,
    createdCheck: { dependencyOperationKey: create.operationKey, resultField: "remoteId" },
    conclusion: "success",
    title: "Review completed",
    summary: "No advisory findings remain open.",
  };
  complete.desiredDigest = digestJson(desiredPayload(complete));
  const lifecycleReceipt = {
    version: 1,
    inputIdentity: expected.inputIdentity,
    channel: "reviewComments",
    receiptId: `receipt-${expected.controllerGeneration}`,
    duplicateOfBaseline: false,
    findings: [],
    digest: "",
  };
  lifecycleReceipt.digest = digestJson({
    version: lifecycleReceipt.version,
    inputIdentity: lifecycleReceipt.inputIdentity,
    channel: lifecycleReceipt.channel,
    receiptId: lifecycleReceipt.receiptId,
    compatibleReceiptIds: [],
    observedReviewId: null,
    duplicateOfBaseline: lifecycleReceipt.duplicateOfBaseline,
    findings: lifecycleReceipt.findings,
  });
  const plan: Record<string, any> = {
    version: 1,
    forge: "github",
    controllerGeneration: String(expected.controllerGeneration),
    inputIdentity: expected.inputIdentity,
    reviewOutputDigest: expected.reviewOutputDigest,
    repository: { id: String(expected.repositoryId), fullName: expected.repositoryFullName },
    pullRequestNumber: String(expected.pullRequestNumber),
    reviewedSnapshot: {
      headSha: HEAD,
      mergeBaseSha: BASE,
      targetSha: TARGET,
      pullRequestTitleSha256: digest(TITLE),
      pullRequestBodySha256: digest(BODY),
    },
    lifecycleReceipt,
    operationCount: 2,
    operationManifestDigest: digestJson([create, complete]),
    operations: [create, complete],
    gateAnalysis: {
      ownership: "service",
      authoritative: false,
      organizationGateModeRequired: true,
      name: "postil/gate",
      headSha: HEAD,
      analyzedConclusion: "success",
      title: "Advisory gate analysis",
      summary: "The service supplies authoritative gate output.",
    },
    intentDigest: "",
  };
  const { intentDigest: _, ...unsigned } = plan;
  plan.intentDigest = digestJson(unsigned);
  return plan;
}

function operationKey(expected: ExpectedGitHubPublicationPlan, kind: string): string {
  const hash = createHash("sha256").update("github-publication-operation-v1\0");
  for (const value of [
    String(expected.repositoryId),
    String(expected.pullRequestNumber),
    HEAD,
    String(expected.controllerGeneration),
    expected.inputIdentity,
    expected.reviewOutputDigest,
    kind,
  ]) hash.update(value).update("\0");
  return `github-publication-v1:${kind}:sha256:${hash.digest("hex")}`;
}

function desiredPayload(operation: Record<string, unknown>) {
  const { ordinal: _, operationKey: __, dependencies: ___, activation: ____, reconciliation: _____, desiredDigest: ______, ...desired } = operation;
  return desired;
}

function digest(value: string): string {
  return `sha256:${digestRaw(value)}`;
}

function digestRaw(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function digestJson(value: unknown): string {
  return digest(JSON.stringify(value));
}
