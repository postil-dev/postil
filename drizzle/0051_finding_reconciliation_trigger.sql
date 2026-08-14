SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "reviews" DROP CONSTRAINT "reviews_trigger_source_check";--> statement-breakpoint
ALTER TABLE "reviews" DROP CONSTRAINT "reviews_trigger_context_check";--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_trigger_source_check" CHECK ("reviews"."trigger_source" IN ('unknown', 'automatic_pull_request', 'requested_review', 'github_check_rerun', 'finding_reconciliation')) NOT VALID;--> statement-breakpoint
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
      OR ("reviews"."trigger_source" = 'finding_reconciliation' AND "reviews"."trigger_context"->>'webhookEvent' IN ('pull_request_review_comment', 'pull_request_review_thread'))
    )
    AND (NOT "reviews"."trigger_context" ? 'webhookAction' OR (jsonb_typeof("reviews"."trigger_context"->'webhookAction') = 'string' AND length("reviews"."trigger_context"->>'webhookAction') <= 100))
    AND (NOT "reviews"."trigger_context" ? 'sourceCommentId' OR (jsonb_typeof("reviews"."trigger_context"->'sourceCommentId') = 'number' AND ("reviews"."trigger_context"->>'sourceCommentId')::numeric = trunc(("reviews"."trigger_context"->>'sourceCommentId')::numeric) AND ("reviews"."trigger_context"->>'sourceCommentId')::numeric BETWEEN 1 AND 9007199254740991))
    AND (NOT "reviews"."trigger_context" ? 'sourceUrl' OR (jsonb_typeof("reviews"."trigger_context"->'sourceUrl') = 'string' AND length("reviews"."trigger_context"->>'sourceUrl') <= 2048 AND "reviews"."trigger_context"->>'sourceUrl' ~* '^https://github[.]com([/?#]|$)'))
    AND (NOT "reviews"."trigger_context" ? 'requestedByGithubId' OR (jsonb_typeof("reviews"."trigger_context"->'requestedByGithubId') = 'number' AND ("reviews"."trigger_context"->>'requestedByGithubId')::numeric = trunc(("reviews"."trigger_context"->>'requestedByGithubId')::numeric) AND ("reviews"."trigger_context"->>'requestedByGithubId')::numeric BETWEEN 1 AND 9007199254740991))
    AND (NOT "reviews"."trigger_context" ? 'requestedByLogin' OR (jsonb_typeof("reviews"."trigger_context"->'requestedByLogin') = 'string' AND length("reviews"."trigger_context"->>'requestedByLogin') <= 100))
    AND (NOT "reviews"."trigger_context" ? 'checkName' OR (jsonb_typeof("reviews"."trigger_context"->'checkName') = 'string' AND length("reviews"."trigger_context"->>'checkName') <= 200))
  )
) NOT VALID;--> statement-breakpoint
ALTER TABLE "reviews" VALIDATE CONSTRAINT "reviews_trigger_source_check";--> statement-breakpoint
ALTER TABLE "reviews" VALIDATE CONSTRAINT "reviews_trigger_context_check";
