import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import type { Envelope } from "@/lib/envelope";
import type { ReviewConfigProvenance } from "@/lib/github/contents";
import type { ReviewTriggerContext } from "@/lib/review-trigger";

/** Raw bytes column for AES-256-GCM sealed secrets. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const reviewStatus = pgEnum("review_status", [
  "queued",
  "running",
  "completed",
  "failed",
  "stale",
]);

export const jobStatus = pgEnum("job_status", [
  "queued",
  "running",
  "done",
  "failed",
]);

export const findingApprovalRole = pgEnum("finding_approval_role", [
  "member",
  "admin",
]);
export const findingApprovalSource = pgEnum("finding_approval_source", [
  "github",
  "dashboard",
]);
export const findingApprovalVerb = pgEnum("finding_approval_verb", [
  "approve",
  "dismiss",
]);

export const users = pgTable("users", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  githubId: bigint("github_id", { mode: "number" }).notNull().unique(),
  login: text("login").notNull(),
  name: text("name"),
  email: text("email"),
  avatarUrl: text("avatar_url"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const organizations = pgTable(
  "organizations",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    githubOrgId: bigint("github_org_id", { mode: "number" }),
    plan: text("plan").notNull().default("beta"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  // Nullable column, plain unique index: Postgres treats each NULL as
  // distinct, so orgs with no linked GitHub org (githubOrgId is null) never
  // collide. Without this, concurrent `installation` webhooks for the same
  // GitHub org can both pass findOrCreateOrg's check before either insert
  // lands, creating duplicate organization rows for one GitHub org.
  (t) => [uniqueIndex("organizations_github_org_id_idx").on(t.githubOrgId)],
);

export const orgMembers = pgTable(
  "org_members",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    orgId: bigint("org_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
  },
  (t) => [
    uniqueIndex("org_members_org_user_idx").on(t.orgId, t.userId),
    // The unique index above is orgId-leading and doesn't serve a lookup by
    // userId alone, which is exactly what login-time membership reconciliation
    // does for every user on every login.
    index("org_members_user_idx").on(t.userId),
  ],
);

export const installations = pgTable(
  "installations",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    githubInstallationId: bigint("github_installation_id", { mode: "number" })
      .notNull()
      .unique(),
    orgId: bigint("org_id", { mode: "number" }).references(
      () => organizations.id,
      {
        onDelete: "set null",
      },
    ),
    accountLogin: text("account_login").notNull(),
    accountType: text("account_type").notNull(),
    suspended: boolean("suspended").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("installations_org_idx").on(t.orgId)],
);

export const repositories = pgTable("repositories", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  installationId: bigint("installation_id", { mode: "number" })
    .notNull()
    .references(() => installations.id, { onDelete: "cascade" }),
  githubRepoId: bigint("github_repo_id", { mode: "number" }).notNull().unique(),
  fullName: text("full_name").notNull(),
  private: boolean("private").notNull().default(false),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type GateEnforcementEvidence = {
  expectedContext: "postil/gate";
  expectedAppId: number;
  branchProtection: {
    available: boolean;
    requiredStatusChecksPresent: boolean;
    exactMatch: boolean;
    match?:
      "exact_app" | "any_source" | "foreign_app" | "unknown_identity" | "none";
  };
  activeRules: {
    available: boolean;
    pagesRead: number;
    exactMatch: boolean;
    match?:
      "exact_app" | "any_source" | "foreign_app" | "unknown_identity" | "none";
  };
};

/** Last observed GitHub enforcement state for one repository's default branch. */
export const repositoryGateEnforcement = pgTable(
  "repository_gate_enforcement",
  {
    repositoryId: bigint("repository_id", { mode: "number" })
      .primaryKey()
      .references(() => repositories.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    defaultBranch: text("default_branch"),
    branchProtection: text("branch_protection").notNull().default("unknown"),
    evidence: jsonb("evidence").$type<GateEnforcementEvidence>(),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull(),
    lastSuccessfulAt: timestamp("last_successful_at", { withTimezone: true }),
    lastError: text("last_error"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("repository_gate_enforcement_status_checked_idx").on(
      t.status,
      t.checkedAt,
    ),
    check(
      "repository_gate_enforcement_status_check",
      sql`${t.status} IN ('required', 'not_required', 'unknown')`,
    ),
    check(
      "repository_gate_enforcement_branch_protection_check",
      sql`${t.branchProtection} IN ('protected', 'unprotected', 'unknown')`,
    ),
  ],
);

export const repoConfigProbes = pgTable("repo_config_probes", {
  repositoryId: bigint("repository_id", { mode: "number" })
    .primaryKey()
    .references(() => repositories.id, { onDelete: "cascade" }),
  probedAt: timestamp("probed_at", { withTimezone: true }).notNull(),
  ok: boolean("ok").notNull(),
  files: text("files").array().notNull(),
});

export const orgConfigProbeRefreshes = pgTable("org_config_probe_refreshes", {
  orgId: bigint("org_id", { mode: "number" })
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  refreshedAt: timestamp("refreshed_at", { withTimezone: true }).notNull(),
});

export const repositoryEnablementEvents = pgTable(
  "repository_enablement_events",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    orgId: bigint("org_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    repositoryId: bigint("repository_id", { mode: "number" }).references(
      () => repositories.id,
      { onDelete: "set null" },
    ),
    githubRepoId: bigint("github_repo_id", { mode: "number" }).notNull(),
    repositoryFullName: text("repository_full_name").notNull(),
    repositoryPrivate: boolean("repository_private").notNull(),
    action: text("action").notNull(),
    actorUserId: bigint("actor_user_id", { mode: "number" }).references(
      () => users.id,
      {
        onDelete: "set null",
      },
    ),
    source: text("source").notNull().default("dashboard"),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("repository_enablement_events_org_time_idx").on(
      t.orgId,
      t.occurredAt,
      t.id,
    ),
    index("repository_enablement_events_repo_time_idx").on(
      t.repositoryId,
      t.occurredAt,
      t.id,
    ),
    check(
      "repository_enablement_events_action_check",
      sql`${t.action} IN ('enable', 'disable')`,
    ),
    check(
      "repository_enablement_events_source_check",
      sql`${t.source} IN ('dashboard', 'github_installation', 'github_pull_request', 'github_transfer', 'github_uninstall', 'migration_baseline')`,
    ),
  ],
);

export const reviews = pgTable(
  "reviews",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    publicId: uuid("public_id").notNull().defaultRandom(),
    repositoryId: bigint("repository_id", { mode: "number" })
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    sourceOrgId: bigint("source_org_id", { mode: "number" }),
    sourceInstallationId: bigint("source_installation_id", { mode: "number" }),
    sourceGithubInstallationId: bigint("source_github_installation_id", {
      mode: "number",
    }),
    sourceGithubRepoId: bigint("source_github_repo_id", { mode: "number" }),
    sourceRepoFullName: text("source_repo_full_name"),
    prNumber: integer("pr_number").notNull(),
    authorGithubId: bigint("author_github_id", { mode: "number" }),
    authorLogin: text("author_login"),
    headSha: text("head_sha").notNull(),
    baseSha: text("base_sha").notNull(),
    sinceSha: text("since_sha"),
    triggerSource: text("trigger_source").notNull().default("unknown"),
    triggerContext: jsonb("trigger_context").$type<ReviewTriggerContext>(),
    status: reviewStatus("status").notNull().default("queued"),
    envelope: jsonb("envelope").$type<Envelope>(),
    configFiles: text("config_files").array(),
    configProvenance:
      jsonb("config_provenance").$type<ReviewConfigProvenance>(),
    silent: boolean("silent"),
    engineGateFailing: boolean("engine_gate_failing"),
    gateFailing: boolean("gate_failing"),
    errorMessage: text("error_message"),
    advisoryCheckRunId: bigint("advisory_check_run_id", { mode: "number" }),
    gateCheckRunId: bigint("gate_check_run_id", { mode: "number" }),
    gateSyncLeaseId: uuid("gate_sync_lease_id"),
    gateSyncLeaseExpiresAt: timestamp("gate_sync_lease_expires_at", {
      withTimezone: true,
    }),
    publicationLifecycleReconciledAt: timestamp(
      "publication_lifecycle_reconciled_at",
      { withTimezone: true },
    ),
    publicationLifecycleRequiredAt: timestamp(
      "publication_lifecycle_required_at",
      { withTimezone: true },
    ),
    queuedAt: timestamp("queued_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("reviews_public_id_idx").on(t.publicId),
    index("reviews_repo_pr_idx").on(t.repositoryId, t.prNumber),
    index("reviews_status_idx").on(t.status),
    index("reviews_running_started_at_idx")
      .on(t.startedAt)
      .where(sql`${t.status} = 'running'`),
    index("reviews_publication_lifecycle_pending_idx")
      .on(t.finishedAt)
      .where(
        sql`${t.status} = 'completed' AND ${t.publicationLifecycleRequiredAt} IS NOT NULL AND ${t.publicationLifecycleReconciledAt} IS NULL`,
      ),
    check(
      "reviews_trigger_source_check",
      sql`${t.triggerSource} IN ('unknown', 'automatic_pull_request', 'requested_review', 'github_check_rerun')`,
    ),
    check(
      "reviews_trigger_context_check",
      sql`(${t.triggerSource} = 'unknown' AND (${t.triggerContext} IS NULL OR ${t.triggerContext} = '{"source":"unknown"}'::jsonb)) OR (${t.triggerSource} <> 'unknown' AND ${t.triggerContext} IS NOT NULL AND jsonb_typeof(${t.triggerContext}) = 'object' AND ${t.triggerContext} - ARRAY['source', 'webhookDeliveryId', 'webhookEvent', 'webhookAction', 'sourceCommentId', 'sourceUrl', 'requestedByGithubId', 'requestedByLogin', 'checkName']::text[] = '{}'::jsonb AND ${t.triggerContext}->>'source' = ${t.triggerSource} AND jsonb_typeof(${t.triggerContext}->'webhookDeliveryId') = 'string' AND COALESCE(length(btrim(${t.triggerContext}->>'webhookDeliveryId')), 0) > 0 AND length(${t.triggerContext}->>'webhookDeliveryId') <= 200 AND ((${t.triggerSource} = 'automatic_pull_request' AND ${t.triggerContext}->>'webhookEvent' = 'pull_request') OR (${t.triggerSource} = 'requested_review' AND ${t.triggerContext}->>'webhookEvent' IN ('issue_comment', 'pull_request_review_comment')) OR (${t.triggerSource} = 'github_check_rerun' AND ${t.triggerContext}->>'webhookEvent' IN ('check_run', 'check_suite'))) AND (NOT ${t.triggerContext} ? 'webhookAction' OR (jsonb_typeof(${t.triggerContext}->'webhookAction') = 'string' AND length(${t.triggerContext}->>'webhookAction') <= 100)) AND (NOT ${t.triggerContext} ? 'sourceCommentId' OR (jsonb_typeof(${t.triggerContext}->'sourceCommentId') = 'number' AND (${t.triggerContext}->>'sourceCommentId')::numeric = trunc((${t.triggerContext}->>'sourceCommentId')::numeric) AND (${t.triggerContext}->>'sourceCommentId')::numeric BETWEEN 1 AND 9007199254740991)) AND (NOT ${t.triggerContext} ? 'sourceUrl' OR (jsonb_typeof(${t.triggerContext}->'sourceUrl') = 'string' AND length(${t.triggerContext}->>'sourceUrl') <= 2048 AND ${t.triggerContext}->>'sourceUrl' ~* '^https://github[.]com([/?#]|$)')) AND (NOT ${t.triggerContext} ? 'requestedByGithubId' OR (jsonb_typeof(${t.triggerContext}->'requestedByGithubId') = 'number' AND (${t.triggerContext}->>'requestedByGithubId')::numeric = trunc((${t.triggerContext}->>'requestedByGithubId')::numeric) AND (${t.triggerContext}->>'requestedByGithubId')::numeric BETWEEN 1 AND 9007199254740991)) AND (NOT ${t.triggerContext} ? 'requestedByLogin' OR (jsonb_typeof(${t.triggerContext}->'requestedByLogin') = 'string' AND length(${t.triggerContext}->>'requestedByLogin') <= 100)) AND (NOT ${t.triggerContext} ? 'checkName' OR (jsonb_typeof(${t.triggerContext}->'checkName') = 'string' AND length(${t.triggerContext}->>'checkName') <= 200)))`,
    ),
  ],
);

/**
 * Immutable identity for the CLI's publication result. A row without a CLI
 * receipt records a legacy review whose publication could not be observed.
 */
export const reviewPublicationReceipts = pgTable(
  "review_publication_receipts",
  {
    reviewId: bigint("review_id", { mode: "number" })
      .primaryKey()
      .references(() => reviews.id, { onDelete: "cascade" }),
    receiptVersion: integer("receipt_version"),
    receiptId: text("receipt_id"),
    publicationChannel: text("publication_channel"),
    githubReviewId: text("github_review_id"),
    observedAt: timestamp("observed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "review_publication_receipts_identity_check",
      sql`(${t.receiptVersion} IS NULL AND ${t.receiptId} IS NULL AND ${t.publicationChannel} IS NULL) OR (${t.receiptVersion} = 1 AND length(btrim(${t.receiptId})) BETWEEN 1 AND 200 AND (${t.publicationChannel} IS NULL OR ${t.publicationChannel} = 'reviewComments')) OR (${t.receiptVersion} = 2 AND length(btrim(${t.receiptId})) BETWEEN 1 AND 200 AND ${t.publicationChannel} IS NOT NULL AND ${t.publicationChannel} IN ('reviewComments', 'checkAnnotations'))`,
    ),
    check(
      "review_publication_receipts_github_review_id_check",
      sql`${t.githubReviewId} IS NULL OR ${t.githubReviewId} ~ '^[1-9][0-9]{0,19}$'`,
    ),
  ],
);

/**
 * Immutable identity for a deterministic large-review run. The run key binds
 * the CLI release, effective configuration, provider, repository, head, and
 * deterministic coverage plan before any provider request is allowed through
 * the worker-owned proxy.
 */
export const largeReviewRuns = pgTable(
  "large_review_runs",
  {
    runKey: text("run_key").primaryKey(),
    currentReviewId: bigint("current_review_id", { mode: "number" })
      .notNull()
      .references(() => reviews.id, { onDelete: "cascade" }),
    repositoryId: bigint("repository_id", { mode: "number" })
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    prNumber: integer("pr_number").notNull(),
    cliVersion: text("cli_version").notNull(),
    configurationSha256: text("configuration_sha256").notNull(),
    providerIdentity: text("provider_identity").notNull(),
    headSha: text("head_sha").notNull(),
    baseSha: text("base_sha").notNull(),
    retryLineage: text("retry_lineage").notNull(),
    planSha256: text("plan_sha256").notNull(),
    hostedReservationId: uuid("hosted_reservation_id"),
    billingState: text("billing_state").notNull().default("active"),
    conservativelySettledAt: timestamp("conservatively_settled_at", {
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("large_review_runs_expiry_idx").on(t.expiresAt),
    index("large_review_runs_resume_identity_idx").on(
      t.repositoryId,
      t.prNumber,
      t.headSha,
      t.baseSha,
      t.cliVersion,
      t.configurationSha256,
      t.retryLineage,
    ),
    check("large_review_runs_key_check", sql`${t.runKey} ~ '^[0-9a-f]{64}$'`),
    check(
      "large_review_runs_configuration_check",
      sql`${t.configurationSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "large_review_runs_plan_check",
      sql`${t.planSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "large_review_runs_identity_lengths_check",
      sql`${t.prNumber} > 0 AND length(btrim(${t.cliVersion})) BETWEEN 1 AND 100 AND length(btrim(${t.providerIdentity})) BETWEEN 1 AND 2048 AND length(btrim(${t.headSha})) BETWEEN 1 AND 200 AND length(btrim(${t.baseSha})) BETWEEN 1 AND 200 AND length(btrim(${t.retryLineage})) BETWEEN 1 AND 200`,
    ),
    check(
      "large_review_runs_billing_state_check",
      sql`(${t.billingState} = 'active' AND ${t.conservativelySettledAt} IS NULL) OR (${t.billingState} = 'conservative' AND ${t.conservativelySettledAt} IS NOT NULL)`,
    ),
  ],
);

/** Provider responses that can be replayed byte-for-byte after worker loss. */
export const largeReviewAttempts = pgTable(
  "large_review_attempts",
  {
    attemptKey: text("attempt_key").primaryKey(),
    runKey: text("run_key")
      .notNull()
      .references(() => largeReviewRuns.runKey, { onDelete: "cascade" }),
    requestSha256: text("request_sha256").notNull(),
    batchIdentity: text("batch_identity").notNull(),
    attempt: integer("attempt").notNull(),
    model: text("model").notNull(),
    state: text("state").notNull(),
    leaseId: uuid("lease_id").notNull(),
    leaseExpiresAt: timestamp("lease_expires_at", {
      withTimezone: true,
    }).notNull(),
    responseStatus: integer("response_status"),
    responseHeaders: jsonb("response_headers").$type<Record<string, string>>(),
    responseBody: text("response_body"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("large_review_attempts_run_request_attempt_idx").on(
      t.runKey,
      t.requestSha256,
      t.attempt,
    ),
    uniqueIndex("large_review_attempts_pending_request_idx")
      .on(t.runKey, t.requestSha256)
      .where(sql`${t.state} = 'pending'`),
    index("large_review_attempts_run_idx").on(t.runKey),
    check(
      "large_review_attempts_key_check",
      sql`${t.attemptKey} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "large_review_attempts_request_check",
      sql`${t.requestSha256} ~ '^[0-9a-f]{64}$' AND ${t.batchIdentity} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "large_review_attempts_attempt_check",
      sql`${t.attempt} BETWEEN 1 AND 10`,
    ),
    check(
      "large_review_attempts_state_check",
      sql`${t.state} IN ('pending', 'completed')`,
    ),
    check(
      "large_review_attempts_response_check",
      sql`(${t.state} = 'pending' AND ${t.responseStatus} IS NULL AND ${t.responseHeaders} IS NULL AND ${t.responseBody} IS NULL AND ${t.completedAt} IS NULL) OR (${t.state} = 'completed' AND ${t.responseStatus} BETWEEN 200 AND 299 AND ${t.responseHeaders} IS NOT NULL AND ${t.responseBody} IS NOT NULL AND ${t.completedAt} IS NOT NULL)`,
    ),
    check(
      "large_review_attempts_model_check",
      sql`length(btrim(${t.model})) BETWEEN 1 AND 500`,
    ),
  ],
);

/** Per-finding publication identity and its normalized, observed lifecycle. */
export const findingPublications = pgTable(
  "finding_publications",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    reviewId: bigint("review_id", { mode: "number" })
      .notNull()
      .references(() => reviews.id, { onDelete: "cascade" }),
    findingId: text("finding_id").notNull(),
    stableIdentity: boolean("stable_identity").notNull(),
    initialState: text("initial_state").notNull(),
    currentState: text("current_state").notNull(),
    githubCommentId: text("github_comment_id"),
    lifecycleObservedAt: timestamp("lifecycle_observed_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("finding_publications_review_finding_idx").on(
      t.reviewId,
      t.findingId,
    ),
    index("finding_publications_comment_idx").on(t.githubCommentId),
    index("finding_publications_stable_finding_idx").on(
      t.findingId,
      t.stableIdentity,
    ),
    check(
      "finding_publications_finding_id_check",
      sql`length(btrim(${t.findingId})) BETWEEN 1 AND 500`,
    ),
    check(
      "finding_publications_initial_state_check",
      sql`${t.initialState} IN ('inline', 'fileComment', 'checkAnnotation', 'summaryOnly', 'carried', 'resolved', 'suppressed', 'inlineRejected', 'unknown')`,
    ),
    check(
      "finding_publications_current_state_check",
      sql`${t.currentState} IN ('inline', 'fileComment', 'checkAnnotation', 'summaryOnly', 'carried', 'resolved', 'suppressed', 'inlineRejected', 'outdated', 'deleted', 'unknown')`,
    ),
    check(
      "finding_publications_github_comment_id_check",
      sql`${t.githubCommentId} IS NULL OR ${t.githubCommentId} ~ '^[1-9][0-9]{0,19}$'`,
    ),
    check(
      "finding_publications_file_comment_identity_check",
      sql`(${t.initialState} <> 'fileComment' AND ${t.currentState} <> 'fileComment') OR ${t.githubCommentId} IS NOT NULL`,
    ),
  ],
);

/** Immutable feedback attached to a published finding, never a gate decision. */
export const findingFeedback = pgTable(
  "finding_feedback",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    findingPublicationId: bigint("finding_publication_id", { mode: "number" })
      .notNull()
      .references(() => findingPublications.id, { onDelete: "cascade" }),
    source: text("source", { enum: ["reply", "reaction"] }).notNull(),
    sourceGithubCommentId: bigint("source_github_comment_id", {
      mode: "number",
    }),
    sourceGithubReactionId: bigint("source_github_reaction_id", {
      mode: "number",
    }),
    reactionContent: text("reaction_content", { enum: ["+1", "-1", "unknown"] }),
    body: text("body"),
    actorGithubId: bigint("actor_github_id", { mode: "number" }).notNull(),
    actorLoginSnapshot: text("actor_login_snapshot").notNull(),
    prAuthorGithubId: bigint("pr_author_github_id", {
      mode: "number",
    }).notNull(),
    prAuthorLoginSnapshot: text("pr_author_login_snapshot").notNull(),
    actorIsPrAuthor: boolean("actor_is_pr_author").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    sourceDeliveryId: text("source_delivery_id"),
    suggestedReasonTag: text("suggested_reason_tag"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("finding_feedback_publication_observed_idx").on(
      t.findingPublicationId,
      t.observedAt,
    ),
    uniqueIndex("finding_feedback_github_reply_idx")
      .on(t.sourceGithubCommentId)
      .where(sql`${t.source} = 'reply'`),
    uniqueIndex("finding_feedback_github_reaction_idx")
      .on(t.sourceGithubReactionId)
      .where(sql`${t.source} = 'reaction'`),
    check(
      "finding_feedback_source_check",
      sql`${t.source} IN ('reply', 'reaction')`,
    ),
    check(
      "finding_feedback_identity_check",
      sql`(${t.source} = 'reply' AND ${t.sourceGithubCommentId} IS NOT NULL AND ${t.sourceGithubCommentId} BETWEEN 1 AND 9007199254740991 AND ${t.sourceGithubReactionId} IS NULL AND ${t.reactionContent} IS NULL AND ${t.body} IS NOT NULL AND length(btrim(${t.body})) BETWEEN 1 AND 65535 AND length(btrim(${t.sourceDeliveryId})) BETWEEN 1 AND 200) OR (${t.source} = 'reaction' AND ${t.sourceGithubCommentId} IS NOT NULL AND ${t.sourceGithubCommentId} BETWEEN 1 AND 9007199254740991 AND ${t.sourceGithubReactionId} IS NOT NULL AND ${t.sourceGithubReactionId} BETWEEN 1 AND 9007199254740991 AND ${t.reactionContent} IS NOT NULL AND ${t.reactionContent} IN ('+1', '-1', 'unknown') AND ${t.body} IS NULL AND ${t.sourceDeliveryId} IS NULL)`,
    ),
    check(
      "finding_feedback_actor_check",
      sql`${t.actorGithubId} BETWEEN 1 AND 9007199254740991 AND length(btrim(${t.actorLoginSnapshot})) BETWEEN 1 AND 100 AND ${t.prAuthorGithubId} BETWEEN 1 AND 9007199254740991 AND length(btrim(${t.prAuthorLoginSnapshot})) BETWEEN 1 AND 100 AND ${t.actorIsPrAuthor} = (${t.actorGithubId} = ${t.prAuthorGithubId})`,
    ),
    check(
      "finding_feedback_suggested_reason_check",
      sql`${t.suggestedReasonTag} IS NULL OR ${t.suggestedReasonTag} IN ('false-positive', 'accepted-risk', 'out-of-scope')`,
    ),
  ],
);

/** Durable scheduling state for feedback observation, separate from publication lifecycle. */
export const findingFeedbackReconciliations = pgTable(
  "finding_feedback_reconciliations",
  {
    findingPublicationId: bigint("finding_publication_id", { mode: "number" })
      .primaryKey()
      .references(() => findingPublications.id, { onDelete: "cascade" }),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextReconcileAt: timestamp("next_reconcile_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    lastSuccessfulAt: timestamp("last_successful_at", { withTimezone: true }),
    lastError: text("last_error"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("finding_feedback_reconcile_due_idx").on(t.nextReconcileAt),
    check(
      "finding_feedback_reconcile_attempt_count_check",
      sql`${t.attemptCount} >= 0`,
    ),
  ],
);

export const findingApprovals = pgTable(
  "finding_approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reviewId: bigint("review_id", { mode: "number" })
      .notNull()
      .references(() => reviews.id, { onDelete: "cascade" }),
    findingId: text("finding_id").notNull(),
    actorUserId: bigint("actor_user_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    actorGithubId: text("actor_github_id").notNull(),
    actorLoginSnapshot: text("actor_login_snapshot").notNull(),
    actorRoleSnapshot: findingApprovalRole("actor_role_snapshot").notNull(),
    verb: findingApprovalVerb("verb").notNull().default("approve"),
    reasonTag: text("reason_tag"),
    authorSelfDismissal: boolean("author_self_dismissal")
      .notNull()
      .default(false),
    findingKind: text("finding_kind"),
    findingSeverity: text("finding_severity"),
    findingConfidence: real("finding_confidence"),
    findingGeneratorModel: text("finding_model"),
    findingScorerModel: text("finding_scorer_model"),
    rationale: text("rationale").notNull(),
    source: findingApprovalSource("source").notNull(),
    sourceCommentId: uuid("source_comment_id"),
    sourceUrl: text("source_url"),
    sourceOrgId: bigint("source_org_id", { mode: "number" }),
    sourceRepositoryId: bigint("source_repository_id", { mode: "number" }),
    sourceGithubInstallationId: bigint("source_github_installation_id", {
      mode: "number",
    }),
    sourceGithubRepoId: bigint("source_github_repo_id", { mode: "number" }),
    sourcePrNumber: integer("source_pr_number"),
    sourceHeadSha: text("source_head_sha"),
    sourceWebhookDeliveryId: text("source_webhook_delivery_id"),
    sourceGithubCommentId: bigint("source_github_comment_id", {
      mode: "number",
    }),
    sourceCommentKind: text("source_comment_kind"),
    sourceBindingState: text("source_binding_state", {
      enum: ["exact", "legacy"],
    })
      .notNull()
      .default("exact"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedByUserId: bigint("revoked_by_user_id", {
      mode: "number",
    }).references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [
    uniqueIndex("finding_approvals_active_idx")
      .on(t.reviewId, t.findingId)
      .where(sql`${t.revokedAt} IS NULL`),
    uniqueIndex("finding_approvals_github_comment_idx")
      .on(
        t.sourceGithubInstallationId,
        t.sourceGithubRepoId,
        t.sourceCommentKind,
        t.sourceGithubCommentId,
      )
      .where(sql`${t.source} = 'github'`),
    uniqueIndex("finding_approvals_github_delivery_idx")
      .on(t.sourceWebhookDeliveryId)
      .where(sql`${t.source} = 'github'`),
    index("finding_approvals_review_idx").on(t.reviewId),
    check(
      "finding_approvals_rationale_nonempty",
      sql`length(btrim(${t.rationale})) > 0`,
    ),
    check(
      "finding_approvals_dismissal_check",
      sql`(${t.verb} = 'approve' AND ${t.reasonTag} IS NULL AND ${t.authorSelfDismissal} = false AND ${t.findingKind} IS NULL AND ${t.findingSeverity} IS NULL AND ${t.findingConfidence} IS NULL AND ${t.findingGeneratorModel} IS NULL AND ${t.findingScorerModel} IS NULL) OR (${t.verb} = 'dismiss' AND ${t.reasonTag} IS NOT NULL AND ${t.reasonTag} IN ('false-positive', 'accepted-risk', 'out-of-scope') AND ${t.findingKind} IS NOT NULL AND ${t.findingSeverity} IS NOT NULL AND ${t.findingConfidence} IS NOT NULL AND ${t.findingConfidence} BETWEEN 0 AND 1 AND ${t.findingGeneratorModel} IS NOT NULL)`,
    ),
    check(
      "finding_approvals_binding_check",
      sql`(${t.sourceBindingState} = 'legacy' AND ${t.sourceOrgId} IS NULL AND ${t.sourceRepositoryId} IS NULL AND ${t.sourceGithubInstallationId} IS NULL AND ${t.sourceGithubRepoId} IS NULL AND ${t.sourcePrNumber} IS NULL AND ${t.sourceHeadSha} IS NULL) OR (${t.sourceBindingState} = 'exact' AND ${t.sourceOrgId} > 0 AND ${t.sourceRepositoryId} > 0 AND ${t.sourceGithubInstallationId} > 0 AND ${t.sourceGithubRepoId} > 0 AND ${t.sourcePrNumber} > 0 AND length(btrim(${t.sourceHeadSha})) BETWEEN 1 AND 200)`,
    ),
    check(
      "finding_approvals_github_source_check",
      sql`${t.source} <> 'github' OR (${t.sourceWebhookDeliveryId} IS NULL AND ${t.sourceGithubCommentId} IS NULL AND ${t.sourceCommentKind} IS NULL) OR (length(btrim(${t.sourceWebhookDeliveryId})) BETWEEN 1 AND 200 AND ${t.sourceGithubCommentId} > 0 AND ${t.sourceCommentKind} IN ('issue_comment', 'pull_request_review_comment'))`,
    ),
  ],
);

export const reviewLogs = pgTable(
  "review_logs",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    reviewId: bigint("review_id", { mode: "number" })
      .notNull()
      .references(() => reviews.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    line: text("line").notNull(),
  },
  (t) => [uniqueIndex("review_logs_review_seq_idx").on(t.reviewId, t.seq)],
);

export const usageEvents = pgTable(
  "usage_events",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    orgId: bigint("org_id", { mode: "number" }).references(
      () => organizations.id,
      {
        onDelete: "set null",
      },
    ),
    repositoryId: bigint("repository_id", { mode: "number" }).references(
      () => repositories.id,
      { onDelete: "set null" },
    ),
    reviewId: bigint("review_id", { mode: "number" }).references(
      () => reviews.id,
      {
        onDelete: "set null",
      },
    ),
    triggerSource: text("trigger_source").notNull().default("unknown"),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    modelUsed: text("model_used"),
    /** Exact provider-priced spend in millionths of one US dollar. */
    costMicros: bigint("cost_micros", { mode: "number" }),
    /** Rolling-deploy compatibility; new accounting reads costMicros. */
    costCents: integer("cost_cents"),
    // Required from current writers. The database trigger classifies omitted
    // values only for pre-0020 processes during the migration rollout.
    billingScope: text("billing_scope").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "usage_events_cost_micros_nonnegative",
      sql`${t.costMicros} IS NULL OR ${t.costMicros} >= 0`,
    ),
    check(
      "usage_events_cost_cents_nonnegative",
      sql`${t.costCents} IS NULL OR ${t.costCents} >= 0`,
    ),
    check(
      "usage_events_billing_scope_check",
      sql`${t.billingScope} IN ('analytics', 'private_hosted')`,
    ),
    check(
      "usage_events_trigger_source_check",
      sql`${t.triggerSource} IN ('unknown', 'automatic_pull_request', 'requested_review', 'github_check_rerun', 'github_mention')`,
    ),
  ],
);

export const billingCreditGrants = pgTable(
  "billing_credit_grants",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    orgId: bigint("org_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    amountCents: integer("amount_cents").notNull(),
    reason: text("reason").notNull(),
    actor: text("actor").notNull(),
    source: text("source").notNull().default("admin_script"),
    idempotencyKey: text("idempotency_key").notNull(),
    appliesAt: timestamp("applies_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("billing_credit_grants_org_created_idx").on(
      t.orgId,
      t.createdAt,
      t.id,
    ),
    uniqueIndex("billing_credit_grants_org_idempotency_idx").on(
      t.orgId,
      t.idempotencyKey,
    ),
    check(
      "billing_credit_grants_amount_cents_positive",
      sql`${t.amountCents} > 0`,
    ),
    check(
      "billing_credit_grants_reason_nonempty",
      sql`length(btrim(${t.reason})) > 0`,
    ),
    check(
      "billing_credit_grants_actor_nonempty",
      sql`length(btrim(${t.actor})) > 0`,
    ),
    check(
      "billing_credit_grants_source_nonempty",
      sql`length(btrim(${t.source})) > 0`,
    ),
    check(
      "billing_credit_grants_idempotency_key_nonempty",
      sql`length(btrim(${t.idempotencyKey})) > 0`,
    ),
  ],
);

/** Organization product entitlement. Provider credentials never grant access. */
export const organizationEntitlements = pgTable(
  "organization_entitlements",
  {
    orgId: bigint("org_id", { mode: "number" })
      .primaryKey()
      .references(() => organizations.id, { onDelete: "cascade" }),
    subscriptionMode: text("subscription_mode").notNull(),
    status: text("status").notNull(),
    trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
    pastDueGraceEndsAt: timestamp("past_due_grace_ends_at", {
      withTimezone: true,
    }),
    periodStartsAt: timestamp("period_starts_at", { withTimezone: true }),
    periodEndsAt: timestamp("period_ends_at", { withTimezone: true }),
    /** Allowance and cap use USD micros so sub-cent model calls remain exact. */
    includedUsageMicros: bigint("included_usage_micros", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    overageHardCapMicros: bigint("overage_hard_cap_micros", {
      mode: "bigint",
    }).default(sql`0`),
    /** Rolling-deploy compatibility; new entitlement checks read the micros fields. */
    includedUsageCents: integer("included_usage_cents").notNull().default(0),
    overageHardCapCents: integer("overage_hard_cap_cents").default(0),
    billingContactEmail: text("billing_contact_email"),
    billingContactVerifiedAt: timestamp("billing_contact_verified_at", {
      withTimezone: true,
    }),
    billingContactPending: text("billing_contact_pending"),
    billingContactVerificationTokenDigest: bytea(
      "billing_contact_verification_token_digest",
    ),
    billingContactVerificationTokenCiphertext: bytea(
      "billing_contact_verification_token_ciphertext",
    ),
    billingContactVerificationExpiresAt: timestamp(
      "billing_contact_verification_expires_at",
      { withTimezone: true },
    ),
    billingContactVerificationRequestedAt: timestamp(
      "billing_contact_verification_requested_at",
      { withTimezone: true },
    ),
    billingContactVerificationSentAt: timestamp(
      "billing_contact_verification_sent_at",
      {
        withTimezone: true,
      },
    ),
    billingContactVerificationMessageId: text(
      "billing_contact_verification_message_id",
    ),
    promotionalEligible: boolean("promotional_eligible")
      .notNull()
      .default(false),
    promotionalEndsAt: timestamp("promotional_ends_at", { withTimezone: true }),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "organization_entitlements_subscription_mode_check",
      sql`${t.subscriptionMode} IN ('hosted', 'byok')`,
    ),
    check(
      "organization_entitlements_status_check",
      sql`${t.status} IN ('active', 'trialing', 'past_due', 'suspended')`,
    ),
    check(
      "organization_entitlements_included_usage_micros_nonnegative",
      sql`${t.includedUsageMicros} >= 0`,
    ),
    check(
      "organization_entitlements_overage_cap_micros_nonnegative",
      sql`${t.overageHardCapMicros} IS NULL OR ${t.overageHardCapMicros} >= 0`,
    ),
    check(
      "organization_entitlements_included_usage_nonnegative",
      sql`${t.includedUsageCents} >= 0`,
    ),
    check(
      "organization_entitlements_overage_cap_nonnegative",
      sql`${t.overageHardCapCents} IS NULL OR ${t.overageHardCapCents} >= 0`,
    ),
    check(
      "organization_entitlements_updated_by_nonempty",
      sql`length(btrim(${t.updatedBy})) > 0`,
    ),
  ],
);

/** Durable dark lifecycle state for entitlement-bound hosted provider keys. */
export const hostedProviderKeys = pgTable(
  "hosted_provider_keys",
  {
    createIntentId: uuid("create_intent_id").primaryKey(),
    orgId: bigint("org_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    state: text("state").notNull(),
    providerKeyName: text("provider_key_name").notNull().unique(),
    providerKeyHash: text("provider_key_hash"),
    conflictingProviderKeyHash: text("conflicting_provider_key_hash"),
    sealedRuntimeKey: bytea("sealed_runtime_key"),
    entitlementPeriodStartsAt: timestamp("entitlement_period_starts_at", {
      withTimezone: true,
    }).notNull(),
    entitlementPeriodEndsAt: timestamp("entitlement_period_ends_at", {
      withTimezone: true,
    }).notNull(),
    entitlementUpdatedAt: timestamp("entitlement_updated_at", {
      withTimezone: true,
    }).notNull(),
    limitMicros: bigint("limit_micros", { mode: "bigint" }).notNull(),
    createAttemptedAt: timestamp("create_attempted_at", {
      withTimezone: true,
    }),
    createOutcome: text("create_outcome"),
    revocationRequestedAt: timestamp("revocation_requested_at", {
      withTimezone: true,
    }),
    revokeAttemptedAt: timestamp("revoke_attempted_at", {
      withTimezone: true,
    }),
    revokeOutcome: text("revoke_outcome"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    reconciliationRequiredAt: timestamp("reconciliation_required_at", {
      withTimezone: true,
    }),
    leaseId: uuid("lease_id"),
    leaseKind: text("lease_kind"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    uniqueIndex("hosted_provider_keys_provider_key_hash_unique")
      .on(t.providerKeyHash)
      .where(sql`${t.providerKeyHash} IS NOT NULL`),
    uniqueIndex("hosted_provider_keys_entitlement_binding_unique")
      .on(
        t.orgId,
        t.entitlementPeriodStartsAt,
        t.entitlementPeriodEndsAt,
        t.limitMicros,
      )
      .where(sql`${t.state} NOT IN ('revoked', 'cancelled')`),
    uniqueIndex("hosted_provider_keys_active_org_unique")
      .on(t.orgId)
      .where(sql`${t.state} = 'active'`),
    uniqueIndex("hosted_provider_keys_runtime_org_unique")
      .on(t.orgId)
      .where(sql`${t.sealedRuntimeKey} IS NOT NULL`),
    index("hosted_provider_keys_reconciliation_idx").on(
      t.state,
      t.reconciliationRequiredAt,
    ),
    check(
      "hosted_provider_keys_state_check",
      sql`${t.state} IN ('provisioning', 'activating', 'active', 'rejected', 'orphaned', 'revocation_pending', 'revoked', 'cancelled')`,
    ),
    check(
      "hosted_provider_keys_provider_key_name_nonempty",
      sql`length(btrim(${t.providerKeyName})) > 0`,
    ),
    check(
      "hosted_provider_keys_provider_key_hash_nonempty",
      sql`${t.providerKeyHash} IS NULL OR length(btrim(${t.providerKeyHash})) > 0`,
    ),
    check(
      "hosted_provider_keys_conflicting_hash_nonempty",
      sql`${t.conflictingProviderKeyHash} IS NULL OR length(btrim(${t.conflictingProviderKeyHash})) > 0`,
    ),
    check(
      "hosted_provider_keys_entitlement_period_check",
      sql`${t.entitlementPeriodEndsAt} > ${t.entitlementPeriodStartsAt}`,
    ),
    check(
      "hosted_provider_keys_limit_exact_range",
      sql`${t.limitMicros} > 0 AND ${t.limitMicros} <= 2251799813685247`,
    ),
    check(
      "hosted_provider_keys_create_outcome_check",
      sql`${t.createOutcome} IS NULL OR ${t.createOutcome} IN ('created', 'rejected', 'rate_limited', 'ambiguous', 'name_present', 'name_not_unique', 'credential_persistence_failed', 'intent_changed', 'ownership_conflict')`,
    ),
    check(
      "hosted_provider_keys_revoke_outcome_check",
      sql`${t.revokeOutcome} IS NULL OR ${t.revokeOutcome} IN ('ambiguous', 'rejected', 'disabled', 'absent')`,
    ),
    check(
      "hosted_provider_keys_lease_shape",
      sql`(
        ${t.leaseId} IS NULL
        AND ${t.leaseKind} IS NULL
        AND ${t.leaseExpiresAt} IS NULL
      ) OR (
        ${t.leaseId} IS NOT NULL
        AND ${t.leaseKind} IN ('create', 'revoke')
        AND ${t.leaseExpiresAt} IS NOT NULL
      )`,
    ),
    check(
      "hosted_provider_keys_lease_state",
      sql`${t.leaseId} IS NULL OR (
        (${t.leaseKind} = 'create' AND ${t.state} IN ('provisioning', 'activating', 'orphaned'))
        OR (${t.leaseKind} = 'revoke' AND ${t.state} = 'revocation_pending')
      )`,
    ),
    check(
      "hosted_provider_keys_lifecycle_shape",
      sql`(
        ${t.state} = 'provisioning'
        AND ${t.sealedRuntimeKey} IS NULL
        AND ${t.providerKeyHash} IS NULL
        AND ${t.conflictingProviderKeyHash} IS NULL
        AND ${t.createOutcome} IS NULL
        AND ${t.revocationRequestedAt} IS NULL
        AND ${t.revokeOutcome} IS NULL
        AND ${t.revokedAt} IS NULL
      ) OR (
        ${t.state} = 'activating'
        AND ${t.sealedRuntimeKey} IS NULL
        AND ${t.providerKeyHash} IS NOT NULL
        AND ${t.conflictingProviderKeyHash} IS NULL
        AND ${t.createAttemptedAt} IS NOT NULL
        AND ${t.createOutcome} = 'created'
        AND ${t.reconciliationRequiredAt} IS NOT NULL
        AND ${t.revocationRequestedAt} IS NULL
        AND ${t.revokeOutcome} IS NULL
        AND ${t.revokedAt} IS NULL
      ) OR (
        ${t.state} = 'active'
        AND ${t.sealedRuntimeKey} IS NOT NULL
        AND ${t.providerKeyHash} IS NOT NULL
        AND ${t.conflictingProviderKeyHash} IS NULL
        AND ${t.createAttemptedAt} IS NOT NULL
        AND ${t.createOutcome} = 'created'
        AND ${t.reconciliationRequiredAt} IS NULL
        AND ${t.revocationRequestedAt} IS NULL
        AND ${t.revokeOutcome} IS NULL
        AND ${t.revokedAt} IS NULL
      ) OR (
        ${t.state} = 'rejected'
        AND ${t.sealedRuntimeKey} IS NULL
        AND ${t.providerKeyHash} IS NULL
        AND ${t.conflictingProviderKeyHash} IS NULL
        AND ${t.createAttemptedAt} IS NOT NULL
        AND ${t.createOutcome} = 'rejected'
        AND ${t.reconciliationRequiredAt} IS NULL
        AND ${t.revocationRequestedAt} IS NULL
        AND ${t.revokeOutcome} IS NULL
        AND ${t.revokedAt} IS NULL
      ) OR (
        ${t.state} = 'orphaned'
        AND ${t.sealedRuntimeKey} IS NULL
        AND ${t.createOutcome} IN ('ambiguous', 'name_present', 'name_not_unique', 'credential_persistence_failed', 'intent_changed', 'ownership_conflict')
        AND ${t.reconciliationRequiredAt} IS NOT NULL
        AND ${t.revocationRequestedAt} IS NULL
        AND ${t.revokeOutcome} IS NULL
        AND ${t.revokedAt} IS NULL
        AND (
          (${t.createOutcome} = 'ownership_conflict' AND ${t.providerKeyHash} IS NULL AND ${t.conflictingProviderKeyHash} IS NOT NULL)
          OR (${t.createOutcome} <> 'ownership_conflict' AND ${t.conflictingProviderKeyHash} IS NULL)
        )
      ) OR (
        ${t.state} = 'revocation_pending'
        AND ${t.sealedRuntimeKey} IS NULL
        AND ${t.providerKeyHash} IS NOT NULL
        AND ${t.conflictingProviderKeyHash} IS NULL
        AND ${t.createAttemptedAt} IS NOT NULL
        AND ${t.createOutcome} IN ('created', 'ambiguous', 'credential_persistence_failed')
        AND ${t.revocationRequestedAt} IS NOT NULL
        AND ${t.reconciliationRequiredAt} IS NOT NULL
        AND ${t.revokedAt} IS NULL
      ) OR (
        ${t.state} = 'revoked'
        AND ${t.sealedRuntimeKey} IS NULL
        AND ${t.providerKeyHash} IS NOT NULL
        AND ${t.conflictingProviderKeyHash} IS NULL
        AND ${t.createAttemptedAt} IS NOT NULL
        AND ${t.createOutcome} IN ('created', 'ambiguous', 'credential_persistence_failed')
        AND ${t.revocationRequestedAt} IS NOT NULL
        AND ${t.revokeOutcome} IN ('disabled', 'absent')
        AND ${t.revokedAt} IS NOT NULL
        AND ${t.reconciliationRequiredAt} IS NULL
        AND ${t.leaseId} IS NULL
      ) OR (
        ${t.state} = 'cancelled'
        AND ${t.sealedRuntimeKey} IS NULL
        AND ${t.providerKeyHash} IS NULL
        AND ${t.conflictingProviderKeyHash} IS NULL
        AND (
          (${t.createAttemptedAt} IS NULL AND ${t.createOutcome} IS NULL)
          OR (${t.createAttemptedAt} IS NOT NULL AND ${t.createOutcome} = 'rate_limited')
        )
        AND ${t.revocationRequestedAt} IS NULL
        AND ${t.revokeOutcome} IS NULL
        AND ${t.revokedAt} IS NULL
        AND ${t.reconciliationRequiredAt} IS NULL
        AND ${t.leaseId} IS NULL
      )`,
    ),
  ],
);

/** Optional organization email choices. Transactional safety notices bypass these flags. */
export const organizationNotificationPreferences = pgTable(
  "organization_notification_preferences",
  {
    orgId: bigint("org_id", { mode: "number" })
      .primaryKey()
      .references(() => organizations.id, { onDelete: "cascade" }),
    billingSummaryEmail: boolean("billing_summary_email")
      .notNull()
      .default(true),
    serviceSummaryEmail: boolean("service_summary_email")
      .notNull()
      .default(true),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
);

/** Customer-facing organization events. Operator incidents use a separate store. */
export const customerNotificationEvents = pgTable(
  "customer_notification_events",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    orgId: bigint("org_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    severity: text("severity").notNull(),
    category: text("category").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    actionLabel: text("action_label"),
    actionHref: text("action_href"),
    visibility: text("visibility").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("customer_notification_events_org_key_idx").on(
      t.orgId,
      t.idempotencyKey,
    ),
    index("customer_notification_events_org_created_idx").on(
      t.orgId,
      t.createdAt,
      t.id,
    ),
    index("customer_notification_events_expiry_idx").on(t.expiresAt, t.id),
    check(
      "customer_notification_events_severity_check",
      sql`${t.severity} IN ('info', 'warning', 'critical')`,
    ),
    check(
      "customer_notification_events_category_check",
      sql`${t.category} IN ('trial', 'billing', 'service', 'security')`,
    ),
    check(
      "customer_notification_events_visibility_check",
      sql`${t.visibility} IN ('members', 'admins')`,
    ),
    check(
      "customer_notification_events_content_check",
      sql`length(btrim(${t.idempotencyKey})) BETWEEN 1 AND 200 AND length(btrim(${t.title})) BETWEEN 1 AND 120 AND length(btrim(${t.body})) BETWEEN 1 AND 500`,
    ),
    check(
      "customer_notification_events_action_check",
      sql`(${t.actionLabel} IS NULL AND ${t.actionHref} IS NULL) OR (${t.actionLabel} IS NOT NULL AND ${t.actionHref} IS NOT NULL AND length(btrim(${t.actionLabel})) BETWEEN 1 AND 60 AND ${t.actionHref} ~ '^/orgs/')`,
    ),
    check(
      "customer_notification_events_expiry_check",
      sql`${t.expiresAt} > ${t.createdAt}`,
    ),
  ],
);

/** Per-user read state keeps member and administrator inboxes independent. */
export const customerNotificationReads = pgTable(
  "customer_notification_reads",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    eventId: bigint("event_id", { mode: "number" })
      .notNull()
      .references(() => customerNotificationEvents.id, { onDelete: "cascade" }),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    readAt: timestamp("read_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("customer_notification_reads_event_user_idx").on(
      t.eventId,
      t.userId,
    ),
    index("customer_notification_reads_user_event_idx").on(t.userId, t.eventId),
  ],
);

/** Content-free audit and outbox state for customer notification email batches. */
export const customerNotificationEmailDeliveries = pgTable(
  "customer_notification_email_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: bigint("org_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    emailCategory: text("email_category").notNull(),
    eventCount: integer("event_count").notNull(),
    status: text("status").notNull().default("queued"),
    messageId: text("message_id"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("customer_notification_email_deliveries_status_created_idx").on(
      t.status,
      t.createdAt,
    ),
    index("customer_notification_email_deliveries_org_created_idx").on(
      t.orgId,
      t.createdAt,
    ),
    check(
      "customer_notification_email_deliveries_category_check",
      sql`${t.emailCategory} IN ('security', 'payment_failure', 'trial_expiry', 'service_incident', 'billing_summary')`,
    ),
    check(
      "customer_notification_email_deliveries_status_check",
      sql`${t.status} IN ('queued', 'retrying', 'sending', 'delivered', 'suppressed', 'failed')`,
    ),
    check(
      "customer_notification_email_deliveries_event_count_check",
      sql`${t.eventCount} BETWEEN 1 AND 20`,
    ),
  ],
);

/** One customer event belongs to at most one email delivery batch. */
export const customerNotificationEmailDeliveryEvents = pgTable(
  "customer_notification_email_delivery_events",
  {
    eventId: bigint("event_id", { mode: "number" }).primaryKey(),
    deliveryId: uuid("delivery_id")
      .notNull()
      .references(() => customerNotificationEmailDeliveries.id, {
        onDelete: "cascade",
      }),
  },
  (t) => [
    index("customer_notification_email_delivery_events_delivery_idx").on(
      t.deliveryId,
    ),
  ],
);

/**
 * One immutable trial grant per organization, keyed so a second attempt for the
 * same organization inserts nothing. The initiating identity is recorded for
 * attribution and future abuse controls, not as a limit.
 */
export const selfServiceTrialGrants = pgTable(
  "self_service_trial_grants",
  {
    orgId: bigint("org_id", { mode: "number" }).primaryKey(),
    initiatedByGithubId: bigint("initiated_by_github_id", {
      mode: "number",
    }).notNull(),
    requestedMode: text("requested_mode").notNull(),
    grantedMode: text("granted_mode").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("self_service_trial_grants_actor_created_idx").on(
      t.initiatedByGithubId,
      t.createdAt,
    ),
    check(
      "self_service_trial_grants_requested_mode_check",
      sql`${t.requestedMode} IN ('hosted', 'byok')`,
    ),
    check(
      "self_service_trial_grants_granted_mode_check",
      sql`${t.grantedMode} IN ('hosted', 'byok')`,
    ),
  ],
);

/** One server-created Paddle transaction per self-service checkout attempt. */
export const billingCheckoutTransactions = pgTable(
  "billing_checkout_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: bigint("org_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    requestedByUserId: bigint("requested_by_user_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    provider: text("provider").notNull().default("paddle"),
    providerTransactionId: text("provider_transaction_id"),
    checkoutUrl: text("checkout_url"),
    status: text("status").notNull().default("creating"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastErrorCategory: text("last_error_category"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("billing_checkout_transactions_provider_transaction_idx").on(
      t.providerTransactionId,
    ),
    uniqueIndex("billing_checkout_transactions_open_org_idx")
      .on(t.orgId)
      .where(sql`${t.status} IN ('creating', 'pending')`),
    index("billing_checkout_transactions_status_expiry_idx").on(
      t.status,
      t.expiresAt,
    ),
    check(
      "billing_checkout_transactions_provider_check",
      sql`${t.provider} = 'paddle'`,
    ),
    check(
      "billing_checkout_transactions_status_check",
      sql`${t.status} IN ('creating', 'pending', 'completed', 'failed', 'expired', 'canceled')`,
    ),
    check(
      "billing_checkout_transactions_provider_transaction_nonempty",
      sql`${t.providerTransactionId} IS NULL OR length(btrim(${t.providerTransactionId})) > 0`,
    ),
  ],
);

/** Minimal local projection of the provider subscription that grants access. */
export const billingProviderSubscriptions = pgTable(
  "billing_provider_subscriptions",
  {
    orgId: bigint("org_id", { mode: "number" })
      .primaryKey()
      .references(() => organizations.id, { onDelete: "cascade" }),
    provider: text("provider").notNull().default("paddle"),
    providerSubscriptionId: text("provider_subscription_id").notNull(),
    providerCustomerId: text("provider_customer_id").notNull(),
    status: text("status").notNull(),
    currentPeriodStartsAt: timestamp("current_period_starts_at", {
      withTimezone: true,
    }),
    currentPeriodEndsAt: timestamp("current_period_ends_at", {
      withTimezone: true,
    }),
    latestEventOccurredAt: timestamp("latest_event_occurred_at", {
      withTimezone: true,
    }).notNull(),
    latestEventId: text("latest_event_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("billing_provider_subscriptions_provider_id_idx").on(
      t.provider,
      t.providerSubscriptionId,
    ),
    index("billing_provider_subscriptions_status_period_idx").on(
      t.status,
      t.currentPeriodEndsAt,
    ),
    check(
      "billing_provider_subscriptions_provider_check",
      sql`${t.provider} = 'paddle'`,
    ),
    check(
      "billing_provider_subscriptions_status_check",
      sql`${t.status} IN ('active', 'trialing', 'past_due', 'paused', 'canceled')`,
    ),
    check(
      "billing_provider_subscriptions_provider_subscription_nonempty",
      sql`length(btrim(${t.providerSubscriptionId})) > 0`,
    ),
    check(
      "billing_provider_subscriptions_provider_customer_nonempty",
      sql`length(btrim(${t.providerCustomerId})) > 0`,
    ),
  ],
);

/** Content-free, idempotent receipt for each verified provider webhook. */
export const billingProviderEvents = pgTable(
  "billing_provider_events",
  {
    eventId: text("event_id").primaryKey(),
    provider: text("provider").notNull().default("paddle"),
    eventType: text("event_type").notNull(),
    providerObjectId: text("provider_object_id"),
    orgId: bigint("org_id", { mode: "number" }).references(
      () => organizations.id,
      {
        onDelete: "set null",
      },
    ),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    outcome: text("outcome").notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("billing_provider_events_org_occurred_idx").on(t.orgId, t.occurredAt),
    index("billing_provider_events_type_occurred_idx").on(
      t.eventType,
      t.occurredAt,
    ),
    check(
      "billing_provider_events_provider_check",
      sql`${t.provider} = 'paddle'`,
    ),
    check(
      "billing_provider_events_outcome_check",
      sql`${t.outcome} IN ('processing', 'applied', 'stale', 'ignored', 'unmatched')`,
    ),
    check(
      "billing_provider_events_event_type_nonempty",
      sql`length(btrim(${t.eventType})) > 0`,
    ),
  ],
);

/** One immutable active-author count and one provider charge per closed period. */
export const billingAuthorSettlements = pgTable(
  "billing_author_settlements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: bigint("org_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerSubscriptionId: text("provider_subscription_id").notNull(),
    periodStartsAt: timestamp("period_starts_at", {
      withTimezone: true,
    }).notNull(),
    periodEndsAt: timestamp("period_ends_at", {
      withTimezone: true,
    }).notNull(),
    activeAuthorCount: integer("active_author_count").notNull(),
    unitAmountCents: integer("unit_amount_cents").notNull().default(600),
    totalAmountCents: integer("total_amount_cents").notNull(),
    status: text("status").notNull().default("pending"),
    providerTransactionId: text("provider_transaction_id"),
    attemptCount: integer("attempt_count").notNull().default(0),
    attemptStartedAt: timestamp("attempt_started_at", { withTimezone: true }),
    nextReconcileAt: timestamp("next_reconcile_at", { withTimezone: true }),
    lastErrorCategory: text("last_error_category"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("billing_author_settlements_org_period_idx").on(
      t.orgId,
      t.periodStartsAt,
      t.periodEndsAt,
    ),
    uniqueIndex("billing_author_settlements_provider_transaction_idx").on(
      t.providerTransactionId,
    ),
    index("billing_author_settlements_status_reconcile_idx").on(
      t.status,
      t.nextReconcileAt,
    ),
    check(
      "billing_author_settlements_period_check",
      sql`${t.periodStartsAt} < ${t.periodEndsAt}`,
    ),
    check(
      "billing_author_settlements_author_count_check",
      sql`${t.activeAuthorCount} >= 0`,
    ),
    check(
      "billing_author_settlements_amount_check",
      sql`${t.unitAmountCents} = 600 AND ${t.totalAmountCents} = ${t.activeAuthorCount} * ${t.unitAmountCents}`,
    ),
    check(
      "billing_author_settlements_status_check",
      sql`${t.status} IN ('pending', 'charging', 'reconciling', 'charged', 'no_charge', 'failed')`,
    ),
    check(
      "billing_author_settlements_attempt_count_check",
      sql`${t.attemptCount} >= 0`,
    ),
    check(
      "billing_author_settlements_subscription_nonempty",
      sql`length(btrim(${t.providerSubscriptionId})) > 0`,
    ),
  ],
);

/** Durable, content-free audit state for email sent to the Postil operator. */
export const operatorAlertDeliveries = pgTable(
  "operator_alert_deliveries",
  {
    eventKey: text("event_key").primaryKey(),
    event: text("event").notNull(),
    orgId: bigint("org_id", { mode: "number" }).references(
      () => organizations.id,
      {
        onDelete: "set null",
      },
    ),
    githubInstallationId: bigint("github_installation_id", { mode: "number" }),
    status: text("status").notNull().default("queued"),
    messageId: text("message_id"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("operator_alert_deliveries_status_created_idx").on(
      t.status,
      t.createdAt,
    ),
    index("operator_alert_deliveries_org_created_idx").on(t.orgId, t.createdAt),
    check(
      "operator_alert_deliveries_event_check",
      sql`${t.event} IN ('trial_started', 'trial_expired', 'installation_removed', 'subscription_started', 'subscription_past_due', 'subscription_paused', 'subscription_canceled', 'billing_anomaly', 'finding_feedback_digest')`,
    ),
    check(
      "operator_alert_deliveries_status_check",
      sql`${t.status} IN ('queued', 'retrying', 'delivered', 'failed')`,
    ),
    check(
      "operator_alert_deliveries_event_key_nonempty",
      sql`length(btrim(${t.eventKey})) > 0`,
    ),
  ],
);

/** Append-only iLert alert events delivered to authenticated operators. */
export const ilertAlertEvents = pgTable(
  "ilert_alert_events",
  {
    sequence: bigint("sequence", { mode: "bigint" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    eventId: uuid("event_id").notNull(),
    alertId: text("alert_id").notNull(),
    alertKey: text("alert_key"),
    eventType: text("event_type").notNull(),
    status: text("status").notNull(),
    priority: text("priority").notNull(),
    summary: text("summary").notNull(),
    details: text("details").notNull(),
    alertSourceId: bigint("alert_source_id", { mode: "bigint" }).notNull(),
    alertSourceName: text("alert_source_name").notNull(),
    reportTime: timestamp("report_time", { withTimezone: true }).notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    payloadSha256: text("payload_sha256").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("ilert_alert_events_event_id_idx").on(t.eventId),
    index("ilert_alert_events_alert_sequence_idx").on(t.alertId, t.sequence),
    check(
      "ilert_alert_events_alert_id_check",
      sql`${t.alertId} ~ '^[1-9][0-9]{0,63}$'`,
    ),
    check(
      "ilert_alert_events_alert_key_check",
      sql`${t.alertKey} IS NULL OR length(${t.alertKey}) BETWEEN 1 AND 512`,
    ),
    check(
      "ilert_alert_events_event_type_check",
      sql`length(${t.eventType}) <= 64 AND ${t.eventType} ~ '^alert-[a-z]+(-[a-z]+)*$'`,
    ),
    check(
      "ilert_alert_events_status_check",
      sql`${t.status} IN ('PENDING', 'ACCEPTED', 'RESOLVED')`,
    ),
    check(
      "ilert_alert_events_priority_check",
      sql`${t.priority} IN ('HIGH', 'LOW')`,
    ),
    check(
      "ilert_alert_events_summary_check",
      sql`length(${t.summary}) BETWEEN 1 AND 512`,
    ),
    check(
      "ilert_alert_events_details_check",
      sql`length(${t.details}) BETWEEN 0 AND 8192`,
    ),
    check(
      "ilert_alert_events_source_name_check",
      sql`length(${t.alertSourceName}) BETWEEN 1 AND 256`,
    ),
    check(
      "ilert_alert_events_payload_sha256_check",
      sql`${t.payloadSha256} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

/** Atomic hosted-inference budget holds. Expired active rows no longer consume capacity. */
export const hostedUsageReservations = pgTable(
  "hosted_usage_reservations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: bigint("org_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    reviewId: bigint("review_id", { mode: "number" }).references(
      () => reviews.id,
      {
        onDelete: "cascade",
      },
    ),
    operation: text("operation").notNull().default("review"),
    reservedMicros: bigint("reserved_micros", { mode: "number" }).notNull(),
    actualMicros: bigint("actual_micros", { mode: "number" }),
    status: text("status").notNull().default("active"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("hosted_usage_reservations_review_idx").on(t.reviewId),
    index("hosted_usage_reservations_active_org_expiry_idx")
      .on(t.orgId, t.expiresAt)
      .where(sql`${t.status} = 'active'`),
    check(
      "hosted_usage_reservations_status_check",
      sql`${t.status} IN ('active', 'reconciled', 'released')`,
    ),
    check(
      "hosted_usage_reservations_operation_check",
      sql`${t.operation} IN ('review', 'respond', 'cli_gateway')`,
    ),
    check(
      "hosted_usage_reservations_operation_reference_check",
      sql`(${t.operation} = 'review' AND ${t.reviewId} IS NOT NULL) OR (${t.operation} IN ('respond', 'cli_gateway') AND ${t.reviewId} IS NULL)`,
    ),
    check(
      "hosted_usage_reservations_reserved_positive",
      sql`${t.reservedMicros} > 0`,
    ),
    check(
      "hosted_usage_reservations_actual_nonnegative",
      sql`${t.actualMicros} IS NULL OR ${t.actualMicros} >= 0`,
    ),
  ],
);

/** Durable webhook inbox keyed by X-GitHub-Delivery. */
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    deliveryId: text("delivery_id").primaryKey(),
    event: text("event").notNull(),
    action: text("action"),
    payload: jsonb("payload").$type<unknown>(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    index("webhook_deliveries_completed_at_idx")
      .on(t.completedAt)
      .where(sql`${t.completedAt} IS NOT NULL`),
    check(
      "webhook_deliveries_payload_completion_check",
      sql`(${t.payload} IS NULL) = (${t.completedAt} IS NOT NULL)`,
    ),
  ],
);

/** Payload-free observations and recovery receipts from GitHub's App delivery API. */
export const githubWebhookDeliveryRecoveries = pgTable(
  "github_webhook_delivery_recoveries",
  {
    deliveryId: text("delivery_id").primaryKey(),
    deliveryGuid: text("delivery_guid").notNull(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }).notNull(),
    event: text("event").notNull(),
    redelivery: boolean("redelivery").notNull(),
    outcome: text("outcome").notNull(),
    statusCode: integer("status_code"),
    observedAt: timestamp("observed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    requestState: text("request_state"),
    requestAttempts: integer("request_attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    lastRequestedAt: timestamp("last_requested_at", { withTimezone: true }),
    requestStatusCode: integer("request_status_code"),
    recoveryDeliveryId: text("recovery_delivery_id"),
    lastErrorCategory: text("last_error_category"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("github_webhook_delivery_recoveries_guid_idx").on(
      t.deliveryGuid,
      t.deliveredAt,
    ),
    index("github_webhook_delivery_recoveries_retry_idx")
      .on(t.nextAttemptAt, t.deliveredAt)
      .where(sql`${t.outcome} = 'failure' AND ${t.recoveryDeliveryId} IS NULL`),
    check(
      "github_webhook_delivery_recoveries_outcome_check",
      sql`${t.outcome} IN ('success', 'failure', 'pending')`,
    ),
    check(
      "github_webhook_delivery_recoveries_request_state_check",
      sql`${t.requestState} IS NULL OR ${t.requestState} IN ('requesting', 'retryable', 'accepted', 'terminal', 'exhausted', 'recovered')`,
    ),
    check(
      "github_webhook_delivery_recoveries_attempts_check",
      sql`${t.requestAttempts} >= 0 AND ${t.requestAttempts} <= 2`,
    ),
  ],
);

/** Singleton cursor and lease for bounded App delivery recovery sweeps. */
export const githubWebhookRedeliveryState = pgTable(
  "github_webhook_redelivery_state",
  {
    id: integer("id").primaryKey(),
    cursor: text("cursor"),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    sweepStartedAt: timestamp("sweep_started_at", { withTimezone: true }),
    lastPageAt: timestamp("last_page_at", { withTimezone: true }),
    lastSweepCompletedAt: timestamp("last_sweep_completed_at", {
      withTimezone: true,
    }),
    rateLimitedUntil: timestamp("rate_limited_until", { withTimezone: true }),
    lastErrorCategory: text("last_error_category"),
  },
  (t) => [
    check("github_webhook_redelivery_state_singleton_check", sql`${t.id} = 1`),
  ],
);

/** Durable receipts for idempotent non-transactional release operations. */
export const releaseSteps = pgTable("release_steps", {
  name: text("name").primaryKey(),
  completedAt: timestamp("completed_at", { withTimezone: true }).notNull(),
  details: jsonb("details").$type<Record<string, unknown>>().notNull(),
});

/** Private, low-cardinality liveness receipts for independent service processes. */
export const serviceHeartbeats = pgTable(
  "service_heartbeats",
  {
    component: text("component").primaryKey(),
    instanceId: text("instance_id").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "service_heartbeats_component_check",
      sql`${t.component} IN ('worker', 'monitor', 'monitor-heartbeat-delivery')`,
    ),
    check(
      "service_heartbeats_instance_nonempty",
      sql`length(btrim(${t.instanceId})) > 0`,
    ),
  ],
);

/** Singleton lease and latest-pass state for the private monitoring process. */
export const privateMonitorState = pgTable(
  "private_monitor_state",
  {
    id: integer("id").primaryKey(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    lastStartedAt: timestamp("last_started_at", { withTimezone: true }),
    lastCompletedAt: timestamp("last_completed_at", { withTimezone: true }),
    lastError: text("last_error"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [check("private_monitor_state_singleton_check", sql`${t.id} = 1`)],
);

/** Content-bounded private history for monitoring pass audit and diagnosis. */
export const privateMonitorRuns = pgTable(
  "private_monitor_runs",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
    owner: text("owner").notNull(),
    status: text("status").notNull(),
    checkCount: integer("check_count").notNull().default(0),
    failureCount: integer("failure_count").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    error: text("error"),
  },
  (t) => [
    uniqueIndex("private_monitor_runs_scheduled_idx").on(t.scheduledFor),
    index("private_monitor_runs_started_idx").on(t.startedAt),
    check(
      "private_monitor_runs_status_check",
      sql`${t.status} IN ('running', 'completed', 'failed')`,
    ),
    check(
      "private_monitor_runs_counts_check",
      sql`${t.checkCount} >= 0 AND ${t.failureCount} >= 0 AND ${t.failureCount} <= ${t.checkCount}`,
    ),
    check(
      "private_monitor_runs_owner_nonempty",
      sql`length(btrim(${t.owner})) > 0`,
    ),
  ],
);

/** Private incident state and a durable, retryable notification outbox. */
export const privateMonitorIncidents = pgTable(
  "private_monitor_incidents",
  {
    key: text("key").primaryKey(),
    group: text("group").notNull(),
    severity: text("severity").notNull(),
    summary: text("summary").notNull(),
    detail: text("detail").notNull(),
    state: text("state").notNull().default("open"),
    occurrenceCount: integer("occurrence_count").notNull().default(1),
    firstDetectedAt: timestamp("first_detected_at", {
      withTimezone: true,
    }).notNull(),
    lastDetectedAt: timestamp("last_detected_at", {
      withTimezone: true,
    }).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    pendingNotificationKey: text("pending_notification_key"),
    pendingNotificationKind: text("pending_notification_kind"),
    notificationAttempts: integer("notification_attempts").notNull().default(0),
    notificationAvailableAt: timestamp("notification_available_at", {
      withTimezone: true,
    }),
    notificationLeaseOwner: text("notification_lease_owner"),
    notificationLeaseExpiresAt: timestamp("notification_lease_expires_at", {
      withTimezone: true,
    }),
    lastNotifiedAt: timestamp("last_notified_at", { withTimezone: true }),
    lastNotificationError: text("last_notification_error"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("private_monitor_incidents_state_updated_idx").on(
      t.state,
      t.updatedAt,
    ),
    index("private_monitor_incidents_notification_idx")
      .on(t.notificationAvailableAt, t.notificationLeaseExpiresAt)
      .where(sql`${t.pendingNotificationKey} IS NOT NULL`),
    check(
      "private_monitor_incidents_state_check",
      sql`${t.state} IN ('open', 'resolved')`,
    ),
    check(
      "private_monitor_incidents_severity_check",
      sql`${t.severity} IN ('warning', 'critical')`,
    ),
    check(
      "private_monitor_incidents_notification_kind_check",
      sql`${t.pendingNotificationKind} IS NULL OR ${t.pendingNotificationKind} IN ('opened', 'reminder', 'resolved')`,
    ),
    check(
      "private_monitor_incidents_notification_pair_check",
      sql`(${t.pendingNotificationKey} IS NULL) = (${t.pendingNotificationKind} IS NULL)`,
    ),
    check(
      "private_monitor_incidents_occurrence_count_check",
      sql`${t.occurrenceCount} > 0 AND ${t.notificationAttempts} >= 0 AND ${t.notificationAttempts} <= 5`,
    ),
    check(
      "private_monitor_incidents_text_nonempty",
      sql`length(btrim(${t.key})) > 0 AND length(btrim(${t.group})) > 0 AND length(btrim(${t.summary})) > 0`,
    ),
  ],
);

export type JobPayload = Record<string, unknown>;

/** Postgres-native job queue, claimed with FOR UPDATE SKIP LOCKED. */
export const jobs = pgTable(
  "jobs",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    kind: text("kind").notNull(),
    payload: jsonb("payload").$type<JobPayload>().notNull(),
    status: jobStatus("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    runAfter: timestamp("run_after", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("jobs_claim_idx").on(t.status, t.runAfter),
    index("jobs_running_locked_at_idx")
      .on(t.lockedAt)
      .where(sql`${t.status} = 'running'`),
    index("jobs_running_org_concurrency_idx")
      .on(t.kind, sql`(${t.payload}->>'sourceOrgId')`)
      .where(sql`${t.status} = 'running'`),
  ],
);

/** Private one-shot audit record for a publication-recovery worker rehearsal. */
export const privateWorkerRehearsals = pgTable(
  "private_worker_rehearsals",
  {
    nonce: uuid("nonce").primaryKey(),
    state: text("state").notNull().default("armed"),
    operatorGithubId: bigint("operator_github_id", {
      mode: "number",
    }).notNull(),
    orgId: bigint("org_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    repositoryId: bigint("repository_id", { mode: "number" })
      .notNull()
      .references(() => repositories.id, { onDelete: "restrict" }),
    reviewId: bigint("review_id", { mode: "number" })
      .notNull()
      .references(() => reviews.id, { onDelete: "restrict" }),
    jobId: bigint("job_id", { mode: "number" })
      .notNull()
      .references(() => jobs.id, { onDelete: "restrict" }),
    orgSlug: text("org_slug").notNull(),
    repoFullName: text("repo_full_name").notNull(),
    prNumber: integer("pr_number").notNull(),
    headSha: text("head_sha").notNull(),
    reviewPublicId: uuid("review_public_id").notNull(),
    armedAt: timestamp("armed_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    interruptedWorkerInstance: text("interrupted_worker_instance"),
    replacementWorkerInstance: text("replacement_worker_instance"),
    replacementObservedAt: timestamp("replacement_observed_at", {
      withTimezone: true,
    }),
    beforeReviewCount: integer("before_review_count"),
    beforeUsageCount: integer("before_usage_count"),
    beforeCheckCount: integer("before_check_count"),
    beforePublicationCount: integer("before_publication_count"),
    afterReviewCount: integer("after_review_count"),
    afterUsageCount: integer("after_usage_count"),
    afterCheckCount: integer("after_check_count"),
    afterPublicationCount: integer("after_publication_count"),
    failureReason: text("failure_reason"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("private_worker_rehearsals_review_idx").on(t.reviewId),
    uniqueIndex("private_worker_rehearsals_job_idx").on(t.jobId),
    index("private_worker_rehearsals_state_idx").on(t.state, t.updatedAt),
    check(
      "private_worker_rehearsals_state_check",
      sql`${t.state} IN ('armed', 'awaiting_replacement', 'replacement_verified', 'completed', 'expired', 'failed')`,
    ),
    check(
      "private_worker_rehearsals_identity_check",
      sql`length(btrim(${t.orgSlug})) > 0 AND length(btrim(${t.repoFullName})) > 0 AND ${t.prNumber} > 0 AND ${t.headSha} ~ '^[0-9a-f]{40}$'`,
    ),
    check(
      "private_worker_rehearsals_arming_window_check",
      sql`${t.expiresAt} > ${t.armedAt} AND ${t.expiresAt} <= ${t.armedAt} + interval '10 minutes'`,
    ),
    check(
      "private_worker_rehearsals_before_counts_check",
      sql`(${t.beforeReviewCount} IS NULL AND ${t.beforeUsageCount} IS NULL AND ${t.beforeCheckCount} IS NULL AND ${t.beforePublicationCount} IS NULL) OR (${t.beforeReviewCount} >= 0 AND ${t.beforeUsageCount} >= 0 AND ${t.beforeCheckCount} >= 0 AND ${t.beforePublicationCount} >= 0)`,
    ),
    check(
      "private_worker_rehearsals_after_counts_check",
      sql`(${t.afterReviewCount} IS NULL AND ${t.afterUsageCount} IS NULL AND ${t.afterCheckCount} IS NULL AND ${t.afterPublicationCount} IS NULL) OR (${t.afterReviewCount} >= 0 AND ${t.afterUsageCount} >= 0 AND ${t.afterCheckCount} >= 0 AND ${t.afterPublicationCount} >= 0)`,
    ),
    check(
      "private_worker_rehearsals_replacement_pair_check",
      sql`(${t.replacementWorkerInstance} IS NULL) = (${t.replacementObservedAt} IS NULL)`,
    ),
    check(
      "private_worker_rehearsals_consumed_state_check",
      sql`(${t.state} IN ('armed', 'expired') AND ${t.consumedAt} IS NULL AND ${t.interruptedWorkerInstance} IS NULL AND ${t.beforeReviewCount} IS NULL) OR (${t.state} IN ('awaiting_replacement', 'replacement_verified', 'completed', 'failed') AND ${t.consumedAt} IS NOT NULL AND ${t.interruptedWorkerInstance} IS NOT NULL AND ${t.beforeReviewCount} IS NOT NULL)`,
    ),
    check(
      "private_worker_rehearsals_replacement_state_check",
      sql`(${t.state} IN ('armed', 'awaiting_replacement', 'expired') AND ${t.replacementWorkerInstance} IS NULL) OR (${t.state} IN ('replacement_verified', 'completed') AND ${t.replacementWorkerInstance} IS NOT NULL) OR ${t.state} = 'failed'`,
    ),
    check(
      "private_worker_rehearsals_completion_state_check",
      sql`(${t.state} = 'completed' AND ${t.afterReviewCount} IS NOT NULL AND ${t.completedAt} IS NOT NULL AND ${t.failureReason} IS NULL) OR (${t.state} IN ('expired', 'failed') AND ${t.afterReviewCount} IS NULL AND ${t.completedAt} IS NOT NULL AND ${t.failureReason} IS NOT NULL) OR (${t.state} IN ('armed', 'awaiting_replacement', 'replacement_verified') AND ${t.afterReviewCount} IS NULL AND ${t.completedAt} IS NULL AND ${t.failureReason} IS NULL)`,
    ),
  ],
);

/** Durable answer preparation and external-delivery state for respond jobs. */
export const respondDeliveries = pgTable(
  "respond_deliveries",
  {
    jobId: bigint("job_id", { mode: "number" })
      .primaryKey()
      .references(() => jobs.id, { onDelete: "cascade" }),
    repositoryId: bigint("repository_id", { mode: "number" })
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    reservationId: uuid("reservation_id").references(
      () => hostedUsageReservations.id,
      {
        onDelete: "set null",
      },
    ),
    sourceOrgId: bigint("source_org_id", { mode: "number" }),
    sourceInstallationId: bigint("source_installation_id", { mode: "number" }),
    sourceGithubInstallationId: bigint("source_github_installation_id", {
      mode: "number",
    }),
    sourceGithubRepoId: bigint("source_github_repo_id", { mode: "number" }),
    repoFullName: text("repo_full_name").notNull(),
    issueNumber: integer("issue_number").notNull(),
    isPr: boolean("is_pr").notNull().default(false),
    sourceHeadSha: text("source_head_sha"),
    markerNonce: uuid("marker_nonce"),
    replyToReviewCommentId: bigint("reply_to_review_comment_id", {
      mode: "number",
    }),
    publicationIdentityState: text("publication_identity_state")
      .notNull()
      .default("complete"),
    body: text("body").notNull(),
    state: text("state").notNull().default("prepared"),
    deliveryLeaseExpiresAt: timestamp("delivery_lease_expires_at", {
      withTimezone: true,
    }),
    githubCommentId: bigint("github_comment_id", { mode: "number" }),
    publicationLeaseId: uuid("publication_lease_id"),
    publicationLeaseExpiresAt: timestamp("publication_lease_expires_at", {
      withTimezone: true,
    }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("respond_deliveries_pending_idx").on(
      t.state,
      t.deliveryLeaseExpiresAt,
    ),
    check(
      "respond_deliveries_state_check",
      sql`${t.state} IN ('prepared', 'delivering', 'delivered', 'cancelled')`,
    ),
    check(
      "respond_deliveries_issue_number_positive",
      sql`${t.issueNumber} > 0`,
    ),
    check(
      "respond_deliveries_body_nonempty",
      sql`length(btrim(${t.body})) > 0`,
    ),
    check(
      "respond_deliveries_publication_identity_state_check",
      sql`${t.publicationIdentityState} IN ('complete', 'legacy_delivered', 'cancelled_incomplete')`,
    ),
    check(
      "respond_deliveries_publication_identity_check",
      sql`(
        ${t.sourceOrgId} IS NOT NULL
        AND ${t.sourceInstallationId} IS NOT NULL
        AND ${t.sourceGithubInstallationId} IS NOT NULL
        AND ${t.sourceGithubRepoId} IS NOT NULL
        AND (NOT ${t.isPr} OR ${t.sourceHeadSha} IS NOT NULL)
      )`,
    ),
    check(
      "respond_deliveries_publication_identity_state_matches_row_check",
      sql`(
        ${t.publicationIdentityState} = 'complete'
        OR (${t.publicationIdentityState} = 'legacy_delivered' AND ${t.state} = 'delivered')
        OR (${t.publicationIdentityState} = 'cancelled_incomplete' AND ${t.state} = 'cancelled')
      )`,
    ),
  ],
);

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  userId: bigint("user_id", { mode: "number" })
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  githubAccessTokenCiphertext: bytea("github_access_token_ciphertext"),
  membershipCheckedAt: timestamp("membership_checked_at", {
    withTimezone: true,
  }),
  membershipCheckAvailableAt: timestamp("membership_check_available_at", {
    withTimezone: true,
  }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Bearer credential `postil login` mints for the CLI gateway. Unlike
 * `sessions`, the secret is hashed at rest: this credential lives in a file on
 * developer machines and travels in Authorization headers, so the row must
 * stay useless to an attacker who only reads the database.
 */
export const cliTokens = pgTable(
  "cli_tokens",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    tokenSha256: bytea("token_sha256").notNull(),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    orgId: bigint("org_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    // Access tokens issued by older CLI versions deliberately leave this null.
    // Session-aware tokens use it so one logout can revoke their whole family.
    refreshSessionId: bigint("refresh_session_id", {
      mode: "number",
    }).references(() => cliRefreshSessions.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("cli_tokens_token_sha256_idx").on(t.tokenSha256),
    // Supports listing and bulk-revoking an organization's tokens newest
    // first. The gateway's hourly cap counts admitted requests in
    // `hosted_usage_reservations`, not logins, so it does not read this index.
    index("cli_tokens_org_created_idx").on(t.orgId, t.createdAt),
    index("cli_tokens_refresh_session_idx").on(t.refreshSessionId),
    check("cli_tokens_scope_check", sql`${t.scope} IN ('inference')`),
  ],
);

/**
 * A CLI login family. Its expiration is an inactivity deadline that advances
 * only when a refresh token is successfully rotated.
 */
export const cliRefreshSessions = pgTable(
  "cli_refresh_sessions",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    orgId: bigint("org_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    index("cli_refresh_sessions_expiry_idx").on(t.expiresAt),
    check(
      "cli_refresh_sessions_expiry_check",
      sql`${t.expiresAt} > ${t.createdAt}`,
    ),
  ],
);

/**
 * A one-time opaque refresh credential. Only its SHA-256 digest reaches the
 * database; `consumedAt` also makes reuse detectable without retaining raw
 * token material.
 */
export const cliRefreshTokens = pgTable(
  "cli_refresh_tokens",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    tokenSha256: bytea("token_sha256").notNull(),
    sessionId: bigint("session_id", { mode: "number" })
      .notNull()
      .references(() => cliRefreshSessions.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("cli_refresh_tokens_token_sha256_idx").on(t.tokenSha256),
    uniqueIndex("cli_refresh_tokens_current_session_idx")
      .on(t.sessionId)
      .where(sql`${t.consumedAt} IS NULL`),
    index("cli_refresh_tokens_session_idx").on(t.sessionId),
    check(
      "cli_refresh_tokens_expiry_check",
      sql`${t.expiresAt} > ${t.createdAt}`,
    ),
    check(
      "cli_refresh_tokens_consumed_after_created_check",
      sql`${t.consumedAt} IS NULL OR ${t.consumedAt} >= ${t.createdAt}`,
    ),
  ],
);

/**
 * RFC 8628-inspired device authorization used by `postil login`. The CLI
 * polls this row by device code while the operator approves or denies it in
 * the browser at `/cli/authorize`, so the flow works over SSH and in
 * containers where no localhost redirect is reachable.
 */
export const cliDeviceAuthorizations = pgTable(
  "cli_device_authorizations",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    deviceCodeSha256: bytea("device_code_sha256").notNull(),
    userCode: text("user_code").notNull(),
    status: text("status").notNull().default("pending"),
    userId: bigint("user_id", { mode: "number" }).references(() => users.id, {
      onDelete: "set null",
    }),
    orgId: bigint("org_id", { mode: "number" }).references(
      () => organizations.id,
      { onDelete: "set null" },
    ),
    tokenId: bigint("token_id", { mode: "number" }).references(
      () => cliTokens.id,
      { onDelete: "set null" },
    ),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    pollCount: integer("poll_count").notNull().default(0),
  },
  (t) => [
    uniqueIndex("cli_device_authorizations_device_code_sha256_idx").on(
      t.deviceCodeSha256,
    ),
    uniqueIndex("cli_device_authorizations_user_code_idx").on(t.userCode),
    check(
      "cli_device_authorizations_status_check",
      sql`${t.status} IN ('pending', 'approved', 'denied', 'claimed')`,
    ),
  ],
);

/** Per-org review configuration and write-only BYOK provider settings. */
export const orgSettings = pgTable("org_settings", {
  orgId: bigint("org_id", { mode: "number" })
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  apiBase: text("api_base"),
  apiKeyCiphertext: bytea("api_key_ciphertext"),
  apiFormat: text("api_format").notNull().default("openai-compatible"),
  apiAuthHeaderCiphertext: bytea("api_auth_header_ciphertext"),
  apiAuthValueCiphertext: bytea("api_auth_value_ciphertext"),
  model: text("model"),
  modelCascade: text("model_cascade"),
  configYaml: text("config_yaml"),
  guardrailsMd: text("guardrails_md"),
  contentPolicyMd: text("content_policy_md"),
  sharedConfigEnabled: boolean("shared_config_enabled").notNull().default(true),
  gateEnabled: boolean("gate_enabled").notNull().default(false),
  /** Retired compatibility columns; the post-deploy retirement clears every value. */
  escalationEmail: text("escalation_email"),
  escalationEmailPending: text("escalation_email_pending"),
  escalationEmailVerifiedAt: timestamp("escalation_email_verified_at", {
    withTimezone: true,
  }),
  escalationEmailVerificationTokenDigest: bytea(
    "escalation_email_verification_token_digest",
  ),
  escalationEmailVerificationTokenCiphertext: bytea(
    "escalation_email_verification_token_ciphertext",
  ),
  escalationEmailVerificationExpiresAt: timestamp(
    "escalation_email_verification_expires_at",
    { withTimezone: true },
  ),
  escalationEmailVerificationRequestedAt: timestamp(
    "escalation_email_verification_requested_at",
    { withTimezone: true },
  ),
  escalationEmailVerificationSentAt: timestamp(
    "escalation_email_verification_sent_at",
    { withTimezone: true },
  ),
  escalationEmailVerificationMessageId: text(
    "escalation_email_verification_message_id",
  ),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const organizationSettingEvents = pgTable(
  "organization_setting_events",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    orgId: bigint("org_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    setting: text("setting").notNull(),
    value: text("value").notNull(),
    actorUserId: bigint("actor_user_id", { mode: "number" }).references(
      () => users.id,
      { onDelete: "set null" },
    ),
    source: text("source").notNull().default("dashboard"),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("organization_setting_events_org_time_idx").on(
      t.orgId,
      t.occurredAt,
      t.id,
    ),
    check(
      "organization_setting_events_setting_check",
      sql`${t.setting} IN ('gate_enabled', 'billing_summary_email', 'service_summary_email')`,
    ),
    check(
      "organization_setting_events_value_check",
      sql`${t.value} IN ('enabled', 'disabled', 'advisory')`,
    ),
    check(
      "organization_setting_events_source_check",
      sql`${t.source} IN ('dashboard')`,
    ),
  ],
);

/** Last successful immutable snapshot of the owner's installed `.github` policy repo. */
export const orgConfigSnapshots = pgTable("org_config_snapshots", {
  orgId: bigint("org_id", { mode: "number" })
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  sourceRepositoryId: bigint("source_repository_id", {
    mode: "number",
  }).references(() => repositories.id, { onDelete: "set null" }),
  sourceGithubRepoId: bigint("source_github_repo_id", {
    mode: "number",
  }).notNull(),
  sourceFullName: text("source_full_name").notNull(),
  visibility: text("visibility").notNull(),
  defaultBranch: text("default_branch").notNull(),
  commitSha: text("commit_sha").notNull(),
  configYaml: text("config_yaml"),
  guardrailsMd: text("guardrails_md"),
  contentPolicyMd: text("content_policy_md"),
  files: text("files").array().notNull(),
  loadedFiles: text("loaded_files")
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  stale: boolean("stale").notNull().default(false),
  lastError: text("last_error"),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
