ALTER TABLE "usage_events" ADD COLUMN "billing_scope" text DEFAULT 'analytics' NOT NULL;

ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_billing_scope_check"
  CHECK ("billing_scope" IN ('analytics', 'private_hosted'));

-- Existing rows remain analytics-only. Historical visibility and provider
-- mode are not immutable on those rows, so billing them during backfill could
-- consume allowance without durable proof that they were private hosted work.

CREATE TABLE "respond_deliveries" (
  "job_id" bigint PRIMARY KEY REFERENCES "jobs"("id") ON DELETE CASCADE,
  "repository_id" bigint NOT NULL REFERENCES "repositories"("id") ON DELETE CASCADE,
  "reservation_id" uuid REFERENCES "hosted_usage_reservations"("id") ON DELETE SET NULL,
  "repo_full_name" text NOT NULL,
  "issue_number" integer NOT NULL,
  "body" text NOT NULL,
  "state" text DEFAULT 'prepared' NOT NULL,
  "delivery_lease_expires_at" timestamp with time zone,
  "github_comment_id" bigint,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "delivered_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "respond_deliveries_state_check" CHECK ("state" IN ('prepared', 'delivering', 'delivered')),
  CONSTRAINT "respond_deliveries_issue_number_positive" CHECK ("issue_number" > 0),
  CONSTRAINT "respond_deliveries_body_nonempty" CHECK (length(btrim("body")) > 0)
);

CREATE INDEX "respond_deliveries_pending_idx"
  ON "respond_deliveries" ("state", "delivery_lease_expires_at");
