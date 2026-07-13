ALTER TABLE "usage_events" ADD COLUMN "billing_scope" text;

-- Preserve historical rows as analytics-only. For inserts made after this
-- migration, an omitted scope identifies a pre-0020 writer. Classify that
-- writer from the durable repository visibility and the same stored-key test
-- the pre-0020 worker uses for provider selection
-- instead of letting a default silently turn private hosted spend into
-- analytics during a rolling deployment.
UPDATE "usage_events" SET "billing_scope" = 'analytics';

CREATE FUNCTION "classify_legacy_usage_event_scope"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."billing_scope" IS NULL THEN
    SELECT CASE
      WHEN repository."private"
        AND setting."api_key_ciphertext" IS NULL
        THEN 'private_hosted'
      ELSE 'analytics'
    END
    INTO NEW."billing_scope"
    FROM "repositories" repository
    LEFT JOIN "org_settings" setting
      ON setting."org_id" = NEW."org_id"
    WHERE repository."id" = NEW."repository_id";

    NEW."billing_scope" := COALESCE(NEW."billing_scope", 'analytics');
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "usage_events_legacy_scope_trigger"
  BEFORE INSERT ON "usage_events"
  FOR EACH ROW EXECUTE FUNCTION "classify_legacy_usage_event_scope"();

ALTER TABLE "usage_events" ALTER COLUMN "billing_scope" SET NOT NULL;

ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_billing_scope_check"
  CHECK ("billing_scope" IN ('analytics', 'private_hosted'));

-- These job kinds are introduced by this release. New web machines can
-- accept settings changes while old workers remain alive in a rolling deploy,
-- so capability-filtered new workers alone are insufficient. Hold these jobs
-- at infinity until the deploy workflow has replaced the fleet and explicitly
-- activates the capability. The transaction advisory lock closes the race
-- between an insert and activation's release UPDATE.
CREATE TABLE "deployment_capabilities" (
  "name" text PRIMARY KEY,
  "activated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE FUNCTION "stage_unactivated_release_job"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."kind" IN (
    'escalation-email-verification',
    'billing-contact-verification',
    'respond-delivery'
  ) THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('postil:release-v1-jobs', 0));
    IF NOT EXISTS (
      SELECT 1 FROM "deployment_capabilities"
      WHERE "name" = 'release-v1-jobs'
    ) THEN
      NEW."run_after" := 'infinity'::timestamptz;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "jobs_stage_unactivated_release_trigger"
  BEFORE INSERT ON "jobs"
  FOR EACH ROW EXECUTE FUNCTION "stage_unactivated_release_job"();

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
