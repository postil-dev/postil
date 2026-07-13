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
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import type { Envelope } from "@/lib/envelope";

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

export const findingApprovalRole = pgEnum("finding_approval_role", ["member", "admin"]);
export const findingApprovalSource = pgEnum("finding_approval_source", [
  "github",
  "dashboard",
]);

export const users = pgTable("users", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  githubId: bigint("github_id", { mode: "number" }).notNull().unique(),
  login: text("login").notNull(),
  name: text("name"),
  email: text("email"),
  avatarUrl: text("avatar_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const organizations = pgTable(
  "organizations",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    githubOrgId: bigint("github_org_id", { mode: "number" }),
    plan: text("plan").notNull().default("beta"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
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
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
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
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    githubInstallationId: bigint("github_installation_id", { mode: "number" })
      .notNull()
      .unique(),
    orgId: bigint("org_id", { mode: "number" }).references(() => organizations.id, {
      onDelete: "set null",
    }),
    accountLogin: text("account_login").notNull(),
    accountType: text("account_type").notNull(),
    suspended: boolean("suspended").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

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
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
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
    actorUserId: bigint("actor_user_id", { mode: "number" }).references(() => users.id, {
      onDelete: "set null",
    }),
    source: text("source").notNull().default("dashboard"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("repository_enablement_events_org_time_idx").on(t.orgId, t.occurredAt, t.id),
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
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    publicId: uuid("public_id").notNull().defaultRandom(),
    repositoryId: bigint("repository_id", { mode: "number" })
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    prNumber: integer("pr_number").notNull(),
    authorGithubId: bigint("author_github_id", { mode: "number" }),
    authorLogin: text("author_login"),
    headSha: text("head_sha").notNull(),
    baseSha: text("base_sha").notNull(),
    sinceSha: text("since_sha"),
    status: reviewStatus("status").notNull().default("queued"),
    envelope: jsonb("envelope").$type<Envelope>(),
    configFiles: text("config_files").array(),
    silent: boolean("silent"),
    engineGateFailing: boolean("engine_gate_failing"),
    gateFailing: boolean("gate_failing"),
    errorMessage: text("error_message"),
    advisoryCheckRunId: bigint("advisory_check_run_id", { mode: "number" }),
    gateCheckRunId: bigint("gate_check_run_id", { mode: "number" }),
    queuedAt: timestamp("queued_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("reviews_public_id_idx").on(t.publicId),
    index("reviews_repo_pr_idx").on(t.repositoryId, t.prNumber),
    index("reviews_status_idx").on(t.status),
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
    rationale: text("rationale").notNull(),
    source: findingApprovalSource("source").notNull(),
    sourceCommentId: uuid("source_comment_id"),
    sourceUrl: text("source_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedByUserId: bigint("revoked_by_user_id", { mode: "number" }).references(
      () => users.id,
      { onDelete: "set null" },
    ),
  },
  (t) => [
    uniqueIndex("finding_approvals_active_idx")
      .on(t.reviewId, t.findingId)
      .where(sql`${t.revokedAt} IS NULL`),
    index("finding_approvals_review_idx").on(t.reviewId),
    check("finding_approvals_rationale_nonempty", sql`length(btrim(${t.rationale})) > 0`),
  ],
);

export const reviewLogs = pgTable(
  "review_logs",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
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
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    orgId: bigint("org_id", { mode: "number" }).references(() => organizations.id, {
      onDelete: "set null",
    }),
    repositoryId: bigint("repository_id", { mode: "number" }).references(
      () => repositories.id,
      { onDelete: "set null" },
    ),
    reviewId: bigint("review_id", { mode: "number" }).references(() => reviews.id, {
      onDelete: "set null",
    }),
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
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
  ],
);

export const billingCreditGrants = pgTable(
  "billing_credit_grants",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    orgId: bigint("org_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    amountCents: integer("amount_cents").notNull(),
    reason: text("reason").notNull(),
    actor: text("actor").notNull(),
    source: text("source").notNull().default("admin_script"),
    idempotencyKey: text("idempotency_key").notNull(),
    appliesAt: timestamp("applies_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("billing_credit_grants_org_created_idx").on(t.orgId, t.createdAt, t.id),
    uniqueIndex("billing_credit_grants_org_idempotency_idx").on(
      t.orgId,
      t.idempotencyKey,
    ),
    check("billing_credit_grants_amount_cents_positive", sql`${t.amountCents} > 0`),
    check("billing_credit_grants_reason_nonempty", sql`length(btrim(${t.reason})) > 0`),
    check("billing_credit_grants_actor_nonempty", sql`length(btrim(${t.actor})) > 0`),
    check("billing_credit_grants_source_nonempty", sql`length(btrim(${t.source})) > 0`),
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
    pastDueGraceEndsAt: timestamp("past_due_grace_ends_at", { withTimezone: true }),
    periodStartsAt: timestamp("period_starts_at", { withTimezone: true }),
    periodEndsAt: timestamp("period_ends_at", { withTimezone: true }),
    /** Allowance and cap use USD micros so sub-cent model calls remain exact. */
    includedUsageMicros: bigint("included_usage_micros", { mode: "number" })
      .notNull()
      .default(0),
    overageHardCapMicros: bigint("overage_hard_cap_micros", { mode: "number" }).default(0),
    /** Rolling-deploy compatibility; new entitlement checks read the micros fields. */
    includedUsageCents: integer("included_usage_cents").notNull().default(0),
    overageHardCapCents: integer("overage_hard_cap_cents").default(0),
    billingContactEmail: text("billing_contact_email"),
    billingContactVerifiedAt: timestamp("billing_contact_verified_at", {
      withTimezone: true,
    }),
    billingContactPending: text("billing_contact_pending"),
    billingContactVerificationTokenDigest: bytea("billing_contact_verification_token_digest"),
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
    billingContactVerificationSentAt: timestamp("billing_contact_verification_sent_at", {
      withTimezone: true,
    }),
    billingContactVerificationMessageId: text("billing_contact_verification_message_id"),
    promotionalEligible: boolean("promotional_eligible").notNull().default(false),
    promotionalEndsAt: timestamp("promotional_ends_at", { withTimezone: true }),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
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

/** Atomic hosted-inference budget holds. Expired active rows no longer consume capacity. */
export const hostedUsageReservations = pgTable(
  "hosted_usage_reservations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: bigint("org_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    reviewId: bigint("review_id", { mode: "number" }).references(() => reviews.id, {
      onDelete: "cascade",
    }),
    operation: text("operation").notNull().default("review"),
    reservedMicros: bigint("reserved_micros", { mode: "number" }).notNull(),
    actualMicros: bigint("actual_micros", { mode: "number" }),
    status: text("status").notNull().default("active"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
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
      sql`${t.operation} IN ('review', 'respond')`,
    ),
    check(
      "hosted_usage_reservations_operation_reference_check",
      sql`(${t.operation} = 'review' AND ${t.reviewId} IS NOT NULL) OR (${t.operation} = 'respond' AND ${t.reviewId} IS NULL)`,
    ),
    check("hosted_usage_reservations_reserved_positive", sql`${t.reservedMicros} > 0`),
    check(
      "hosted_usage_reservations_actual_nonnegative",
      sql`${t.actualMicros} IS NULL OR ${t.actualMicros} >= 0`,
    ),
  ],
);

/** Webhook delivery dedupe: insert-or-skip keyed by X-GitHub-Delivery. */
export const webhookDeliveries = pgTable("webhook_deliveries", {
  deliveryId: text("delivery_id").primaryKey(),
  event: text("event").notNull(),
  action: text("action"),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
});

export type JobPayload = Record<string, unknown>;

/** Postgres-native job queue, claimed with FOR UPDATE SKIP LOCKED. */
export const jobs = pgTable(
  "jobs",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    kind: text("kind").notNull(),
    payload: jsonb("payload").$type<JobPayload>().notNull(),
    status: jobStatus("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("jobs_claim_idx").on(t.status, t.runAfter),
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
    reservationId: uuid("reservation_id").references(() => hostedUsageReservations.id, {
      onDelete: "set null",
    }),
    repoFullName: text("repo_full_name").notNull(),
    issueNumber: integer("issue_number").notNull(),
    body: text("body").notNull(),
    state: text("state").notNull().default("prepared"),
    deliveryLeaseExpiresAt: timestamp("delivery_lease_expires_at", { withTimezone: true }),
    githubCommentId: bigint("github_comment_id", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("respond_deliveries_pending_idx").on(t.state, t.deliveryLeaseExpiresAt),
    check(
      "respond_deliveries_state_check",
      sql`${t.state} IN ('prepared', 'delivering', 'delivered')`,
    ),
    check("respond_deliveries_issue_number_positive", sql`${t.issueNumber} > 0`),
    check("respond_deliveries_body_nonempty", sql`length(btrim(${t.body})) > 0`),
  ],
);

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  userId: bigint("user_id", { mode: "number" })
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

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
  /** Active only after possession of this address is verified. */
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
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
