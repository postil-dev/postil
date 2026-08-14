SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "reconciliation_deadline_at" timestamp with time zone;

-- The partial unique index in the schema snapshot is installed concurrently
-- by the idempotent operational-index release step.
