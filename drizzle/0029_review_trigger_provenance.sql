ALTER TABLE "reviews" ADD COLUMN "trigger_source" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "trigger_context" jsonb;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "trigger_source" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_trigger_source_check" CHECK ("reviews"."trigger_source" IN ('unknown', 'automatic_pull_request', 'requested_review', 'github_check_rerun')) NOT VALID;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_trigger_context_check" CHECK (
  ("reviews"."trigger_source" = 'unknown' AND ("reviews"."trigger_context" IS NULL OR "reviews"."trigger_context" = '{"source":"unknown"}'::jsonb))
  OR (
    "reviews"."trigger_source" <> 'unknown'
    AND "reviews"."trigger_context" IS NOT NULL
    AND jsonb_typeof("reviews"."trigger_context") = 'object'
    AND "reviews"."trigger_context" - ARRAY['source', 'webhookDeliveryId', 'webhookEvent', 'webhookAction', 'sourceCommentId', 'sourceUrl', 'requestedByGithubId', 'requestedByLogin', 'checkName']::text[] = '{}'::jsonb
    AND "reviews"."trigger_context"->>'source' = "reviews"."trigger_source"
    AND jsonb_typeof("reviews"."trigger_context"->'webhookDeliveryId') = 'string'
    AND COALESCE(length(btrim("reviews"."trigger_context"->>'webhookDeliveryId')), 0) > 0
    AND length("reviews"."trigger_context"->>'webhookDeliveryId') <= 200
    AND (
      ("reviews"."trigger_source" = 'automatic_pull_request' AND "reviews"."trigger_context"->>'webhookEvent' = 'pull_request')
      OR ("reviews"."trigger_source" = 'requested_review' AND "reviews"."trigger_context"->>'webhookEvent' IN ('issue_comment', 'pull_request_review_comment'))
      OR ("reviews"."trigger_source" = 'github_check_rerun' AND "reviews"."trigger_context"->>'webhookEvent' IN ('check_run', 'check_suite'))
    )
    AND (NOT "reviews"."trigger_context" ? 'webhookAction' OR (jsonb_typeof("reviews"."trigger_context"->'webhookAction') = 'string' AND length("reviews"."trigger_context"->>'webhookAction') <= 100))
    AND (NOT "reviews"."trigger_context" ? 'sourceCommentId' OR (jsonb_typeof("reviews"."trigger_context"->'sourceCommentId') = 'number' AND ("reviews"."trigger_context"->>'sourceCommentId')::numeric = trunc(("reviews"."trigger_context"->>'sourceCommentId')::numeric) AND ("reviews"."trigger_context"->>'sourceCommentId')::numeric BETWEEN 1 AND 9007199254740991))
    AND (NOT "reviews"."trigger_context" ? 'sourceUrl' OR (jsonb_typeof("reviews"."trigger_context"->'sourceUrl') = 'string' AND length("reviews"."trigger_context"->>'sourceUrl') <= 2048 AND "reviews"."trigger_context"->>'sourceUrl' ~* '^https://github[.]com([/?#]|$)'))
    AND (NOT "reviews"."trigger_context" ? 'requestedByGithubId' OR (jsonb_typeof("reviews"."trigger_context"->'requestedByGithubId') = 'number' AND ("reviews"."trigger_context"->>'requestedByGithubId')::numeric = trunc(("reviews"."trigger_context"->>'requestedByGithubId')::numeric) AND ("reviews"."trigger_context"->>'requestedByGithubId')::numeric BETWEEN 1 AND 9007199254740991))
    AND (NOT "reviews"."trigger_context" ? 'requestedByLogin' OR (jsonb_typeof("reviews"."trigger_context"->'requestedByLogin') = 'string' AND length("reviews"."trigger_context"->>'requestedByLogin') <= 100))
    AND (NOT "reviews"."trigger_context" ? 'checkName' OR (jsonb_typeof("reviews"."trigger_context"->'checkName') = 'string' AND length("reviews"."trigger_context"->>'checkName') <= 200))
  )
) NOT VALID;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_trigger_source_check" CHECK ("usage_events"."trigger_source" IN ('unknown', 'automatic_pull_request', 'requested_review', 'github_check_rerun', 'github_mention')) NOT VALID;--> statement-breakpoint
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
