import {
  bigint,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
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

export const reviews = pgTable(
  "reviews",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    repositoryId: bigint("repository_id", { mode: "number" })
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    prNumber: integer("pr_number").notNull(),
    headSha: text("head_sha").notNull(),
    baseSha: text("base_sha").notNull(),
    sinceSha: text("since_sha"),
    status: reviewStatus("status").notNull().default("queued"),
    envelope: jsonb("envelope").$type<Envelope>(),
    silent: boolean("silent"),
    gateFailing: boolean("gate_failing"),
    errorMessage: text("error_message"),
    advisoryCheckRunId: bigint("advisory_check_run_id", { mode: "number" }),
    gateCheckRunId: bigint("gate_check_run_id", { mode: "number" }),
    queuedAt: timestamp("queued_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("reviews_repo_pr_idx").on(t.repositoryId, t.prNumber),
    index("reviews_status_idx").on(t.status),
  ],
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

/** Per-org BYO LLM settings. The API key is sealed with AES-256-GCM and never read back out via the UI. */
export const orgSettings = pgTable("org_settings", {
  orgId: bigint("org_id", { mode: "number" })
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  apiBase: text("api_base"),
  apiKeyCiphertext: bytea("api_key_ciphertext"),
  model: text("model"),
  modelCascade: text("model_cascade"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
