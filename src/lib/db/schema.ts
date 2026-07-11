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

export const usageEvents = pgTable("usage_events", {
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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

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
  (t) => [index("jobs_claim_idx").on(t.status, t.runAfter)],
);

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  userId: bigint("user_id", { mode: "number" })
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Per-org hosted review configuration and BYO LLM settings. */
export const orgSettings = pgTable("org_settings", {
  orgId: bigint("org_id", { mode: "number" })
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  apiBase: text("api_base"),
  apiKeyCiphertext: bytea("api_key_ciphertext"),
  model: text("model"),
  modelCascade: text("model_cascade"),
  configYaml: text("config_yaml"),
  guardrailsMd: text("guardrails_md"),
  contentPolicyMd: text("content_policy_md"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
