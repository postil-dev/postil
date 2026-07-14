ALTER TABLE "reviews" ADD COLUMN "trigger_source" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "trigger_context" jsonb;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "trigger_source" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_trigger_source_check" CHECK ("reviews"."trigger_source" IN ('unknown', 'automatic_pull_request', 'requested_review', 'github_check_rerun'));--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_trigger_context_check" CHECK (("reviews"."trigger_source" = 'unknown' AND ("reviews"."trigger_context" IS NULL OR "reviews"."trigger_context"->>'source' = 'unknown')) OR ("reviews"."trigger_source" <> 'unknown' AND "reviews"."trigger_context" IS NOT NULL AND jsonb_typeof("reviews"."trigger_context") = 'object' AND "reviews"."trigger_context"->>'source' = "reviews"."trigger_source" AND COALESCE(length(btrim("reviews"."trigger_context"->>'webhookDeliveryId')), 0) > 0));--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_trigger_source_check" CHECK ("usage_events"."trigger_source" IN ('unknown', 'automatic_pull_request', 'requested_review', 'github_check_rerun', 'github_mention'));--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_review_trigger_provenance_update() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.trigger_source IS DISTINCT FROM OLD.trigger_source
     OR NEW.trigger_context IS DISTINCT FROM OLD.trigger_context THEN
    RAISE EXCEPTION 'review trigger provenance is immutable';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER reviews_trigger_provenance_immutable
BEFORE UPDATE OF trigger_source, trigger_context ON reviews
FOR EACH ROW EXECUTE FUNCTION reject_review_trigger_provenance_update();
