import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  integer,
  jsonb,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// Users authenticated via Better Auth (GitHub provider).
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull(),
  name: text("name"),
  image: text("image"),
  githubId: bigint("github_id", { mode: "number" }).unique(),
  githubLogin: text("github_login"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

// Organizations — either a GitHub user or a GitHub org.
export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    githubLogin: text("github_login"),
    githubInstallationId: bigint("github_installation_id", { mode: "number" }),
    polarCustomerId: text("polar_customer_id"),
    plan: text("plan").notNull().default("free"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("organizations_slug_idx").on(t.slug)],
);

// GitHub App installations.
export const installations = pgTable("installations", {
  id: bigint("id", { mode: "number" }).primaryKey(), // installation_id from GitHub
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  accountLogin: text("account_login").notNull(),
  accountType: text("account_type").notNull(), // "User" | "Organization"
  repositorySelection: text("repository_selection").notNull(), // "all" | "selected"
  suspended: boolean("suspended").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

// Review records — one per pull_request review invocation.
export const reviews = pgTable(
  "reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "set null",
    }),
    installationId: bigint("installation_id", { mode: "number" }).notNull(),
    repoFullName: text("repo_full_name").notNull(),
    pullNumber: integer("pull_number").notNull(),
    headSha: text("head_sha").notNull(),
    status: text("status").notNull().default("pending"), // pending|running|completed|failed
    checkRunId: bigint("check_run_id", { mode: "number" }),
    triggerRunId: text("trigger_run_id"),
    result: jsonb("result").$type<unknown>(),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("reviews_pr_sha_idx").on(t.repoFullName, t.pullNumber, t.headSha)],
);

// Usage metering for billing (Polar).
export const usageEvents = pgTable("usage_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  reviewId: uuid("review_id").references(() => reviews.id, { onDelete: "set null" }),
  kind: text("kind").notNull(), // "review_completed" | "tokens_consumed" | "sandbox_minutes"
  quantity: integer("quantity").notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  reportedToPolarAt: timestamp("reported_to_polar_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const reviewMetrics = pgTable(
  "review_metrics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reviewId: uuid("review_id").references(() => reviews.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "set null",
    }),
    installationId: bigint("installation_id", { mode: "number" }),
    repoFullName: text("repo_full_name").notNull(),
    pullNumber: integer("pull_number"),
    headSha: text("head_sha"),
    checkRunId: bigint("check_run_id", { mode: "number" }),
    triggerRunId: text("trigger_run_id"),
    workflowRunId: bigint("workflow_run_id", { mode: "number" }),
    triggerPath: text("trigger_path").notNull(),
    status: text("status").notNull(),
    conclusion: text("conclusion"),
    failureClass: text("failure_class"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    latencyMs: integer("latency_ms"),
    timeoutMs: integer("timeout_ms"),
    modelProvider: text("model_provider"),
    modelUsed: text("model_used"),
    modelCascade: text("model_cascade"),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    totalTokens: integer("total_tokens").notNull().default(0),
    cacheHit: boolean("cache_hit").notNull().default(false),
    fallbackUsed: boolean("fallback_used").notNull().default(false),
    cliVersion: text("cli_version"),
    actionVersion: text("action_version"),
    hostedAppVersion: text("hosted_app_version"),
    findingCount: integer("finding_count").notNull().default(0),
    errorFindingCount: integer("error_finding_count").notNull().default(0),
    warnFindingCount: integer("warn_finding_count").notNull().default(0),
    infoFindingCount: integer("info_finding_count").notNull().default(0),
    findingCategoryCounts: jsonb("finding_category_counts").$type<Record<string, number>>().notNull().default(sql`'{}'::jsonb`),
    inlineCommentCount: integer("inline_comment_count").notNull().default(0),
    postedCommentCount: integer("posted_comment_count").notNull().default(0),
    suppressedCleanComment: boolean("suppressed_clean_comment").notNull().default(false),
    reviewBodyLength: integer("review_body_length").notNull().default(0),
    reviewCommentLength: integer("review_comment_length").notNull().default(0),
    rerun: boolean("rerun").notNull().default(false),
    replay: boolean("replay").notNull().default(false),
    feedbackHelpful: boolean("feedback_helpful"),
    feedbackFalsePositive: boolean("feedback_false_positive"),
    feedbackMissedIssue: boolean("feedback_missed_issue"),
    feedbackDismissedFinding: boolean("feedback_dismissed_finding"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (t) => [
    uniqueIndex("review_metrics_review_id_idx").on(t.reviewId),
    index("review_metrics_recent_idx").on(t.createdAt),
    index("review_metrics_repo_pr_idx").on(t.repoFullName, t.pullNumber),
    index("review_metrics_status_idx").on(t.status, t.conclusion, t.failureClass),
  ],
);

// Webhook delivery log — used to dedupe on GitHub delivery id.
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    source: text("source").notNull(), // "github" | "polar"
    deliveryId: text("delivery_id").notNull(),
    event: text("event").notNull(),
    payload: jsonb("payload").$type<unknown>().notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("webhook_deliveries_src_id_idx").on(t.source, t.deliveryId)],
);

export const organizationsRelations = relations(organizations, ({ many }) => ({
  installations: many(installations),
  reviews: many(reviews),
  usageEvents: many(usageEvents),
}));

export const installationsRelations = relations(installations, ({ one }) => ({
  organization: one(organizations, {
    fields: [installations.organizationId],
    references: [organizations.id],
  }),
}));

export const reviewsRelations = relations(reviews, ({ one }) => ({
  organization: one(organizations, {
    fields: [reviews.organizationId],
    references: [organizations.id],
  }),
}));
