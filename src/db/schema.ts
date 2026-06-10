/**
 * Drizzle schema for Postil. One source of truth for shape.
 *
 * Domain entities:
 *   - users / sessions / accounts (Better Auth, Drizzle adapter)
 *   - organizations / installations (GitHub-side identity)
 *   - reviews (one row per repo+pr+sha)
 *   - review_findings (denormalised — preserved across re-reviews so we can
 *     measure "incremental re-review" without rebuilding from raw envelopes)
 *   - usage_events (Polar metering)
 *   - webhook_deliveries (dedupe + audit)
 *   - silence_metrics (the "we said nothing on X% of PRs" wedge)
 *   - jobs (in-process Postgres-backed job queue; replaces Trigger.dev)
 */

import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

// ---- Better Auth tables ----------------------------------------------------

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  name: text("name"),
  image: text("image"),
  githubId: bigint("github_id", { mode: "number" }).unique(),
  githubLogin: text("github_login"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const accounts = pgTable("accounts", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  providerId: text("provider_id").notNull(),
  accountId: text("account_id").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  idToken: text("id_token"),
  password: text("password"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const verifications = pgTable("verifications", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---- Postil domain ---------------------------------------------------------

export const planEnum = pgEnum("plan", ["free", "starter", "team", "enterprise"]);

export const organizations = pgTable(
  "organizations",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    githubLogin: text("github_login").notNull(),
    githubInstallationId: bigint("github_installation_id", { mode: "number" }),
    polarCustomerId: text("polar_customer_id"),
    plan: planEnum("plan").notNull().default("free"),
    settings: jsonb("settings").$type<OrgSettings>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_org_installation").on(t.githubInstallationId)],
);

export type OrgSettings = {
  defaultModel?: string;
  modelCascade?: string;
  useByoKey?: boolean;
};

export const orgMembers = pgTable(
  "org_members",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("uniq_org_member").on(t.organizationId, t.userId)],
);

export const installations = pgTable("installations", {
  id: bigint("id", { mode: "number" }).primaryKey(),
  organizationId: text("organization_id").references(() => organizations.id, {
    onDelete: "set null",
  }),
  accountLogin: text("account_login").notNull(),
  accountType: text("account_type").notNull(), // 'User' | 'Organization'
  repositorySelection: text("repository_selection").notNull(), // 'all' | 'selected'
  suspended: boolean("suspended").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const reviewStatusEnum = pgEnum("review_status", [
  "pending",
  "running",
  "completed",
  "failed",
]);

export const reviews = pgTable(
  "reviews",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").references(() => organizations.id, {
      onDelete: "set null",
    }),
    repoFullName: text("repo_full_name").notNull(),
    pullNumber: integer("pull_number").notNull(),
    headSha: text("head_sha").notNull(),
    status: reviewStatusEnum("status").notNull().default("pending"),
    checkRunId: bigint("check_run_id", { mode: "number" }),
    jobId: text("job_id"),
    /** Envelope as written by `postil review --output-json`. */
    result: jsonb("result").$type<ReviewResult>(),
    errorMessage: text("error_message"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("uniq_review_repo_pr_sha").on(t.repoFullName, t.pullNumber, t.headSha),
    index("idx_review_status").on(t.status),
    index("idx_review_org").on(t.organizationId),
  ],
);

export type ReviewResult = {
  summary: string;
  findings: Array<{
    path: string;
    line: number;
    severity: "info" | "warn" | "error";
    kind?: "risk" | "humanEscalation" | "guardrail" | "uncertainty";
    body: string;
  }>;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  modelUsed?: string;
  cliVersion?: string;
};

export const usageEventKindEnum = pgEnum("usage_event_kind", [
  "review_completed",
  "tokens_consumed",
  "review_silent", // for the silence-rate dashboard wedge
]);

export const usageEvents = pgTable(
  "usage_events",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    reviewId: text("review_id").references(() => reviews.id, { onDelete: "set null" }),
    kind: usageEventKindEnum("kind").notNull(),
    quantity: bigint("quantity", { mode: "number" }).notNull().default(1),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    reportedToPolarAt: timestamp("reported_to_polar_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_usage_org_kind").on(t.organizationId, t.kind)],
);

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: text("id").primaryKey(),
    source: text("source").notNull(), // 'github' | 'polar'
    deliveryId: text("delivery_id").notNull(),
    event: text("event").notNull(),
    payload: jsonb("payload"),
    processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("uniq_webhook_delivery").on(t.source, t.deliveryId)],
);

// ---- Job queue (replaces Trigger.dev) --------------------------------------

export const jobStatusEnum = pgEnum("job_status", [
  "queued",
  "running",
  "completed",
  "failed",
  "dead",
]);

export const jobs = pgTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(), // 'review' | 'auto_merge'
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: jobStatusEnum("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_jobs_pickup").on(t.status, t.runAt),
    uniqueIndex("uniq_jobs_dedupe").on(t.kind, t.id),
  ],
);
