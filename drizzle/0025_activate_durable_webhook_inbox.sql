ALTER TABLE "webhook_deliveries" ALTER COLUMN "completed_at" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_payload_completion_check"
CHECK (("payload" IS NULL) = ("completed_at" IS NOT NULL));
--> statement-breakpoint
CREATE FUNCTION "suppress_duplicate_webhook_source_job"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  source_delivery_id text;
BEGIN
  IF NEW."kind" NOT IN ('review', 'respond', 'webhook-comment') THEN
    RETURN NEW;
  END IF;
  source_delivery_id := NEW."payload"->>'sourceDeliveryId';
  IF source_delivery_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Postil requires PostgreSQL 16; hashtextextended is a core PostgreSQL function.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('postil:webhook-source:' || NEW."kind" || ':' || source_delivery_id, 0)
  );
  IF EXISTS (
    SELECT 1
      FROM "jobs"
     WHERE "kind" = NEW."kind"
       AND "id" IS DISTINCT FROM NEW."id"
       AND "payload"->>'sourceDeliveryId' = source_delivery_id
  ) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "jobs_suppress_duplicate_webhook_source_trigger"
BEFORE INSERT OR UPDATE OF "kind", "payload" ON "jobs"
FOR EACH ROW EXECUTE FUNCTION "suppress_duplicate_webhook_source_job"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "stage_unactivated_release_job"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."kind" IN (
    'escalation-email-verification',
    'billing-contact-verification',
    'respond-delivery',
    'webhook-comment'
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
