import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolClient, type QueryResult } from "pg";

import {
  buildGitHubPublicationInputIdentity,
  type BuiltGitHubPublicationInputIdentity,
} from "@/lib/github-publication-cli-planner";
import {
  createEphemeralDatabase,
  type EphemeralDatabase,
} from "./ephemeral-database";

const TEST_URL = process.env.POSTIL_TEST_DATABASE_URL;
const describeDb = TEST_URL ? describe : describe.skip;

const INPUT_ONE = "1".repeat(64);
const INPUT_TWO = "2".repeat(64);
const ENVELOPE_DIGEST = "3".repeat(64);
const PLAN_SEMANTIC_DIGEST = "4".repeat(64);
const REVIEW_OUTPUT_DIGEST = `sha256:${"5".repeat(64)}`;
const BASE_SHA = "a".repeat(40);
const TARGET_SHA = "b".repeat(40);
const KEY_DIGESTS = ["a", "b", "c", "d", "e", "f"] as const;
const REAL_OPERATION_KEYS = [
  `github-publication-v1:composite-review:sha256:${"a".repeat(64)}`,
  `github-publication-v1:file-comment-fallback:sha256:${"b".repeat(64)}`,
  `github-publication-v1:advisory-check:sha256:${"c".repeat(64)}`,
  `github-publication-v1:gate-check:sha256:${"d".repeat(64)}`,
] as const;

type Queryable = {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<T>>;
};

interface OperationFixture {
  ordinal: number;
  operationKey: string;
  operationSource: "cli" | "service";
  dependencies: string[];
  activation: Record<string, unknown>;
  activationBytes: Buffer;
  kind: string;
  desiredPayload: Record<string, unknown>;
  desiredPayloadBytes: Buffer;
  desiredPayloadDigest: string;
  controllerRecord: Record<string, unknown>;
  controllerRecordBytes: Buffer;
  operationRecord: Record<string, unknown>;
  operationRecordBytes: Buffer;
}

interface PublicationFixture {
  repositoryId: number;
  githubRepositoryId: number;
  repositoryFullName?: string;
  prNumber: number;
  generation: string;
  reviewId: number;
  inputDigest: string;
  acceptedInput?: BuiltGitHubPublicationInputIdentity;
  headSha: string;
  operations: OperationFixture[];
  cliOperations?: OperationFixture[];
}

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function nulJoinedSha256(prefix: string, values: readonly (string | number)[]) {
  const hash = createHash("sha256").update(`${prefix}\0`);
  for (const value of values) hash.update(String(value)).update("\0");
  return hash.digest("hex");
}

function operationKey(kind: string, seed: number) {
  const nibble = KEY_DIGESTS[seed % KEY_DIGESTS.length]!;
  return `github-publication-v1:${kind}:sha256:${nibble.repeat(64)}`;
}

function makeOperation(input: {
  ordinal: number;
  operationKey?: string;
  dependencies?: string[];
  activation?: Record<string, unknown>;
  kind?: string;
  body?: string;
  operationSource?: "cli" | "service";
  reconciliation?: Record<string, unknown>;
}): OperationFixture {
  const operationKeyValue = input.operationKey
    ?? operationKey("composite-review", input.ordinal);
  const dependencies = input.dependencies ?? [];
  const operationSource = input.operationSource ?? "cli";
  const activation = input.activation ?? { anyOf: [{ condition: "always" }] };
  const kind = input.kind ?? "reviewCreate";
  const desiredPayload = kind === "reviewCreate"
    ? {
        kind,
        attempt: "initial",
        logicalReviewIdentity: `review-${input.ordinal}`,
        payload: {
          commitId: "c".repeat(40),
          event: "COMMENT",
          body: input.body ?? `review ${input.ordinal}`,
          comments: [],
        },
      }
    : kind === "gateCheckCreate"
      ? {
          kind,
          payload: {
            name: "postil/gate",
            headSha: "c".repeat(40),
            status: "in_progress",
            externalId: "postil-gate-v1:fixture",
            detailsUrl: "https://postil.example/reviews/fixture",
          },
        }
      : kind === "gateCheckComplete"
        ? {
            kind,
            remoteId: { source: "operation", operationKey: "fixture" },
            payload: {
              name: "postil/gate",
              headSha: "c".repeat(40),
              status: "completed",
              conclusion: "success",
              title: "Review complete",
              summary: "The accepted publication plan is complete.",
              detailsUrl: "https://postil.example/reviews/fixture",
            },
          }
        : {
        kind,
        findingId: `finding-${input.ordinal}`,
        payload: {
          body: input.body ?? `finding ${input.ordinal}`,
          commitId: "c".repeat(40),
          path: "src/example.ts",
          subjectType: "file",
        },
        };
  const desiredPayloadBytes = Buffer.from(JSON.stringify(desiredPayload));
  const desiredPayloadDigest = `sha256:${sha256(desiredPayloadBytes)}`;
  const reconciliation = input.reconciliation ?? {
    logicalIdentity: `logical-${input.ordinal}`,
    markers: [`marker-${input.ordinal}`],
    exclusive: true,
  };
  const operationRecord = {
    ordinal: input.ordinal,
    operationKey: operationKeyValue,
    dependencies,
    activation,
    reconciliation,
    desiredDigest: desiredPayloadDigest,
    ...desiredPayload,
  };
  const controllerRecord = { source: operationSource, operation: operationRecord };
  return {
    ordinal: input.ordinal,
    operationKey: operationKeyValue,
    operationSource,
    dependencies,
    activation,
    activationBytes: Buffer.from(JSON.stringify(activation)),
    kind,
    desiredPayload,
    desiredPayloadBytes,
    desiredPayloadDigest,
    controllerRecord,
    controllerRecordBytes: Buffer.from(canonicalJson(controllerRecord)),
    operationRecord,
    operationRecordBytes: Buffer.from(JSON.stringify(operationRecord)),
  };
}

function withServiceGateOperations(input: Omit<PublicationFixture, "operations"> & {
  cliOperations: OperationFixture[];
}) {
  const detailsUrl = `https://postil.example/reviews/${input.prNumber}`;
  const gateOutput = {
    conclusion: "success",
    title: "Review complete",
    summary: "The accepted publication plan is complete.",
    detailsUrl,
  };
  const gateOutputDigest = `sha256:${sha256(canonicalJson(gateOutput))}`;
  const common = [
    String(input.githubRepositoryId),
    input.prNumber,
    input.headSha,
    input.generation,
    `sha256:${input.inputDigest}`,
    REVIEW_OUTPUT_DIGEST,
  ];
  const externalId = `postil-gate-v1:${nulJoinedSha256(
    "github-publication-controller-gate-external-id-v1",
    [...common, gateOutputDigest],
  )}`;
  const gateCreateKey = `github-publication-controller-v1:gate-create:sha256:${nulJoinedSha256(
    "github-publication-controller-gate-operation-v1",
    [...common, "gate-create", gateOutputDigest],
  )}`;
  const gateCompleteKey = `github-publication-controller-v1:gate-complete:sha256:${nulJoinedSha256(
    "github-publication-controller-gate-operation-v1",
    [...common, "gate-complete", gateOutputDigest],
  )}`;
  const gateCreate = makeOperation({
    ordinal: input.cliOperations.length + 1,
    operationKey: gateCreateKey,
    dependencies: [],
    activation: { anyOf: [{ condition: "always" }] },
    reconciliation: { logicalIdentity: externalId, exclusive: true },
    kind: "gateCheckCreate",
    operationSource: "service",
  });
  const gateComplete = makeOperation({
    ordinal: input.cliOperations.length + 2,
    operationKey: gateCompleteKey,
    dependencies: [gateCreate.operationKey, ...input.cliOperations.map((operation) => operation.operationKey)],
    activation: { anyOf: [{ condition: "allDependenciesTerminal" }] },
    reconciliation: {
      logicalIdentity: externalId,
      exclusive: true,
      remoteId: { source: "operation", operationKey: gateCreate.operationKey },
    },
    kind: "gateCheckComplete",
    operationSource: "service",
  });
  const createPayload = (gateCreate.desiredPayload.payload as Record<string, unknown>);
  createPayload.headSha = input.headSha;
  createPayload.externalId = externalId;
  createPayload.detailsUrl = detailsUrl;
  const completePayload = (gateComplete.desiredPayload.payload as Record<string, unknown>);
  completePayload.headSha = input.headSha;
  completePayload.detailsUrl = detailsUrl;
  (gateComplete.desiredPayload.remoteId as Record<string, unknown>).operationKey = gateCreate.operationKey;
  gateCreate.desiredPayloadBytes = Buffer.from(JSON.stringify(gateCreate.desiredPayload));
  gateCreate.desiredPayloadDigest = `sha256:${sha256(gateCreate.desiredPayloadBytes)}`;
  gateComplete.desiredPayloadBytes = Buffer.from(JSON.stringify(gateComplete.desiredPayload));
  gateComplete.desiredPayloadDigest = `sha256:${sha256(gateComplete.desiredPayloadBytes)}`;
  for (const operation of [gateCreate, gateComplete]) {
    operation.operationRecord = {
      ordinal: operation.ordinal,
      operationKey: operation.operationKey,
      dependencies: operation.dependencies,
      activation: operation.activation,
      reconciliation: operation.operationRecord.reconciliation,
      desiredDigest: operation.desiredPayloadDigest,
      ...operation.desiredPayload,
    };
    operation.operationRecordBytes = Buffer.from(JSON.stringify(operation.operationRecord));
    operation.controllerRecord = { source: operation.operationSource, operation: operation.operationRecord };
    operation.controllerRecordBytes = Buffer.from(canonicalJson(operation.controllerRecord));
  }
  return [...input.cliOperations, gateCreate, gateComplete];
}

function publicationFixture(input: Omit<PublicationFixture, "operations" | "acceptedInput"> & {
  cliOperations: OperationFixture[];
}): PublicationFixture {
  const repositoryFullName = input.repositoryFullName
    ?? `publication-${input.githubRepositoryId - 300000}/repository`;
  const acceptedInput = buildFixtureAcceptedInput({
    ...input,
    repositoryFullName,
    configurationDigest: input.inputDigest,
  });
  const normalized = {
    ...input,
    repositoryFullName,
    acceptedInput,
    inputDigest: acceptedInput.digest.slice("sha256:".length),
  };
  return {
    ...normalized,
    operations: withServiceGateOperations(normalized),
  };
}

function buildFixtureAcceptedInput(input: {
  repositoryId: number;
  githubRepositoryId: number;
  repositoryFullName: string;
  prNumber: number;
  generation: string;
  reviewId: number;
  headSha: string;
  configurationDigest: string;
  baseline?: boolean;
  detailsUrl?: string;
  cliVersion?: string;
  providerIdentity?: string;
  retryLineage?: string;
}) {
  return buildGitHubPublicationInputIdentity({
    databaseRepositoryId: String(input.repositoryId),
    githubRepositoryId: String(input.githubRepositoryId),
    repositoryFullName: input.repositoryFullName,
    pullRequestNumber: String(input.prNumber),
    controllerGeneration: input.generation,
    reviewId: String(input.reviewId),
    headSha: input.headSha,
    mergeBaseSha: BASE_SHA,
    targetSha: TARGET_SHA,
    targetBranch: "main",
    pullRequestTitle: "Publication foundation",
    pullRequestBody: "",
    expectedPullRequestUpdatedAt: "2026-08-14T00:00:00.000Z",
    cliVersion: input.cliVersion ?? "0.8.17",
    cliCommitSha: "d".repeat(40),
    cliArtifactSha256: `sha256:${"6".repeat(64)}`,
    configurationSha256: `sha256:${input.configurationDigest}`,
    providerIdentity: input.providerIdentity ?? "provider-v1",
    retryLineage: input.retryLineage ?? `review:${input.reviewId}:attempt:1`,
    ...(input.baseline
      ? {
          baselineReviewId: String(input.reviewId),
          baselineHeadSha: "e".repeat(40),
          baselineEnvelopeSha256: `sha256:${"7".repeat(64)}`,
        }
      : {}),
    bounded: true,
    forceFullReview: false,
    ...(input.detailsUrl === undefined ? {} : { detailsUrl: input.detailsUrl }),
  });
}

function manifestDigest(operations: OperationFixture[]) {
  const bytes = Buffer.from(
    `[${operations.map((operation) => operation.operationRecordBytes.toString()).join(",")}]`,
  );
  return `sha256:${sha256(bytes)}`;
}

function controllerManifestDigest(operations: OperationFixture[]) {
  const bytes = Buffer.from(
    `[${operations.map((operation) => operation.controllerRecordBytes.toString()).join(",")}]`,
  );
  return `sha256:${sha256(bytes)}`;
}

describeDb("durable publication foundation migration", () => {
  let database: EphemeralDatabase;
  let pool: Pool;
  let repositoryId = 0;
  let githubRepositoryId = 0;
  let installationId = 0;

  async function createHierarchy(seed: number, queryable: Queryable = pool) {
    const organization = await queryable.query<{ id: string }>(
      `INSERT INTO organizations (slug, name, github_org_id)
       VALUES ($1, $2, $3) RETURNING id`,
      [`publication-${seed}`, `Publication ${seed}`, 100000 + seed],
    );
    const installation = await queryable.query<{ id: string }>(
      `INSERT INTO installations
         (github_installation_id, account_login, account_type, org_id)
       VALUES ($1, $2, 'Organization', $3) RETURNING id`,
      [200000 + seed, `publication-${seed}`, organization.rows[0]!.id],
    );
    const repository = await queryable.query<{ id: string }>(
      `INSERT INTO repositories
         (github_repo_id, installation_id, full_name, private, enabled)
       VALUES ($1, $2, $3, false, true) RETURNING id`,
      [300000 + seed, installation.rows[0]!.id, `publication-${seed}/repository`],
    );
    return {
      installationId: Number(installation.rows[0]!.id),
      repositoryId: Number(repository.rows[0]!.id),
      githubRepositoryId: 300000 + seed,
      repositoryFullName: `publication-${seed}/repository`,
    };
  }

  async function createReview(input: {
    repositoryId?: number;
    prNumber: number;
    headSha: string;
    targetSha?: string;
    queryable?: Queryable;
  }) {
    const result = await (input.queryable ?? pool).query<{ id: string }>(
      `INSERT INTO public.reviews
         (repository_id, pr_number, head_sha, base_sha, status, trigger_source, queued_at)
       VALUES ($1, $2, $3, $4, 'queued', 'unknown', now())
       RETURNING id`,
      [input.repositoryId ?? repositoryId, input.prNumber, input.headSha, input.targetSha ?? TARGET_SHA],
    );
    return Number(result.rows[0]!.id);
  }

  async function insertGeneration(input: PublicationFixture & {
    queryable?: Queryable;
    repositoryFullName?: string;
    baseSha?: string;
    targetSha?: string;
    planMutator?: (plan: Record<string, unknown>) => void;
    operationCount?: number;
    operationManifestDigest?: string;
    controllerOperationCount?: number;
    controllerOperationManifestDigest?: string;
    controllerManifestMutator?: (manifest: Record<string, unknown>) => void;
    controllerManifestBytes?: Buffer;
    acceptedInputMutator?: (acceptedInput: Record<string, unknown>) => void;
    acceptedInputBytes?: Buffer;
    reviewInputSequence?: string;
    createdAt?: string;
  }) {
    const queryable = input.queryable ?? pool;
    const baseSha = input.baseSha ?? BASE_SHA;
    const targetSha = input.targetSha ?? TARGET_SHA;
    const repositorySnapshot = await queryable.query<{ full_name: string }>(
      `SELECT full_name FROM repositories WHERE id = $1`,
      [input.repositoryId],
    );
    const repositoryFullName = input.repositoryFullName ?? repositorySnapshot.rows[0]!.full_name;
    const builtAcceptedInput = input.acceptedInput ?? buildFixtureAcceptedInput({
      ...input,
      repositoryFullName,
      configurationDigest: input.inputDigest,
    });
    const acceptedInput = structuredClone(builtAcceptedInput.value) as unknown as Record<string, unknown>;
    input.acceptedInputMutator?.(acceptedInput);
    const acceptedInputBytes = input.acceptedInputBytes
      ?? Buffer.from(canonicalJson(acceptedInput), "utf8");
    const acceptedInputDigest = sha256(acceptedInputBytes);
    const cliOperations = input.cliOperations
      ?? input.operations.filter((operation) => operation.operationSource === "cli");
    const operationCount = input.operationCount ?? cliOperations.length;
    const operationManifestDigest = input.operationManifestDigest
      ?? manifestDigest(cliOperations);
    const plan: Record<string, unknown> = {
      version: 1,
      forge: "github",
      controllerGeneration: input.generation,
      inputIdentity: `sha256:${acceptedInputDigest}`,
      reviewOutputDigest: REVIEW_OUTPUT_DIGEST,
      repository: {
        id: String(input.githubRepositoryId),
        fullName: repositoryFullName,
      },
      pullRequestNumber: String(input.prNumber),
      reviewedSnapshot: {
        headSha: input.headSha,
        mergeBaseSha: baseSha,
        targetSha,
        pullRequestTitleSha256: `sha256:${sha256("Publication foundation")}`,
        pullRequestBodySha256: `sha256:${sha256("")}`,
      },
      lifecycleReceipt: { inputIdentity: `sha256:${acceptedInputDigest}` },
      operationCount,
      operationManifestDigest,
      operations: cliOperations.map((operation) => operation.operationRecord),
      gateAnalysis: {
        ownership: "service",
        authoritative: false,
        organizationGateModeRequired: true,
        name: "postil/gate",
        headSha: input.headSha,
        analyzedConclusion: "success",
        title: "Review gate",
        summary: "Review complete",
        detailsUrl: `https://postil.example/reviews/${input.prNumber}`,
      },
      intentDigest: `sha256:${PLAN_SEMANTIC_DIGEST}`,
    };
    input.planMutator?.(plan);
    const acceptedPlanBytes = Buffer.from(`${JSON.stringify(plan)}\n`);
    const controllerOperationCount = input.controllerOperationCount ?? input.operations.length;
    const controllerOperationManifestDigest = input.controllerOperationManifestDigest
      ?? controllerManifestDigest(input.operations);
    const controllerManifest: Record<string, unknown> = {
      version: "github-publication-controller-v1",
      forge: "github",
      controllerGeneration: input.generation,
      inputIdentity: `sha256:${acceptedInputDigest}`,
      reviewOutputDigest: REVIEW_OUTPUT_DIGEST,
      repository: {
        id: String(input.githubRepositoryId),
        fullName: repositoryFullName,
      },
      pullRequestNumber: String(input.prNumber),
      headSha: input.headSha,
      acceptedPlanIntentDigest: `sha256:${PLAN_SEMANTIC_DIGEST}`,
      acceptedPlanOperationManifestDigest: operationManifestDigest,
      acceptedPlanBytesDigest: `sha256:${sha256(acceptedPlanBytes)}`,
      acceptedCliOperationCount: operationCount,
      operationCount: controllerOperationCount,
      operationManifestDigest: controllerOperationManifestDigest,
      operations: input.operations.map((operation) => operation.controllerRecord),
    };
    input.controllerManifestMutator?.(controllerManifest);
    const controllerManifestBytes = input.controllerManifestBytes
      ?? Buffer.from(canonicalJson(controllerManifest));
    await queryable.query(
      `INSERT INTO review_publication_generations
         (repository_id, pr_number, publication_generation, review_id, plan_version,
          accepted_plan, accepted_plan_bytes, accepted_plan_digest, plan_semantic_digest,
          review_input_sequence, expected_pull_request_updated_at, accepted_input,
          accepted_input_bytes, accepted_input_digest, envelope_digest, repository_full_name,
          head_sha, base_sha, target_sha,
          target_branch, pull_request_title, pull_request_body, operation_count,
          operation_manifest_digest, controller_operation_count,
          controller_operation_manifest_digest, controller_manifest,
          controller_manifest_bytes, controller_manifest_digest, created_at)
       VALUES ($1, $2, $3, $4, 'github-publication-v1', $5::jsonb, $6, $7, $8,
               $9, '2026-08-14T00:00:00Z', $10::jsonb, $11, $12, $13, $14, $15,
               $16, $17, 'main', 'Publication foundation', '', $18, $19, $20, $21,
               $22::jsonb, $23, $24, $25)`,
      [
        input.repositoryId,
        input.prNumber,
        input.generation,
        input.reviewId,
        JSON.stringify(plan),
        acceptedPlanBytes,
        sha256(acceptedPlanBytes),
        PLAN_SEMANTIC_DIGEST,
        input.reviewInputSequence ?? input.generation,
        JSON.stringify(acceptedInput),
        acceptedInputBytes,
        acceptedInputDigest,
        ENVELOPE_DIGEST,
        repositoryFullName,
        input.headSha,
        baseSha,
        targetSha,
        operationCount,
        operationManifestDigest,
        controllerOperationCount,
        controllerOperationManifestDigest,
        JSON.stringify(controllerManifest),
        controllerManifestBytes,
        `sha256:${sha256(controllerManifestBytes)}`,
        input.createdAt ?? "2026-08-14T00:00:00Z",
      ],
    );
  }

  async function insertOperation(
    fixture: PublicationFixture,
    operation: OperationFixture,
    queryable: Queryable = pool,
    overrides: {
      reviewId?: number;
      desiredPayload?: unknown;
      desiredPayloadBytes?: Buffer;
      desiredPayloadDigest?: string;
      operationRecordBytes?: Buffer;
      deadlineAt?: string | null;
    } = {},
  ) {
    await queryable.query(
      `INSERT INTO review_publication_operations
         (repository_id, pr_number, publication_generation, review_id,
          operation_key, operation_ordinal, operation_record, operation_record_bytes,
          operation_source, controller_record, controller_record_bytes, activation,
          activation_bytes, kind, desired_payload, desired_payload_bytes,
          desired_payload_digest, deadline_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10::jsonb, $11,
               $12::jsonb, $13, $14, $15::jsonb, $16, $17, $18)`,
      [
        fixture.repositoryId,
        fixture.prNumber,
        fixture.generation,
        overrides.reviewId ?? fixture.reviewId,
        operation.operationKey,
        operation.ordinal,
        JSON.stringify(operation.operationRecord),
        overrides.operationRecordBytes ?? operation.operationRecordBytes,
        operation.operationSource,
        JSON.stringify(operation.controllerRecord),
        operation.controllerRecordBytes,
        JSON.stringify(operation.activation),
        operation.activationBytes,
        operation.kind,
        JSON.stringify(overrides.desiredPayload ?? operation.desiredPayload),
        overrides.desiredPayloadBytes ?? operation.desiredPayloadBytes,
        overrides.desiredPayloadDigest ?? operation.desiredPayloadDigest,
        overrides.deadlineAt ?? null,
      ],
    );
  }

  async function insertDependencyEdges(
    fixture: PublicationFixture,
    operation: OperationFixture,
    queryable: Queryable = pool,
  ) {
    for (const [position, dependency] of operation.dependencies.entries()) {
      await queryable.query(
        `INSERT INTO review_publication_operation_dependencies
           (repository_id, pr_number, publication_generation, operation_key,
            dependency_position, dependency_operation_key)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          fixture.repositoryId,
          fixture.prNumber,
          fixture.generation,
          operation.operationKey,
          position,
          dependency,
        ],
      );
    }
  }

  async function preparePublication(input: {
    repositoryId?: number;
    githubRepositoryId?: number;
    repositoryFullName?: string;
    prNumber: number;
    generation?: string;
    inputDigest?: string;
    headSha?: string;
    operations?: OperationFixture[];
    seal?: boolean;
    queryable?: Queryable;
  }): Promise<PublicationFixture> {
    const queryable = input.queryable ?? pool;
    const fixtureRepositoryId = input.repositoryId ?? repositoryId;
    const fixtureGithubRepositoryId = input.githubRepositoryId ?? Number((await queryable.query<{
      github_repo_id: string;
    }>(
      `SELECT github_repo_id FROM repositories WHERE id = $1`,
      [fixtureRepositoryId],
    )).rows[0]!.github_repo_id);
    const generation = input.generation ?? "1";
    const headSha = input.headSha ?? input.prNumber.toString(16).padStart(40, "7").slice(-40);
    const cliOperations = input.operations ?? [makeOperation({ ordinal: 1 })];
    const reviewId = await createReview({
      repositoryId: fixtureRepositoryId,
      prNumber: input.prNumber,
      headSha,
      queryable,
    });
    const fixture = publicationFixture({
      repositoryId: fixtureRepositoryId,
      githubRepositoryId: fixtureGithubRepositoryId,
      repositoryFullName: input.repositoryFullName
        ?? `publication-${fixtureGithubRepositoryId - 300000}/repository`,
      prNumber: input.prNumber,
      generation,
      reviewId,
      inputDigest: input.inputDigest ?? INPUT_ONE,
      headSha,
      cliOperations,
    });
    await insertGeneration({
      ...fixture,
      queryable,
      repositoryFullName: input.repositoryFullName,
    });
    for (const operation of fixture.operations) await insertOperation(fixture, operation, queryable);
    for (const operation of fixture.operations) {
      await insertDependencyEdges(fixture, operation, queryable);
    }
    if (input.seal ?? true) await insertHighWater(fixture, queryable);
    return fixture;
  }

  async function insertHighWater(fixture: PublicationFixture, queryable: Queryable = pool) {
    await queryable.query(
      `INSERT INTO pull_request_publication_high_waters
         (repository_id, pr_number, publication_generation, accepted_review_id,
          accepted_input_digest, accepted_head_sha)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        fixture.repositoryId,
        fixture.prNumber,
        fixture.generation,
        fixture.reviewId,
        fixture.inputDigest,
        fixture.headSha,
      ],
    );
  }

  async function claimOperation(input: {
    fixture: PublicationFixture;
    operation: OperationFixture;
    owner?: string;
    leaseId?: string;
    variant?: string;
    expiresOffset?: string;
    queryable?: Queryable;
  }) {
    const queryable = input.queryable ?? pool;
    const result = await queryable.query<{
      attempt_count: number;
      lease_generation: string;
      lease_id: string;
    }>(
      `UPDATE review_publication_operations
       SET state = 'applying',
           attempt_count = attempt_count + 1,
           lease_generation = lease_generation + 1,
           claim_owner = $5,
           lease_id = $6,
           lease_expires_at = clock_timestamp() + $7::interval,
           selected_variant = $8
       WHERE repository_id = $1 AND pr_number = $2
         AND publication_generation = $3 AND operation_key = $4
       RETURNING attempt_count, lease_generation, lease_id`,
      [
        input.fixture.repositoryId,
        input.fixture.prNumber,
        input.fixture.generation,
        input.operation.operationKey,
        input.owner ?? "worker-one",
        input.leaseId ?? randomUUID(),
        input.expiresOffset ?? "10 minutes",
        input.variant ?? "primary",
      ],
    );
    return result.rows[0]!;
  }

  async function insertAttempt(input: {
    fixture: PublicationFixture;
    operation: OperationFixture;
    phase: "dispatched" | "not_dispatched" | "ambiguous" | "applied";
    attemptNumber: number;
    leaseGeneration: string;
    variant: string;
    evidence?: Record<string, unknown>;
    error?: string;
    remoteIdentity?: string;
    remoteOperationId?: string;
    queryable?: Queryable;
  }) {
    await (input.queryable ?? pool).query(
      `INSERT INTO review_publication_operation_attempts
         (repository_id, pr_number, publication_generation, operation_key,
          attempt_number, lease_generation, phase, selected_variant,
          evidence_payload, error_reason, remote_identity, remote_operation_id,
          observed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12,
               clock_timestamp())`,
      [
        input.fixture.repositoryId,
        input.fixture.prNumber,
        input.fixture.generation,
        input.operation.operationKey,
        input.attemptNumber,
        input.leaseGeneration,
        input.phase,
        input.variant,
        JSON.stringify(input.evidence ?? { phase: input.phase }),
        input.error ?? null,
        input.remoteIdentity ?? null,
        input.remoteOperationId ?? null,
      ],
    );
  }

  async function moveToUnknown(input: {
    fixture: PublicationFixture;
    operation: OperationFixture;
    error: string;
  }) {
    await pool.query(
      `UPDATE review_publication_operations
       SET state = 'unknown', claim_owner = NULL, lease_id = NULL,
           lease_expires_at = NULL, last_error = $5
       WHERE repository_id = $1 AND pr_number = $2
         AND publication_generation = $3 AND operation_key = $4`,
      [
        input.fixture.repositoryId,
        input.fixture.prNumber,
        input.fixture.generation,
        input.operation.operationKey,
        input.error,
      ],
    );
  }

  async function applyOperation(input: {
    fixture: PublicationFixture;
    operation: OperationFixture;
    queryable?: Queryable;
  }) {
    const queryable = input.queryable ?? pool;
    const claim = await claimOperation({
      fixture: input.fixture,
      operation: input.operation,
      queryable,
    });
    await insertAttempt({
      fixture: input.fixture,
      operation: input.operation,
      phase: "dispatched",
      attemptNumber: claim.attempt_count,
      leaseGeneration: claim.lease_generation,
      variant: "primary",
      queryable,
    });
    await insertAttempt({
      fixture: input.fixture,
      operation: input.operation,
      phase: "applied",
      attemptNumber: claim.attempt_count,
      leaseGeneration: claim.lease_generation,
      variant: "primary",
      remoteIdentity: "github-publication",
      remoteOperationId: `remote-${input.operation.ordinal}`,
      queryable,
    });
    await queryable.query(
      `UPDATE review_publication_operations
       SET state = 'applied', claim_owner = NULL, lease_id = NULL,
           lease_expires_at = NULL, last_error = NULL
       WHERE repository_id = $1 AND pr_number = $2
         AND publication_generation = $3 AND operation_key = $4`,
      [
        input.fixture.repositoryId,
        input.fixture.prNumber,
        input.fixture.generation,
        input.operation.operationKey,
      ],
    );
  }

  async function insertReconciliation(input: {
    fixture: PublicationFixture;
    operation: OperationFixture;
    attemptNumber: number;
    leaseGeneration: string;
    variant: string;
    phase: "retry" | "terminal";
    outcome: "exact_absence" | "applied";
    evidence?: Record<string, unknown>;
    queryable?: Queryable;
    observedAt?: Date;
  }) {
    await (input.queryable ?? pool).query(
      `INSERT INTO review_publication_operation_reconciliations
         (repository_id, pr_number, publication_generation, operation_key,
          attempt_number, lease_generation, phase, selected_variant, outcome,
          evidence_payload, remote_identity, remote_operation_id, observed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12,
               $13)`,
      [
        input.fixture.repositoryId,
        input.fixture.prNumber,
        input.fixture.generation,
        input.operation.operationKey,
        input.attemptNumber,
        input.leaseGeneration,
        input.phase,
        input.variant,
        input.outcome,
        JSON.stringify(input.evidence ?? { outcome: input.outcome }),
        input.outcome === "applied" ? "github-review" : null,
        input.outcome === "applied" ? "987654" : null,
        input.observedAt ?? new Date(),
      ],
    );
  }

  beforeAll(async () => {
    database = await createEphemeralDatabase("durable_publication_foundation");
    pool = database.pool;
    const hierarchy = await createHierarchy(1);
    repositoryId = hierarchy.repositoryId;
    githubRepositoryId = hierarchy.githubRepositoryId;
    installationId = hierarchy.installationId;
  }, 30_000);

  afterAll(async () => {
    await database.drop();
  });

  test("seals exact CLI operation bytes, ordered edges, and all real key kinds", async () => {
    const first = makeOperation({ ordinal: 1, operationKey: REAL_OPERATION_KEYS[0] });
    const second = makeOperation({
      ordinal: 2,
      operationKey: REAL_OPERATION_KEYS[1],
      dependencies: [first.operationKey],
      activation: {
        anyOf: [{
          condition: "semanticPlacementRejected",
          dependencyOperationKey: first.operationKey,
          httpStatus: 422,
          classification: "inlinePlacement",
          markerAbsence: { markers: ["marker-1"] },
        }],
      },
      kind: "fileCommentFallback",
    });
    const third = makeOperation({
      ordinal: 3,
      operationKey: REAL_OPERATION_KEYS[2],
      dependencies: [first.operationKey, second.operationKey],
    });
    const fourth = makeOperation({
      ordinal: 4,
      operationKey: REAL_OPERATION_KEYS[3],
      dependencies: [first.operationKey, second.operationKey, third.operationKey],
    });
    const fixture = await preparePublication({
      prNumber: 101,
      operations: [first, second, third, fourth],
    });
    const generation = await pool.query<{
      operation_count: number;
      operation_manifest_digest: string;
      controller_operation_count: number;
      controller_operation_manifest_digest: string;
      sealed_at: Date | null;
    }>(
      `SELECT operation_count, operation_manifest_digest,
              controller_operation_count, controller_operation_manifest_digest, sealed_at
       FROM review_publication_generations
       WHERE repository_id = $1 AND pr_number = $2`,
      [repositoryId, fixture.prNumber],
    );
    expect(generation.rows[0]).toMatchObject({
      operation_count: 4,
      operation_manifest_digest: manifestDigest(fixture.cliOperations!),
      controller_operation_count: 6,
      controller_operation_manifest_digest: controllerManifestDigest(fixture.operations),
    });
    expect(generation.rows[0]!.sealed_at).toBeInstanceOf(Date);
    const edges = await pool.query<{ dependency_operation_key: string }>(
      `SELECT dependency_operation_key
       FROM review_publication_operation_dependencies
       WHERE repository_id = $1 AND pr_number = $2 AND operation_key = $3
       ORDER BY dependency_position`,
      [repositoryId, fixture.prNumber, fourth.operationKey],
    );
    expect(edges.rows.map((row) => row.dependency_operation_key)).toEqual(fourth.dependencies);
    await expect(insertOperation(fixture, makeOperation({ ordinal: 5 }))).rejects.toThrow(
      "sealed publication generations cannot accept operations",
    );
    await expect(
      pool.query(
        `INSERT INTO review_publication_operation_dependencies
           (repository_id, pr_number, publication_generation, operation_key,
            dependency_position, dependency_operation_key)
         VALUES ($1, $2, $3, $4, 0, $5)`,
        [repositoryId, fixture.prNumber, fixture.generation, first.operationKey, second.operationKey],
      ),
    ).rejects.toThrow("sealed publication generations cannot accept dependency edges");
  });

  test("retains and independently validates canonical accepted input artifacts", async () => {
    const fixtureFor = async (prNumber: number, headNibble: string) => {
      const headSha = headNibble.repeat(40);
      const reviewId = await createReview({ prNumber, headSha });
      return publicationFixture({
        repositoryId,
        githubRepositoryId,
        prNumber,
        generation: "1",
        reviewId,
        inputDigest: INPUT_ONE,
        headSha,
        cliOperations: [makeOperation({ ordinal: 1 })],
      });
    };

    const exact = await fixtureFor(131, "1");
    await insertGeneration(exact);
    const stored = await pool.query<{
      accepted_input: unknown;
      accepted_input_bytes: Buffer;
      accepted_input_digest: string;
    }>(
      `SELECT accepted_input, accepted_input_bytes, accepted_input_digest
       FROM review_publication_generations
       WHERE repository_id = $1 AND pr_number = $2`,
      [repositoryId, exact.prNumber],
    );
    expect(stored.rows[0]!.accepted_input).toEqual(exact.acceptedInput!.value);
    expect(stored.rows[0]!.accepted_input_bytes).toEqual(Buffer.from(exact.acceptedInput!.bytes));
    expect(stored.rows[0]!.accepted_input_digest).toBe(exact.inputDigest);

    const byteDrift = await fixtureFor(132, "2");
    await expect(insertGeneration({
      ...byteDrift,
      acceptedInputBytes: Buffer.concat([
        Buffer.from(byteDrift.acceptedInput!.bytes),
        Buffer.from("\n"),
      ]),
    })).rejects.toThrow("review_publication_generations_input_artifact_check");

    const semanticDrift = await fixtureFor(133, "3");
    await expect(insertGeneration({
      ...semanticDrift,
      acceptedInputMutator: (acceptedInput) => {
        acceptedInput.pullRequestTitleSha256 = `sha256:${"9".repeat(64)}`;
      },
    })).rejects.toThrow("accepted publication input does not match");

    const identityMismatch = await fixtureFor(134, "4");
    await expect(insertGeneration({
      ...identityMismatch,
      acceptedInputMutator: (acceptedInput) => {
        acceptedInput.databaseRepositoryId = String(repositoryId + 1);
      },
    })).rejects.toThrow("accepted publication input does not match");

    const sequenceMismatch = await fixtureFor(136, "6");
    await expect(insertGeneration({
      ...sequenceMismatch,
      reviewInputSequence: "2",
    })).rejects.toThrow("review_publication_generations_review_input_sequence_check");

    const optional = await fixtureFor(135, "5");
    const optionalAcceptedInput = buildFixtureAcceptedInput({
      repositoryId,
      githubRepositoryId,
      repositoryFullName: optional.repositoryFullName!,
      prNumber: optional.prNumber,
      generation: optional.generation,
      reviewId: optional.reviewId,
      headSha: optional.headSha,
      configurationDigest: INPUT_TWO,
      baseline: true,
      detailsUrl: "https://postil.example/reviews/135",
    });
    await insertGeneration({ ...optional, acceptedInput: optionalAcceptedInput });
    const optionalStored = await pool.query<{ accepted_input: Record<string, unknown> }>(
      `SELECT accepted_input FROM review_publication_generations
       WHERE repository_id = $1 AND pr_number = $2`,
      [repositoryId, optional.prNumber],
    );
    expect(optionalStored.rows[0]!.accepted_input).toMatchObject({
      baseline: {
        reviewId: String(optional.reviewId),
        headSha: "e".repeat(40),
        envelopeSha256: `sha256:${"7".repeat(64)}`,
      },
      detailsUrl: "https://postil.example/reviews/135",
    });

    const nearLimit = await fixtureFor(137, "7");
    const detailsPrefix = "https://postil.example/reviews/137/";
    const nearLimitAcceptedInput = buildFixtureAcceptedInput({
      repositoryId,
      githubRepositoryId,
      repositoryFullName: nearLimit.repositoryFullName!,
      prNumber: nearLimit.prNumber,
      generation: nearLimit.generation,
      reviewId: nearLimit.reviewId,
      headSha: nearLimit.headSha,
      configurationDigest: INPUT_TWO,
      baseline: true,
      cliVersion: "v".repeat(100),
      providerIdentity: "p".repeat(2_048),
      retryLineage: "r".repeat(200),
      detailsUrl: `${detailsPrefix}${"d".repeat(2_048 - detailsPrefix.length)}`,
    });
    await insertGeneration({ ...nearLimit, acceptedInput: nearLimitAcceptedInput });
    const nearLimitStored = await pool.query<{ accepted_input_bytes: Buffer }>(
      `SELECT accepted_input_bytes FROM review_publication_generations
       WHERE repository_id = $1 AND pr_number = $2`,
      [repositoryId, nearLimit.prNumber],
    );
    expect(nearLimitStored.rows[0]!.accepted_input_bytes).toEqual(
      Buffer.from(nearLimitAcceptedInput.bytes),
    );
    expect(nearLimitStored.rows[0]!.accepted_input_bytes.byteLength).toBeGreaterThan(4 * 1024);
    expect(nearLimitStored.rows[0]!.accepted_input_bytes.byteLength).toBeLessThan(16 * 1024);
  });

  test("rejects plan-envelope, manifest, forward-edge, and exact-byte mismatches", async () => {
    const headSha = "8".repeat(40);
    const reviewId = await createReview({ prNumber: 102, headSha });
    const operation = makeOperation({ ordinal: 1 });
    const fixture = publicationFixture({
      repositoryId,
      githubRepositoryId,
      prNumber: 102,
      generation: "1",
      reviewId,
      inputDigest: INPUT_ONE,
      headSha,
      cliOperations: [operation],
    });
    await expect(insertGeneration({
      ...fixture,
      planMutator: (plan) => {
        plan.controllerGeneration = "2";
      },
    })).rejects.toThrow("accepted publication plan does not match");

    await insertGeneration(fixture);
    const wrongBytes = Buffer.from(`${operation.operationRecordBytes.toString()} `);
    await insertOperation(fixture, operation, pool, { operationRecordBytes: wrongBytes });
    for (const serviceOperation of fixture.operations.slice(1)) {
      await insertOperation(fixture, serviceOperation);
      await insertDependencyEdges(fixture, serviceOperation);
    }
    await expect(insertHighWater(fixture)).rejects.toThrow(
      "stored CLI operations do not match the accepted CLI plan",
    );
    await pool.query(
      `UPDATE review_publication_generations SET operation_manifest_digest = $3
       WHERE repository_id = $1 AND pr_number = $2`,
      [repositoryId, fixture.prNumber, `sha256:${"f".repeat(64)}`],
    ).then(
      () => { throw new Error("generation mutation unexpectedly succeeded"); },
      (error) => expect(String(error)).toContain("review publication generation is immutable"),
    );

    const forwardFirst = makeOperation({ ordinal: 1 });
    const forwardSecond = makeOperation({
      ordinal: 2,
      dependencies: [forwardFirst.operationKey],
    });
    const forwardHead = "9".repeat(40);
    const forwardReview = await createReview({ prNumber: 103, headSha: forwardHead });
    const forwardFixture = publicationFixture({
      repositoryId,
      githubRepositoryId,
      prNumber: 103,
      generation: "1",
      reviewId: forwardReview,
      inputDigest: INPUT_ONE,
      headSha: forwardHead,
      cliOperations: [forwardFirst, forwardSecond],
    });
    await insertGeneration(forwardFixture);
    for (const publicationOperation of forwardFixture.operations) {
      await insertOperation(forwardFixture, publicationOperation);
      if (publicationOperation.operationSource === "service") {
        await insertDependencyEdges(forwardFixture, publicationOperation);
      }
    }
    await expect(
      pool.query(
        `INSERT INTO review_publication_operation_dependencies
           (repository_id, pr_number, publication_generation, operation_key,
            dependency_position, dependency_operation_key)
         VALUES ($1, $2, 1, $3, 0, $4)`,
        [repositoryId, forwardFixture.prNumber, forwardFirst.operationKey, forwardSecond.operationKey],
      ),
    ).rejects.toThrow("must reference an earlier ordinal");
    await expect(insertHighWater(forwardFixture)).rejects.toThrow(
      "dependency edges do not match the accepted operations",
    );
  });

  test("binds immutable GitHub repository identity without replacing internal foreign keys", async () => {
    const other = await createHierarchy(23);
    const headSha = "f".repeat(40);
    const reviewId = await createReview({ prNumber: 119, headSha });
    const fixture = publicationFixture({
      repositoryId,
      githubRepositoryId,
      prNumber: 119,
      generation: "1",
      reviewId,
      inputDigest: INPUT_ONE,
      headSha,
      cliOperations: [makeOperation({ ordinal: 1 })],
    });
    expect(fixture.repositoryId).not.toBe(fixture.githubRepositoryId);
    await expect(insertGeneration({
      ...fixture,
      planMutator: (plan) => {
        (plan.repository as Record<string, unknown>).id = String(other.githubRepositoryId);
      },
    })).rejects.toThrow("accepted publication plan does not match");
    await expect(insertGeneration({
      ...fixture,
      controllerManifestMutator: (manifest) => {
        (manifest.repository as Record<string, unknown>).id = String(other.githubRepositoryId);
      },
    })).rejects.toThrow("controller manifest does not bind");
    await insertGeneration(fixture);
  });

  test("authenticates the combined controller manifest without mutating accepted CLI intent", async () => {
    const exactBytesHead = "2".repeat(40);
    const exactBytesReview = await createReview({ prNumber: 110, headSha: exactBytesHead });
    const exactBytesFixture = publicationFixture({
      repositoryId,
      githubRepositoryId,
      prNumber: 110,
      generation: "1",
      reviewId: exactBytesReview,
      inputDigest: INPUT_ONE,
      headSha: exactBytesHead,
      cliOperations: [makeOperation({ ordinal: 1 })],
    });
    await expect(insertGeneration({
      ...exactBytesFixture,
      controllerManifestBytes: Buffer.from("{}"),
    })).rejects.toThrow("review_publication_generations_controller_manifest_check");
    const bindingMutations: Array<(manifest: Record<string, unknown>) => void> = [
      (manifest) => { manifest.controllerGeneration = "2"; },
      (manifest) => { manifest.inputIdentity = `sha256:${"6".repeat(64)}`; },
      (manifest) => { manifest.reviewOutputDigest = `sha256:${"6".repeat(64)}`; },
      (manifest) => {
        (manifest.repository as Record<string, unknown>).fullName = "other/repository";
      },
      (manifest) => { manifest.pullRequestNumber = "999"; },
      (manifest) => { manifest.headSha = "6".repeat(40); },
      (manifest) => { manifest.acceptedPlanIntentDigest = `sha256:${"6".repeat(64)}`; },
      (manifest) => {
        manifest.acceptedPlanOperationManifestDigest = `sha256:${"6".repeat(64)}`;
      },
      (manifest) => { manifest.acceptedPlanBytesDigest = `sha256:${"6".repeat(64)}`; },
      (manifest) => { manifest.acceptedCliOperationCount = 0; },
    ];
    for (const controllerManifestMutator of bindingMutations) {
      await expect(insertGeneration({
        ...exactBytesFixture,
        controllerManifestMutator,
      })).rejects.toThrow("controller manifest does not bind the accepted publication plan");
    }

    const omittedHead = "3".repeat(40);
    const omittedReview = await createReview({ prNumber: 111, headSha: omittedHead });
    const omittedFixture = publicationFixture({
      repositoryId,
      githubRepositoryId,
      prNumber: 111,
      generation: "1",
      reviewId: omittedReview,
      inputDigest: INPUT_ONE,
      headSha: omittedHead,
      cliOperations: [makeOperation({ ordinal: 1 })],
    });
    await insertGeneration({
      ...omittedFixture,
      controllerManifestMutator: (manifest) => {
        manifest.operations = (manifest.operations as unknown[]).slice(1);
      },
    });
    for (const publicationOperation of omittedFixture.operations) {
      await insertOperation(omittedFixture, publicationOperation);
      await insertDependencyEdges(omittedFixture, publicationOperation);
    }
    await expect(insertHighWater(omittedFixture)).rejects.toThrow(
      "stored publication operations do not match the controller manifest",
    );

    const alteredHead = "4".repeat(40);
    const alteredReview = await createReview({ prNumber: 112, headSha: alteredHead });
    const alteredFixture = publicationFixture({
      repositoryId,
      githubRepositoryId,
      prNumber: 112,
      generation: "1",
      reviewId: alteredReview,
      inputDigest: INPUT_ONE,
      headSha: alteredHead,
      cliOperations: [makeOperation({ ordinal: 1 })],
    });
    await insertGeneration({
      ...alteredFixture,
      controllerManifestMutator: (manifest) => {
        const records = structuredClone(manifest.operations as Record<string, unknown>[]);
        const firstOperation = records[0]!.operation as Record<string, unknown>;
        firstOperation.operationKey = REAL_OPERATION_KEYS[3];
        manifest.operations = records;
      },
    });
    for (const publicationOperation of alteredFixture.operations) {
      await insertOperation(alteredFixture, publicationOperation);
      await insertDependencyEdges(alteredFixture, publicationOperation);
    }
    await expect(insertHighWater(alteredFixture)).rejects.toThrow(
      "stored publication operations do not match the controller manifest",
    );

    const activationHead = "6".repeat(40);
    const activationReview = await createReview({ prNumber: 130, headSha: activationHead });
    const activationFixture = publicationFixture({
      repositoryId,
      githubRepositoryId,
      prNumber: 130,
      generation: "1",
      reviewId: activationReview,
      inputDigest: INPUT_ONE,
      headSha: activationHead,
      cliOperations: [makeOperation({ ordinal: 1 })],
    });
    await insertGeneration({
      ...activationFixture,
      controllerManifestMutator: (manifest) => {
        const records = structuredClone(manifest.operations as Record<string, unknown>[]);
        const firstOperation = records[0]!.operation as Record<string, unknown>;
        firstOperation.activation = {
          anyOf: [{ condition: "markerAbsent", guard: { markers: ["replacement"] } }],
        };
        manifest.operations = records;
      },
    });
    for (const publicationOperation of activationFixture.operations) {
      await insertOperation(activationFixture, publicationOperation);
      await insertDependencyEdges(activationFixture, publicationOperation);
    }
    await expect(insertHighWater(activationFixture)).rejects.toThrow(
      "stored publication operations do not match the controller manifest",
    );

    const digestHead = "5".repeat(40);
    const digestReview = await createReview({ prNumber: 113, headSha: digestHead });
    const digestFixture = publicationFixture({
      repositoryId,
      githubRepositoryId,
      prNumber: 113,
      generation: "1",
      reviewId: digestReview,
      inputDigest: INPUT_ONE,
      headSha: digestHead,
      cliOperations: [makeOperation({ ordinal: 1 })],
    });
    await insertGeneration({
      ...digestFixture,
      controllerOperationManifestDigest: `sha256:${"0".repeat(64)}`,
    });
    for (const publicationOperation of digestFixture.operations) {
      await insertOperation(digestFixture, publicationOperation);
      await insertDependencyEdges(digestFixture, publicationOperation);
    }
    await expect(insertHighWater(digestFixture)).rejects.toThrow(
      "stored publication operations do not match the controller manifest",
    );
  });

  test("validates service gate key wire shape and action pairing independently of payload digest", async () => {
    const validFixture = await preparePublication({ prNumber: 117 });
    for (const serviceOperation of validFixture.operations.filter(
      (operation) => operation.operationSource === "service",
    )) {
      expect(serviceOperation.operationKey.endsWith(serviceOperation.desiredPayloadDigest)).toBe(
        false,
      );
    }

    const headSha = "9".repeat(40);
    const reviewId = await createReview({ prNumber: 118, headSha });
    const fixture = publicationFixture({
      repositoryId,
      githubRepositoryId,
      prNumber: 118,
      generation: "1",
      reviewId,
      inputDigest: INPUT_ONE,
      headSha,
      cliOperations: [makeOperation({ ordinal: 1 })],
    });
    await insertGeneration(fixture);

    for (const invalidOperation of [
      makeOperation({
        ordinal: 2,
        operationKey: `github-publication-controller-v1:gate-create:sha256:${"a".repeat(63)}`,
        kind: "gateCheckCreate",
        operationSource: "service",
      }),
      makeOperation({
        ordinal: 2,
        operationKey: `github-publication-controller-v1:gate-create:${"a".repeat(64)}`,
        kind: "gateCheckCreate",
        operationSource: "service",
      }),
      makeOperation({
        ordinal: 2,
        operationKey: `github-publication-controller-v1:gate-complete:sha256:${"b".repeat(64)}`,
        kind: "gateCheckCreate",
        operationSource: "service",
      }),
      makeOperation({
        ordinal: 2,
        operationKey: `github-publication-controller-v1:gate-create:sha256:${"c".repeat(64)}`,
        kind: "gateCheckComplete",
        operationSource: "service",
      }),
    ]) {
      await expect(insertOperation(fixture, invalidOperation)).rejects.toThrow(
        "review_publication_operations_source_key_check",
      );
    }
  });

  test("bounds combined operation, dependency, and controller-manifest amplification", async () => {
    const oversizedCliOperations = Array.from({ length: 127 }, (_, index) => makeOperation({
      ordinal: index + 1,
      operationKey: `github-publication-v1:composite-review:sha256:${sha256(`operation-${index + 1}`)}`,
    }));
    const operationHead = "6".repeat(40);
    const operationReview = await createReview({ prNumber: 114, headSha: operationHead });
    const operationFixture = publicationFixture({
      repositoryId,
      githubRepositoryId,
      prNumber: 114,
      generation: "1",
      reviewId: operationReview,
      inputDigest: INPUT_ONE,
      headSha: operationHead,
      cliOperations: oversizedCliOperations,
    });
    await expect(insertGeneration(operationFixture)).rejects.toThrow(
      "review_publication_generations_cli_operation_manifest_check",
    );

    const dependencyHead = "7".repeat(40);
    const dependencyReview = await createReview({ prNumber: 115, headSha: dependencyHead });
    const dependencies = Array.from(
      { length: 128 },
      (_, index) => `github-publication-v1:composite-review:sha256:${sha256(`dependency-${index}`)}`,
    );
    const dependencyOperation = makeOperation({ ordinal: 1, dependencies });
    const dependencyFixture = publicationFixture({
      repositoryId,
      githubRepositoryId,
      prNumber: 115,
      generation: "1",
      reviewId: dependencyReview,
      inputDigest: INPUT_ONE,
      headSha: dependencyHead,
      cliOperations: [dependencyOperation],
    });
    await insertGeneration(dependencyFixture);
    await expect(insertOperation(dependencyFixture, dependencyOperation)).rejects.toThrow(
      "review_publication_operations_record_check",
    );

    const bytesHead = "8".repeat(40);
    const bytesReview = await createReview({ prNumber: 116, headSha: bytesHead });
    const bytesFixture = publicationFixture({
      repositoryId,
      githubRepositoryId,
      prNumber: 116,
      generation: "1",
      reviewId: bytesReview,
      inputDigest: INPUT_ONE,
      headSha: bytesHead,
      cliOperations: [makeOperation({ ordinal: 1 })],
    });
    await expect(insertGeneration({
      ...bytesFixture,
      controllerManifestMutator: (manifest) => {
        manifest.padding = "x".repeat(8 * 1024 * 1024);
      },
    })).rejects.toThrow("controller manifest does not bind");

    const boundedOperationKeys = Array.from({ length: 9 }, (_, index) =>
      `github-publication-v1:composite-review:sha256:${sha256(`canonical-${index + 1}`)}`
    );
    const boundedOperations = boundedOperationKeys.map((operationKeyValue, index) => makeOperation({
      ordinal: index + 1,
      operationKey: operationKeyValue,
    }));
    const canonicalOperations = boundedOperationKeys.map((operationKeyValue, index) => makeOperation({
      ordinal: index + 1,
      operationKey: operationKeyValue,
      body: "x".repeat(1_040_000),
    }));
    const canonicalBytes = (operations: OperationFixture[]) => Buffer.byteLength(
      `[${operations.map((operation) => operation.controllerRecordBytes.toString()).join(",")}]`,
    );
    expect(canonicalBytes(canonicalOperations.slice(0, 8))).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(canonicalBytes(canonicalOperations)).toBeGreaterThan(8 * 1024 * 1024);
    const rawReview = await createReview({ prNumber: 125, headSha: "c".repeat(40) });
    const rawFixture = publicationFixture({
      repositoryId,
      githubRepositoryId,
      prNumber: 125,
      generation: "1",
      reviewId: rawReview,
      inputDigest: INPUT_ONE,
      headSha: "c".repeat(40),
      cliOperations: boundedOperations,
    });
    await insertGeneration(rawFixture);
    for (const operation of canonicalOperations.slice(0, 8)) {
      await insertOperation(rawFixture, operation);
    }
    await expect(insertOperation(rawFixture, canonicalOperations[8]!)).rejects.toThrow(
      "publication generation exceeds the 8 MiB canonical controller-record limit",
    );

    const edgeKeys = Array.from({ length: 126 }, (_, index) =>
      `github-publication-v1:composite-review:sha256:${sha256(`edge-${index + 1}`)}`,
    );
    const edgeOperations = edgeKeys.map((key, index) => makeOperation({
      ordinal: index + 1,
      operationKey: key,
      dependencies: edgeKeys.slice(0, index),
    }));
    const edgeReview = await createReview({ prNumber: 126, headSha: "d".repeat(40) });
    const edgeFixture = publicationFixture({
      repositoryId,
      githubRepositoryId,
      prNumber: 126,
      generation: "1",
      reviewId: edgeReview,
      inputDigest: INPUT_ONE,
      headSha: "d".repeat(40),
      cliOperations: edgeOperations,
    });
    await insertGeneration(edgeFixture);
    let edgeFailure: unknown;
    for (const operation of edgeOperations) {
      await insertOperation(edgeFixture, operation);
      try {
        await insertDependencyEdges(edgeFixture, operation);
      } catch (error) {
        edgeFailure = error;
        break;
      }
    }
    expect(String(edgeFailure)).toContain("publication generation exceeds the 1024 dependency-edge limit");
  }, 30_000);

  test("serializes concurrent first-generation sealing and rejects post-seal insertion", async () => {
    const fixture = await preparePublication({ prNumber: 104, seal: false });
    const first = await pool.connect();
    const second = await pool.connect();
    try {
      const results = await Promise.allSettled([
        insertHighWater(fixture, first),
        insertHighWater(fixture, second),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      const highWater = await pool.query<{ count: string }>(
        `SELECT count(*) FROM pull_request_publication_high_waters
         WHERE repository_id = $1 AND pr_number = $2`,
        [repositoryId, fixture.prNumber],
      );
      expect(highWater.rows[0]!.count).toBe("1");
      await expect(
        insertOperation(fixture, makeOperation({ ordinal: 2 })),
      ).rejects.toThrow("sealed publication generations cannot accept operations");
    } finally {
      first.release();
      second.release();
    }
  });

  test("rejects trigger-induced sealing unless the validated high-water row exists", async () => {
    const fixture = await preparePublication({ prNumber: 127, seal: false });
    await pool.query(
      `CREATE FUNCTION postil_test_force_generation_seal()
       RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         NEW.sealed_at := clock_timestamp();
         RETURN NEW;
       END;
       $$`,
    );
    await pool.query(
      `CREATE TRIGGER postil_test_force_generation_seal
       BEFORE UPDATE OF plan_semantic_digest ON review_publication_generations
       FOR EACH ROW EXECUTE FUNCTION postil_test_force_generation_seal()`,
    );
    await expect(
      pool.query(
        `UPDATE review_publication_generations
         SET plan_semantic_digest = plan_semantic_digest
         WHERE repository_id = $1 AND pr_number = $2 AND publication_generation = $3`,
        [fixture.repositoryId, fixture.prNumber, fixture.generation],
      ),
    ).rejects.toThrow("review publication generation is immutable");
    const sealed = await pool.query<{ sealed_at: Date | null }>(
      `SELECT sealed_at FROM review_publication_generations
       WHERE repository_id = $1 AND pr_number = $2 AND publication_generation = $3`,
      [fixture.repositoryId, fixture.prNumber, fixture.generation],
    );
    expect(sealed.rows[0]!.sealed_at).toBeNull();
  });

  test("dispatches only the exact current sealed high-water generation", async () => {
    const first = await preparePublication({ prNumber: 124, generation: "1", inputDigest: INPUT_ONE });
    const second = await preparePublication({
      prNumber: 124,
      generation: "2",
      inputDigest: INPUT_TWO,
      headSha: "e".repeat(40),
      seal: false,
    });
    const advancing = await pool.connect();
    const claimant = await pool.connect();
    try {
      await advancing.query("BEGIN");
      await advancing.query(
        `UPDATE pull_request_publication_high_waters
         SET publication_generation = $3, accepted_review_id = $4,
             accepted_input_digest = $5, accepted_head_sha = $6,
             updated_at = clock_timestamp()
         WHERE repository_id = $1 AND pr_number = $2`,
        [
          repositoryId,
          first.prNumber,
          second.generation,
          second.reviewId,
          second.inputDigest,
          second.headSha,
        ],
      );
      const staleClaim = claimOperation({
        fixture: first,
        operation: first.operations[0]!,
        queryable: claimant,
      });
      await advancing.query("COMMIT");
      await expect(staleClaim).rejects.toThrow("only the current sealed publication generation can be claimed");
      const currentClaim = await claimOperation({ fixture: second, operation: second.operations[0]! });
      expect(currentClaim.attempt_count).toBe(1);
    } finally {
      await advancing.query("ROLLBACK").catch(() => undefined);
      advancing.release();
      claimant.release();
    }
  });

  test("allows one active operation and atomically rejects an independent concurrent claim", async () => {
    const first = makeOperation({ ordinal: 1 });
    const second = makeOperation({ ordinal: 2 });
    const fixture = await preparePublication({ prNumber: 105, operations: [first, second] });
    await claimOperation({ fixture, operation: first });
    await expect(claimOperation({
      fixture,
      operation: second,
      owner: "worker-two",
    })).rejects.toThrow("review_publication_operations_single_active_idx");
    const rejectedClaims = await pool.query<{ count: string }>(
      `SELECT count(*) FROM review_publication_operation_attempts
       WHERE repository_id = $1 AND pr_number = $2 AND operation_key = $3`,
      [repositoryId, fixture.prNumber, second.operationKey],
    );
    expect(rejectedClaims.rows[0]!.count).toBe("0");
    await insertAttempt({
      fixture,
      operation: first,
      phase: "not_dispatched",
      attemptNumber: 1,
      leaseGeneration: "1",
      variant: "primary",
    });
    await pool.query(
      `UPDATE review_publication_operations
       SET state = 'pending', claim_owner = NULL, lease_id = NULL,
           lease_expires_at = NULL, selected_variant = NULL
       WHERE repository_id = $1 AND pr_number = $2 AND operation_key = $3`,
      [repositoryId, fixture.prNumber, first.operationKey],
    );
    await claimOperation({ fixture, operation: second, owner: "worker-two" });
    const active = await pool.query<{ operation_key: string; state: string }>(
      `SELECT operation_key, state FROM review_publication_operations
       WHERE repository_id = $1 AND pr_number = $2 AND state IN ('applying', 'unknown')`,
      [repositoryId, fixture.prNumber],
    );
    expect(active.rows).toEqual([{ operation_key: second.operationKey, state: "applying" }]);
  });

  test("claims service gates only after their declared terminal dependencies settle", async () => {
    const fixture = await preparePublication({ prNumber: 120 });
    const cli = fixture.operations[0]!;
    const gateCreate = fixture.operations.find((operation) => operation.kind === "gateCheckCreate")!;
    const gateComplete = fixture.operations.find((operation) => operation.kind === "gateCheckComplete")!;
    await expect(claimOperation({ fixture, operation: gateComplete })).rejects.toThrow(
      "publication claim requires terminal dependencies and immutable activation evidence",
    );
    await applyOperation({ fixture, operation: cli });
    await expect(claimOperation({ fixture, operation: gateComplete })).rejects.toThrow(
      "publication claim requires terminal dependencies and immutable activation evidence",
    );
    await applyOperation({ fixture, operation: gateCreate });
    const completeClaim = await claimOperation({ fixture, operation: gateComplete });
    expect(completeClaim.attempt_count).toBe(1);
  });

  test("seals and completes gate operations when the accepted CLI plan has no operations", async () => {
    const fixture = await preparePublication({ prNumber: 129, operations: [] });
    const gateCreate = fixture.operations.find((operation) => operation.kind === "gateCheckCreate")!;
    const gateComplete = fixture.operations.find((operation) => operation.kind === "gateCheckComplete")!;
    expect(fixture.cliOperations).toEqual([]);
    expect(gateComplete.dependencies).toEqual([gateCreate.operationKey]);
    await applyOperation({ fixture, operation: gateCreate });
    const completeClaim = await claimOperation({ fixture, operation: gateComplete });
    expect(completeClaim.attempt_count).toBe(1);
  });

  test("claims fallback operations only from their immutable predecessor evidence", async () => {
    const primary = makeOperation({ ordinal: 1 });
    const fallback = makeOperation({
      ordinal: 2,
      operationKey: operationKey("file-comment-fallback", 2),
      dependencies: [primary.operationKey],
      kind: "fileCommentFallback",
      activation: {
        anyOf: [{
          condition: "semanticPlacementRejected",
          dependencyOperationKey: primary.operationKey,
          httpStatus: 422,
          classification: "invalidReviewCommentPlacement",
          markerAbsence: { markers: ["marker-2"], headSha: "7".repeat(40), required: true },
        }],
      },
    });
    const fixture = await preparePublication({ prNumber: 121, operations: [primary, fallback] });
    await expect(claimOperation({ fixture, operation: fallback })).rejects.toThrow(
      "publication claim requires terminal dependencies and immutable activation evidence",
    );
    await pool.query(
      `UPDATE review_publication_operations
       SET state = 'failed', last_error = 'inline placement rejected',
           terminal_evidence = '{"httpStatus":422,"classification":"invalidReviewCommentPlacement"}'::jsonb
       WHERE repository_id = $1 AND pr_number = $2 AND operation_key = $3`,
      [repositoryId, fixture.prNumber, primary.operationKey],
    );
    const fallbackClaim = await claimOperation({ fixture, operation: fallback, variant: "fallback" });
    expect(fallbackClaim.attempt_count).toBe(1);
  });

  test("rejects live lease theft, permits renewal, and requires expiry for reclaim", async () => {
    const fixture = await preparePublication({ prNumber: 106 });
    const operation = fixture.operations[0]!;
    const initialLease = randomUUID();
    await claimOperation({
      fixture,
      operation,
      leaseId: initialLease,
      expiresOffset: "2 seconds",
    });
    await expect(
      pool.query(
        `UPDATE review_publication_operations
         SET attempt_count = 2, lease_generation = 2, claim_owner = 'thief',
             lease_id = $4, selected_variant = 'fallback',
             lease_expires_at = clock_timestamp() + interval '10 minutes'
         WHERE repository_id = $1 AND pr_number = $2 AND operation_key = $3`,
        [repositoryId, fixture.prNumber, operation.operationKey, randomUUID()],
      ),
    ).rejects.toThrow("requires an expired undispatched attempt");
    await pool.query(
      `UPDATE review_publication_operations
       SET lease_expires_at = clock_timestamp() + interval '2 seconds'
       WHERE repository_id = $1 AND pr_number = $2 AND operation_key = $3`,
      [repositoryId, fixture.prNumber, operation.operationKey],
    );
    await Bun.sleep(2_100);
    await expect(
      pool.query(
        `UPDATE review_publication_operations
         SET lease_expires_at = clock_timestamp() + interval '10 minutes'
         WHERE repository_id = $1 AND pr_number = $2 AND operation_key = $3`,
        [repositoryId, fixture.prNumber, operation.operationKey],
      ),
    ).rejects.toThrow("publication lease renewal may only extend the current lease");
    await expect(
      pool.query(
        `UPDATE review_publication_operations
         SET updated_at = clock_timestamp() + interval '2 seconds'
         WHERE repository_id = $1 AND pr_number = $2 AND operation_key = $3`,
        [repositoryId, fixture.prNumber, operation.operationKey],
      ),
    ).rejects.toThrow("timestamps must not be backdated or future-dated");
    await expect(
      pool.query(
        `UPDATE review_publication_operations
         SET updated_at = created_at - interval '1 second'
         WHERE repository_id = $1 AND pr_number = $2 AND operation_key = $3`,
        [repositoryId, fixture.prNumber, operation.operationKey],
      ),
    ).rejects.toThrow("timestamps must not be backdated or future-dated");
    await pool.query(
      `UPDATE review_publication_operations
       SET attempt_count = 2, lease_generation = 2, claim_owner = 'worker-two',
             lease_id = $4, selected_variant = 'fallback',
             lease_expires_at = clock_timestamp() + interval '10 minutes'
       WHERE repository_id = $1 AND pr_number = $2 AND operation_key = $3`,
      [repositoryId, fixture.prNumber, operation.operationKey, randomUUID()],
    );
    const attempts = await pool.query<{
      attempt_number: number;
      lease_generation: string;
      selected_variant: string;
    }>(
      `SELECT attempt_number, lease_generation, selected_variant
       FROM review_publication_operation_attempts
       WHERE repository_id = $1 AND pr_number = $2 AND operation_key = $3
       ORDER BY attempt_number`,
      [repositoryId, fixture.prNumber, operation.operationKey],
    );
    expect(attempts.rows).toEqual([
      { attempt_number: 1, lease_generation: "1", selected_variant: "primary" },
      { attempt_number: 2, lease_generation: "2", selected_variant: "fallback" },
    ]);
  });

  test("requires attempt-bound ambiguity and fresh exact-absence reconciliation for each retry", async () => {
    const fixture = await preparePublication({ prNumber: 107 });
    const operation = fixture.operations[0]!;
    const firstClaim = await claimOperation({ fixture, operation, variant: "primary" });
    await insertAttempt({
      fixture,
      operation,
      phase: "dispatched",
      attemptNumber: firstClaim.attempt_count,
      leaseGeneration: firstClaim.lease_generation,
      variant: "primary",
    });
    await expect(insertAttempt({
      fixture,
      operation,
      phase: "not_dispatched",
      attemptNumber: 1,
      leaseGeneration: "1",
      variant: "primary",
    })).rejects.toThrow("dispatched attempts require remote outcome evidence");
    await insertAttempt({
      fixture,
      operation,
      phase: "ambiguous",
      attemptNumber: 1,
      leaseGeneration: "1",
      variant: "primary",
      error: "response lost after dispatch",
    });
    await moveToUnknown({
      fixture,
      operation,
      error: "response lost after dispatch",
    });
    await expect(claimOperation({ fixture, operation, variant: "fallback" })).rejects.toThrow(
      "invalid publication operation state transition",
    );
    await expect(
      pool.query(
        `UPDATE review_publication_operations
         SET state = 'pending', selected_variant = NULL
         WHERE repository_id = $1 AND pr_number = $2 AND operation_key = $3`,
        [repositoryId, fixture.prNumber, operation.operationKey],
      ),
    ).rejects.toThrow("requires fresh exact-absence reconciliation");
    await expect(insertReconciliation({
      fixture,
      operation,
      attemptNumber: 1,
      leaseGeneration: "1",
      variant: "primary",
      phase: "retry",
      outcome: "exact_absence",
      observedAt: new Date(Date.now() - 6 * 60 * 1000),
    })).rejects.toThrow("reconciliation evidence timestamps must be fresh database-time observations");
    await insertReconciliation({
      fixture,
      operation,
      attemptNumber: 1,
      leaseGeneration: "1",
      variant: "primary",
      phase: "retry",
      outcome: "exact_absence",
    });
    await pool.query(
      `UPDATE review_publication_operations
       SET state = 'pending', selected_variant = NULL
       WHERE repository_id = $1 AND pr_number = $2 AND operation_key = $3`,
      [repositoryId, fixture.prNumber, operation.operationKey],
    );

    const secondClaim = await claimOperation({ fixture, operation, variant: "fallback" });
    await insertAttempt({
      fixture,
      operation,
      phase: "dispatched",
      attemptNumber: secondClaim.attempt_count,
      leaseGeneration: secondClaim.lease_generation,
      variant: "fallback",
    });
    await insertAttempt({
      fixture,
      operation,
      phase: "ambiguous",
      attemptNumber: 2,
      leaseGeneration: "2",
      variant: "fallback",
      error: "timeout after fallback dispatch",
    });
    await moveToUnknown({
      fixture,
      operation,
      error: "timeout after fallback dispatch",
    });
    await expect(
      pool.query(
        `UPDATE review_publication_operations
         SET state = 'pending', selected_variant = NULL
         WHERE repository_id = $1 AND pr_number = $2 AND operation_key = $3`,
        [repositoryId, fixture.prNumber, operation.operationKey],
      ),
    ).rejects.toThrow("requires fresh exact-absence reconciliation");
    await insertReconciliation({
      fixture,
      operation,
      attemptNumber: 2,
      leaseGeneration: "2",
      variant: "fallback",
      phase: "terminal",
      outcome: "applied",
    });
    await pool.query(
      `UPDATE review_publication_operations
       SET state = 'applied', last_error = NULL
       WHERE repository_id = $1 AND pr_number = $2 AND operation_key = $3`,
      [repositoryId, fixture.prNumber, operation.operationKey],
    );
    const evidence = await pool.query<{ attempts: string; reconciliations: string }>(
      `SELECT
         (SELECT count(*) FROM review_publication_operation_attempts
          WHERE repository_id = $1 AND pr_number = $2)::text AS attempts,
         (SELECT count(*) FROM review_publication_operation_reconciliations
          WHERE repository_id = $1 AND pr_number = $2)::text AS reconciliations`,
      [repositoryId, fixture.prNumber],
    );
    expect(evidence.rows[0]).toEqual({ attempts: "6", reconciliations: "2" });
    await expect(
      pool.query(
        `UPDATE review_publication_operation_reconciliations
         SET evidence_payload = '{"rewritten":true}'::jsonb
         WHERE repository_id = $1 AND pr_number = $2`,
        [repositoryId, fixture.prNumber],
      ),
    ).rejects.toThrow("append-only");
    await expect(
      pool.query(
        `UPDATE review_publication_operation_attempts
         SET evidence_payload = '{"rewritten":true}'::jsonb
         WHERE repository_id = $1 AND pr_number = $2 AND phase = 'ambiguous'`,
        [repositoryId, fixture.prNumber],
      ),
    ).rejects.toThrow("append-only");
    await expect(
      pool.query(
        `DELETE FROM review_publication_operation_attempts
         WHERE repository_id = $1 AND pr_number = $2`,
        [repositoryId, fixture.prNumber],
      ),
    ).rejects.toThrow("append-only");
  });

  test("serializes conflicting reconciliation outcomes under repeatable-read snapshots", async () => {
    const fixture = await preparePublication({ prNumber: 122 });
    const operation = fixture.operations[0]!;
    const claim = await claimOperation({ fixture, operation });
    await insertAttempt({
      fixture,
      operation,
      phase: "dispatched",
      attemptNumber: claim.attempt_count,
      leaseGeneration: claim.lease_generation,
      variant: "primary",
    });
    await insertAttempt({
      fixture,
      operation,
      phase: "ambiguous",
      attemptNumber: claim.attempt_count,
      leaseGeneration: claim.lease_generation,
      variant: "primary",
      error: "remote response was lost",
    });
    await moveToUnknown({ fixture, operation, error: "remote response was lost" });
    const first = await pool.connect();
    const second = await pool.connect();
    try {
      await first.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      await second.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      await first.query("SELECT 1");
      await second.query("SELECT 1");
      await insertReconciliation({
        fixture,
        operation,
        attemptNumber: claim.attempt_count,
        leaseGeneration: claim.lease_generation,
        variant: "primary",
        phase: "terminal",
        outcome: "exact_absence",
        queryable: first,
      });
      const retry = insertReconciliation({
        fixture,
        operation,
        attemptNumber: claim.attempt_count,
        leaseGeneration: claim.lease_generation,
        variant: "primary",
        phase: "retry",
        outcome: "exact_absence",
        queryable: second,
      });
      await first.query("COMMIT");
      await expect(retry).rejects.toThrow(/could not serialize|only one reconciliation/i);
      await second.query("ROLLBACK");
      const reconciliations = await pool.query<{ count: string }>(
        `SELECT count(*) FROM review_publication_operation_reconciliations
         WHERE repository_id = $1 AND pr_number = $2 AND operation_key = $3`,
        [repositoryId, fixture.prNumber, operation.operationKey],
      );
      expect(reconciliations.rows[0]!.count).toBe("1");
    } finally {
      await first.query("ROLLBACK").catch(() => undefined);
      await second.query("ROLLBACK").catch(() => undefined);
      first.release();
      second.release();
    }
  });

  test("serializes dispatched and not-dispatched evidence under repeatable-read snapshots", async () => {
    const fixture = await preparePublication({ prNumber: 123 });
    const operation = fixture.operations[0]!;
    const claim = await claimOperation({ fixture, operation });
    const first = await pool.connect();
    const second = await pool.connect();
    try {
      await first.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      await second.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      await first.query("SELECT 1");
      await second.query("SELECT 1");
      await insertAttempt({
        fixture,
        operation,
        phase: "dispatched",
        attemptNumber: claim.attempt_count,
        leaseGeneration: claim.lease_generation,
        variant: "primary",
        queryable: first,
      });
      const notDispatched = insertAttempt({
        fixture,
        operation,
        phase: "not_dispatched",
        attemptNumber: claim.attempt_count,
        leaseGeneration: claim.lease_generation,
        variant: "primary",
        queryable: second,
      });
      await first.query("COMMIT");
      await expect(notDispatched).rejects.toThrow(/could not serialize|cannot later be dispatched/i);
      await second.query("ROLLBACK");
      const phases = await pool.query<{ phase: string }>(
        `SELECT phase FROM review_publication_operation_attempts
         WHERE repository_id = $1 AND pr_number = $2 AND operation_key = $3
         ORDER BY phase`,
        [repositoryId, fixture.prNumber, operation.operationKey],
      );
      expect(phases.rows).toEqual([{ phase: "claimed" }, { phase: "dispatched" }]);
    } finally {
      await first.query("ROLLBACK").catch(() => undefined);
      await second.query("ROLLBACK").catch(() => undefined);
      first.release();
      second.release();
    }
  });

  test("rejects empty evidence and escaped-mutation terminal claims", async () => {
    const fixture = await preparePublication({ prNumber: 108 });
    const operation = fixture.operations[0]!;
    await claimOperation({ fixture, operation });
    await expect(insertAttempt({
      fixture,
      operation,
      phase: "dispatched",
      attemptNumber: 1,
      leaseGeneration: "1",
      variant: "primary",
      evidence: {},
    })).rejects.toThrow("review_publication_operation_attempts_payload_check");
    await insertAttempt({
      fixture,
      operation,
      phase: "dispatched",
      attemptNumber: 1,
      leaseGeneration: "1",
      variant: "primary",
    });
    await expect(
      pool.query(
        `UPDATE review_publication_operations
         SET state = 'failed', claim_owner = NULL, lease_id = NULL,
             lease_expires_at = NULL, last_error = 'failed after dispatch',
             terminal_evidence = '{"reason":"failed"}'::jsonb
         WHERE repository_id = $1 AND pr_number = $2 AND operation_key = $3`,
        [repositoryId, fixture.prNumber, operation.operationKey],
      ),
    ).rejects.toThrow("requires proof no mutation was dispatched");
    await insertAttempt({
      fixture,
      operation,
      phase: "ambiguous",
      attemptNumber: 1,
      leaseGeneration: "1",
      variant: "primary",
      error: "unknown remote result",
    });
    await moveToUnknown({ fixture, operation, error: "unknown remote result" });
    await expect(insertReconciliation({
      fixture,
      operation,
      attemptNumber: 1,
      leaseGeneration: "1",
      variant: "primary",
      phase: "retry",
      outcome: "exact_absence",
      evidence: {},
    })).rejects.toThrow("review_publication_operation_reconciliations_payload_check");
    const pendingFixture = await preparePublication({ prNumber: 208 });
    await expect(
      pool.query(
        `UPDATE review_publication_operations
         SET state = 'skipped', terminal_evidence = '{}'::jsonb
         WHERE repository_id = $1 AND pr_number = $2 AND operation_key = $3`,
        [repositoryId, pendingFixture.prNumber, pendingFixture.operations[0]!.operationKey],
      ),
    ).rejects.toThrow("review_publication_operations_terminal_evidence_check");
  });

  test("models compensation as a separate immutable dependent operation", async () => {
    const primary = makeOperation({ ordinal: 1 });
    const compensation = makeOperation({
      ordinal: 2,
      operationKey: operationKey("file-comment-fallback", 4),
      dependencies: [primary.operationKey],
      activation: {
        anyOf: [{
          condition: "reviewSelectionTerminal",
          selectedReviewOperationKeys: [primary.operationKey],
        }],
      },
      kind: "fileCommentFallback",
      body: "compensating publication intent",
    });
    const fixture = await preparePublication({
      prNumber: 109,
      operations: [primary, compensation],
    });
    const stored = await pool.query<{
      operation_key: string;
      dependencies: unknown;
      state: string;
    }>(
      `SELECT operation_key, operation_record->'dependencies' AS dependencies, state
       FROM review_publication_operations
       WHERE repository_id = $1 AND pr_number = $2 AND operation_source = 'cli'
       ORDER BY operation_ordinal`,
      [repositoryId, fixture.prNumber],
    );
    expect(stored.rows).toEqual([
      { operation_key: primary.operationKey, dependencies: [], state: "pending" },
      {
        operation_key: compensation.operationKey,
        dependencies: [primary.operationKey],
        state: "pending",
      },
    ]);
    await expect(
      pool.query(
        `UPDATE review_publication_operations
         SET state = 'compensating'
         WHERE repository_id = $1 AND pr_number = $2 AND operation_key = $3`,
        [repositoryId, fixture.prNumber, primary.operationKey],
      ),
    ).rejects.toThrow("invalid publication operation state transition");
    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'review_publication_operations'
         AND column_name LIKE 'compensation%'`,
    );
    expect(columns.rows).toEqual([]);
  });

  test("retains two generations across review deletion and rejects rollback or direct child deletion", async () => {
    const hierarchy = await createHierarchy(20);
    const first = await preparePublication({
      repositoryId: hierarchy.repositoryId,
      githubRepositoryId: hierarchy.githubRepositoryId,
      repositoryFullName: hierarchy.repositoryFullName,
      prNumber: 201,
      generation: "1",
    });
    const secondHead = "d".repeat(40);
    const secondOperation = makeOperation({ ordinal: 1, body: "generation two" });
    const secondReviewId = await createReview({
      repositoryId: hierarchy.repositoryId,
      prNumber: 201,
      headSha: secondHead,
    });
    const second = publicationFixture({
      repositoryId: hierarchy.repositoryId,
      githubRepositoryId: hierarchy.githubRepositoryId,
      repositoryFullName: hierarchy.repositoryFullName,
      prNumber: 201,
      generation: "2",
      reviewId: secondReviewId,
      inputDigest: INPUT_TWO,
      headSha: secondHead,
      cliOperations: [secondOperation],
    });
    await insertGeneration({ ...second, repositoryFullName: hierarchy.repositoryFullName });
    for (const publicationOperation of second.operations) {
      await insertOperation(second, publicationOperation);
      await insertDependencyEdges(second, publicationOperation);
    }
    await pool.query(
      `UPDATE pull_request_publication_high_waters
       SET publication_generation = 2, accepted_review_id = $3,
           accepted_input_digest = $4, accepted_head_sha = $5,
           updated_at = clock_timestamp()
       WHERE repository_id = $1 AND pr_number = $2`,
      [hierarchy.repositoryId, second.prNumber, second.reviewId, second.inputDigest, secondHead],
    );
    await pool.query(`DELETE FROM public.reviews WHERE id = ANY($1::bigint[])`, [
      [first.reviewId, second.reviewId],
    ]);
    const retained = await pool.query<{ generations: string; operations: string; high_waters: string }>(
      `SELECT
         (SELECT count(*) FROM review_publication_generations WHERE repository_id = $1)::text AS generations,
         (SELECT count(*) FROM review_publication_operations WHERE repository_id = $1)::text AS operations,
         (SELECT count(*) FROM pull_request_publication_high_waters WHERE repository_id = $1)::text AS high_waters`,
      [hierarchy.repositoryId],
    );
    expect(retained.rows[0]).toEqual({ generations: "2", operations: "6", high_waters: "1" });
    await expect(
      pool.query(
        `UPDATE pull_request_publication_high_waters
         SET publication_generation = 1, accepted_review_id = $3,
             accepted_input_digest = $4, accepted_head_sha = $5,
             updated_at = clock_timestamp()
         WHERE repository_id = $1 AND pr_number = $2`,
        [hierarchy.repositoryId, first.prNumber, first.reviewId, first.inputDigest, first.headSha],
      ),
    ).rejects.toThrow("generation cannot decrease");
    await expect(
      pool.query(
        `DELETE FROM review_publication_generations
         WHERE repository_id = $1 AND pr_number = $2`,
        [hierarchy.repositoryId, first.prNumber],
      ),
    ).rejects.toThrow("only be deleted by repository teardown");
    await expect(
      pool.query(
        `DELETE FROM review_publication_operations
         WHERE repository_id = $1 AND pr_number = $2`,
        [hierarchy.repositoryId, first.prNumber],
      ),
    ).rejects.toThrow("only be deleted by repository teardown");
    await pool.query(`DELETE FROM repositories WHERE id = $1`, [hierarchy.repositoryId]);
    const removed = await pool.query<{ generations: string; operations: string; high_waters: string }>(
      `SELECT
         (SELECT count(*) FROM review_publication_generations WHERE repository_id = $1)::text AS generations,
         (SELECT count(*) FROM review_publication_operations WHERE repository_id = $1)::text AS operations,
         (SELECT count(*) FROM pull_request_publication_high_waters WHERE repository_id = $1)::text AS high_waters`,
      [hierarchy.repositoryId],
    );
    expect(removed.rows[0]).toEqual({ generations: "0", operations: "0", high_waters: "0" });
  });

  test("cascades the complete publication audit only from installation teardown", async () => {
    const hierarchy = await createHierarchy(21);
    const fixture = await preparePublication({
      repositoryId: hierarchy.repositoryId,
      githubRepositoryId: hierarchy.githubRepositoryId,
      repositoryFullName: hierarchy.repositoryFullName,
      prNumber: 202,
    });
    await claimOperation({ fixture, operation: fixture.operations[0]! });
    await insertAttempt({
      fixture,
      operation: fixture.operations[0]!,
      phase: "dispatched",
      attemptNumber: 1,
      leaseGeneration: "1",
      variant: "primary",
    });
    await insertAttempt({
      fixture,
      operation: fixture.operations[0]!,
      phase: "ambiguous",
      attemptNumber: 1,
      leaseGeneration: "1",
      variant: "primary",
      error: "ambiguous installation teardown fixture",
    });
    await moveToUnknown({
      fixture,
      operation: fixture.operations[0]!,
      error: "ambiguous installation teardown fixture",
    });
    await insertReconciliation({
      fixture,
      operation: fixture.operations[0]!,
      attemptNumber: 1,
      leaseGeneration: "1",
      variant: "primary",
      phase: "terminal",
      outcome: "applied",
    });
    await pool.query(`DELETE FROM installations WHERE id = $1`, [hierarchy.installationId]);
    for (const table of [
      "pull_request_publication_high_waters",
      "review_publication_generations",
      "review_publication_operations",
      "review_publication_operation_attempts",
      "review_publication_operation_reconciliations",
    ]) {
      const count = await pool.query<{ count: string }>(
        `SELECT count(*) FROM ${table} WHERE repository_id = $1`,
        [hierarchy.repositoryId],
      );
      expect(count.rows[0]!.count).toBe("0");
    }
  });

  test("rejects direct and unrelated trigger-induced child deletion while allowing repository teardown", async () => {
    const hierarchy = await createHierarchy(22);
    const primary = makeOperation({ ordinal: 1 });
    const dependent = makeOperation({
      ordinal: 2,
      operationKey: operationKey("file-comment-fallback", 5),
      dependencies: [primary.operationKey],
      kind: "fileCommentFallback",
    });
    const fixture = await preparePublication({
      repositoryId: hierarchy.repositoryId,
      githubRepositoryId: hierarchy.githubRepositoryId,
      repositoryFullName: hierarchy.repositoryFullName,
      prNumber: 206,
      operations: [primary, dependent],
    });
    await claimOperation({ fixture, operation: primary });
    await insertAttempt({
      fixture,
      operation: primary,
      phase: "dispatched",
      attemptNumber: 1,
      leaseGeneration: "1",
      variant: "primary",
    });
    await insertAttempt({
      fixture,
      operation: primary,
      phase: "ambiguous",
      attemptNumber: 1,
      leaseGeneration: "1",
      variant: "primary",
      error: "delete-guard ambiguity fixture",
    });
    await moveToUnknown({ fixture, operation: primary, error: "delete-guard ambiguity fixture" });
    await insertReconciliation({
      fixture,
      operation: primary,
      attemptNumber: 1,
      leaseGeneration: "1",
      variant: "primary",
      phase: "terminal",
      outcome: "applied",
    });

    const protectedTables = [
      "pull_request_publication_high_waters",
      "review_publication_generations",
      "review_publication_operations",
      "review_publication_operation_dependencies",
      "review_publication_operation_attempts",
      "review_publication_operation_reconciliations",
    ] as const;
    for (const table of protectedTables) {
      await expect(
        pool.query(
          `DELETE FROM ${table} WHERE repository_id = $1 AND pr_number = $2`,
          [hierarchy.repositoryId, fixture.prNumber],
        ),
      ).rejects.toThrow();
    }

    const client = await pool.connect();
    try {
      await client.query(
        `CREATE TEMP TABLE publication_delete_probe
           (target_table text NOT NULL, repository_id bigint NOT NULL, pr_number integer NOT NULL)`,
      );
      await client.query(
        `CREATE FUNCTION pg_temp.delete_publication_child_from_unrelated_trigger()
         RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
         BEGIN
           EXECUTE format(
             'DELETE FROM public.%I WHERE repository_id = $1 AND pr_number = $2',
             NEW.target_table
           ) USING NEW.repository_id, NEW.pr_number;
           RETURN NEW;
         END;
         $$`,
      );
      await client.query(
        `CREATE TRIGGER publication_delete_probe_trigger
         BEFORE INSERT ON publication_delete_probe
         FOR EACH ROW EXECUTE FUNCTION pg_temp.delete_publication_child_from_unrelated_trigger()`,
      );
      for (const table of protectedTables) {
        await expect(
          client.query(
            `INSERT INTO publication_delete_probe VALUES ($1, $2, $3)`,
            [table, hierarchy.repositoryId, fixture.prNumber],
          ),
        ).rejects.toThrow();
      }
      await client.query(
        `CREATE FUNCTION pg_temp.delete_publication_from_review_trigger()
         RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
         BEGIN
           DELETE FROM public.review_publication_generations
           WHERE repository_id = OLD.repository_id AND pr_number = OLD.pr_number;
           RETURN OLD;
         END;
         $$`,
      );
      await client.query(
        `CREATE TRIGGER publication_review_delete_probe
         AFTER DELETE ON public.reviews
         FOR EACH ROW EXECUTE FUNCTION pg_temp.delete_publication_from_review_trigger()`,
      );
      await expect(
        client.query(`DELETE FROM public.reviews WHERE id = $1`, [fixture.reviewId]),
      ).rejects.toThrow("only be deleted by repository teardown");
      await client.query(`DROP TRIGGER publication_review_delete_probe ON public.reviews`);
    } finally {
      client.release();
    }

    await pool.query(`DELETE FROM repositories WHERE id = $1`, [hierarchy.repositoryId]);
    for (const table of protectedTables) {
      const count = await pool.query<{ count: string }>(
        `SELECT count(*) FROM ${table} WHERE repository_id = $1`,
        [hierarchy.repositoryId],
      );
      expect(count.rows[0]!.count).toBe("0");
    }
  });

  test("schema-qualifies review identity validation against a pg_temp shadow", async () => {
    const client = await pool.connect();
    try {
      await client.query(
        `CREATE TEMP TABLE reviews
           (id bigint, repository_id bigint, pr_number integer, head_sha text, base_sha text)`,
      );
      const fakeReviewId = 9223372036854775000n;
      const headSha = "e".repeat(40);
      await client.query(
        `INSERT INTO pg_temp.reviews VALUES ($1, $2, 203, $3, $4)`,
        [fakeReviewId.toString(), repositoryId, headSha, BASE_SHA],
      );
      const fixture = publicationFixture({
        repositoryId,
        githubRepositoryId,
        prNumber: 203,
        generation: "1",
        reviewId: Number(fakeReviewId),
        inputDigest: INPUT_ONE,
        headSha,
        cliOperations: [makeOperation({ ordinal: 1 })],
      });
      await expect(insertGeneration({ ...fixture, queryable: client })).rejects.toThrow(
        "does not match its review identity",
      );
      const validReviewId = await createReview({
        prNumber: 203,
        headSha,
        queryable: client,
      });
      await insertGeneration({
        ...fixture,
        reviewId: validReviewId,
        acceptedInput: undefined,
        queryable: client,
      });
      const stored = await client.query<{ review_id: string }>(
        `SELECT review_id FROM review_publication_generations
         WHERE repository_id = $1 AND pr_number = 203`,
        [repositoryId],
      );
      expect(stored.rows[0]!.review_id).toBe(String(validReviewId));
    } finally {
      client.release();
    }
  });

  test("rejects malformed payloads, deadlines, recovery bounds, and composite identities", async () => {
    const prNumber = 207;
    const headSha = "1".repeat(40);
    const reviewId = await createReview({ prNumber, headSha });
    const operation = makeOperation({ ordinal: 1 });
    const fixture = publicationFixture({
      repositoryId,
      githubRepositoryId,
      prNumber,
      generation: "1",
      reviewId,
      inputDigest: INPUT_ONE,
      headSha,
      cliOperations: [operation],
    });
    await insertGeneration(fixture);
    await expect(
      insertOperation(fixture, operation, pool, { reviewId: reviewId + 1 }),
    ).rejects.toThrow("review_publication_operations_generation_fk");
    const arrayBytes = Buffer.from("[]");
    await expect(
      insertOperation(fixture, operation, pool, {
        desiredPayload: [],
        desiredPayloadBytes: arrayBytes,
        desiredPayloadDigest: `sha256:${sha256(arrayBytes)}`,
      }),
    ).rejects.toThrow();
    await expect(
      insertOperation(fixture, operation, pool, {
        deadlineAt: "2020-01-01T00:00:00Z",
      }),
    ).rejects.toThrow("review_publication_operations_deadline_check");
    for (const publicationOperation of fixture.operations) {
      await insertOperation(fixture, publicationOperation);
      await insertDependencyEdges(fixture, publicationOperation);
    }
    await expect(
      pool.query(
        `INSERT INTO review_publication_operation_dependencies
           (repository_id, pr_number, publication_generation, operation_key,
            dependency_position, dependency_operation_key)
         VALUES ($1, $2, 1, $3, 0, $4)`,
        [repositoryId, prNumber, operation.operationKey, operationKey("missing", 4)],
      ),
    ).rejects.toThrow("review_publication_operation_dependencies_dependency_fk");
    await insertHighWater(fixture);
    await expect(
      pool.query(
        `UPDATE review_publication_operations
         SET last_error = $4
         WHERE repository_id = $1 AND pr_number = $2 AND operation_key = $3`,
        [repositoryId, prNumber, operation.operationKey, "x".repeat(4001)],
      ),
    ).rejects.toThrow("review_publication_operations_error_check");
    await claimOperation({ fixture, operation });
    await insertAttempt({
      fixture,
      operation,
      phase: "dispatched",
      attemptNumber: 1,
      leaseGeneration: "1",
      variant: "primary",
    });
    await expect(insertAttempt({
      fixture,
      operation,
      phase: "ambiguous",
      attemptNumber: 1,
      leaseGeneration: "1",
      variant: "primary",
      error: "x".repeat(4001),
    })).rejects.toThrow("review_publication_operation_attempts_error_check");
    await expect(insertAttempt({
      fixture,
      operation,
      phase: "applied",
      attemptNumber: 1,
      leaseGeneration: "1",
      variant: "primary",
      remoteIdentity: "x".repeat(501),
      remoteOperationId: "123",
    })).rejects.toThrow("review_publication_operation_attempts_remote_identity_check");
    await expect(
      pool.query(
        `INSERT INTO review_publication_operation_attempts
           (repository_id, pr_number, publication_generation, operation_key,
            attempt_number, lease_generation, phase, selected_variant,
            evidence_payload, observed_at)
         VALUES ($1, $2, 1, $3, 1, 1, 'dispatched', 'primary',
                 '{"dispatch":true}'::jsonb, clock_timestamp())`,
        [repositoryId, prNumber, operationKey("missing", 5)],
      ),
    ).rejects.toThrow("review_publication_operation_attempts_operation_fk");
    await expect(
      pool.query(
        `UPDATE pull_request_publication_high_waters
         SET accepted_head_sha = $3, updated_at = clock_timestamp()
         WHERE repository_id = $1 AND pr_number = $2`,
        [repositoryId, prNumber, "2".repeat(40)],
      ),
    ).rejects.toThrow("pull_request_publication_high_waters_generation_fk");
  });

  test("enforces signed-bigint generations and immutable bounded operation intent", async () => {
    const maximumGeneration = "9223372036854775807";
    const fixture = await preparePublication({
      prNumber: 204,
      generation: maximumGeneration,
      seal: false,
    });
    const stored = await pool.query<{ publication_generation: string }>(
      `SELECT publication_generation FROM review_publication_generations
       WHERE repository_id = $1 AND pr_number = $2`,
      [repositoryId, fixture.prNumber],
    );
    expect(stored.rows[0]!.publication_generation).toBe(maximumGeneration);
    const invalidReview = await createReview({ prNumber: 205, headSha: "f".repeat(40) });
    await expect(insertGeneration({
      repositoryId,
      githubRepositoryId,
      prNumber: 205,
      generation: "0",
      reviewId: invalidReview,
      inputDigest: INPUT_ONE,
      headSha: "f".repeat(40),
      operations: [makeOperation({ ordinal: 1 })],
    })).rejects.toThrow();
    await insertHighWater(fixture);
    const operation = fixture.operations[0]!;
    for (const [column, value] of [
      ["operation_key", "0".repeat(64)],
      ["kind", "changedKind"],
      ["desired_payload", `'${JSON.stringify({ kind: "changed" })}'::jsonb`],
      ["desired_payload_digest", `'sha256:${"0".repeat(64)}'`],
      ["operation_record", `'${JSON.stringify({ changed: true })}'::jsonb`],
      ["activation", `'{"anyOf":[{"condition":"changed"}]}'::jsonb`],
    ] as const) {
      const expression = column === "operation_key" || column === "kind"
        ? `$4`
        : value;
      const values = column === "operation_key" || column === "kind"
        ? [repositoryId, fixture.prNumber, operation.operationKey, value]
        : [repositoryId, fixture.prNumber, operation.operationKey];
      await expect(
        pool.query(
          `UPDATE review_publication_operations SET ${column} = ${expression}
           WHERE repository_id = $1 AND pr_number = $2 AND operation_key = $3`,
          values,
        ),
      ).rejects.toThrow();
    }
    await expect(
      pool.query(
        `UPDATE review_publication_operations
         SET deadline_at = created_at - interval '1 second'
         WHERE repository_id = $1 AND pr_number = $2 AND operation_key = $3`,
        [repositoryId, fixture.prNumber, operation.operationKey],
      ),
    ).rejects.toThrow();
    await expect(
      pool.query(
        `UPDATE review_publication_operations
         SET retry_after = 'infinity'::timestamptz
         WHERE repository_id = $1 AND pr_number = $2 AND operation_key = $3`,
        [repositoryId, fixture.prNumber, operation.operationKey],
      ),
    ).rejects.toThrow("review_publication_operations_timestamps_check");
  });
});
