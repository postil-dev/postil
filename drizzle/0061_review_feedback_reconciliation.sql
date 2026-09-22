SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "review_feedback_polls" (
	"github_repo_id" bigint NOT NULL,
	"pr_number" integer NOT NULL,
	"next_poll_at" timestamp with time zone NOT NULL,
	"last_error" text,
	CONSTRAINT "review_feedback_polls_github_repo_id_pr_number_pk" PRIMARY KEY("github_repo_id","pr_number")
);
--> statement-breakpoint
CREATE TABLE "review_feedback_requests" (
	"github_repo_id" bigint NOT NULL,
	"pr_number" integer NOT NULL,
	"head_sha" text NOT NULL,
	"digest" text NOT NULL,
	"org_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_feedback_requests_github_repo_id_pr_number_head_sha_digest_pk" PRIMARY KEY("github_repo_id","pr_number","head_sha","digest")
);
--> statement-breakpoint
ALTER TABLE "reviews" DROP CONSTRAINT "reviews_trigger_source_check";--> statement-breakpoint
ALTER TABLE "reviews" DROP CONSTRAINT "reviews_trigger_context_check";--> statement-breakpoint
ALTER TABLE "usage_events" DROP CONSTRAINT "usage_events_trigger_source_check";--> statement-breakpoint
CREATE INDEX "review_feedback_requests_org_created_idx" ON "review_feedback_requests" USING btree ("org_id","created_at");--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_trigger_source_check" CHECK ("reviews"."trigger_source" IN ('unknown', 'automatic_pull_request', 'requested_review', 'github_check_rerun', 'finding_feedback')) NOT VALID;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_trigger_context_check" CHECK (("reviews"."trigger_source" = 'finding_feedback' AND "reviews"."trigger_context" IS NOT NULL AND jsonb_typeof("reviews"."trigger_context") = 'object' AND "reviews"."trigger_context" - ARRAY['source', 'feedbackDigest']::text[] = '{}'::jsonb AND "reviews"."trigger_context"->>'source' = 'finding_feedback' AND jsonb_typeof("reviews"."trigger_context"->'feedbackDigest') = 'string' AND COALESCE("reviews"."trigger_context"->>'feedbackDigest', '') ~ '^[a-f0-9]{64}$') OR ("reviews"."trigger_source" = 'unknown' AND ("reviews"."trigger_context" IS NULL OR "reviews"."trigger_context" = '{"source":"unknown"}'::jsonb)) OR ("reviews"."trigger_source" <> 'unknown' AND "reviews"."trigger_context" IS NOT NULL AND jsonb_typeof("reviews"."trigger_context") = 'object' AND "reviews"."trigger_context" - ARRAY['source', 'webhookDeliveryId', 'webhookEvent', 'webhookAction', 'sourceCommentId', 'sourceUrl', 'requestedByGithubId', 'requestedByLogin', 'checkName']::text[] = '{}'::jsonb AND "reviews"."trigger_context"->>'source' = "reviews"."trigger_source" AND jsonb_typeof("reviews"."trigger_context"->'webhookDeliveryId') = 'string' AND COALESCE(length(btrim("reviews"."trigger_context"->>'webhookDeliveryId')), 0) > 0 AND length("reviews"."trigger_context"->>'webhookDeliveryId') <= 200 AND (("reviews"."trigger_source" = 'automatic_pull_request' AND "reviews"."trigger_context"->>'webhookEvent' = 'pull_request') OR ("reviews"."trigger_source" = 'requested_review' AND "reviews"."trigger_context"->>'webhookEvent' IN ('issue_comment', 'pull_request_review_comment')) OR ("reviews"."trigger_source" = 'github_check_rerun' AND "reviews"."trigger_context"->>'webhookEvent' IN ('check_run', 'check_suite'))) AND (NOT "reviews"."trigger_context" ? 'webhookAction' OR (jsonb_typeof("reviews"."trigger_context"->'webhookAction') = 'string' AND length("reviews"."trigger_context"->>'webhookAction') <= 100)) AND (NOT "reviews"."trigger_context" ? 'sourceCommentId' OR (jsonb_typeof("reviews"."trigger_context"->'sourceCommentId') = 'number' AND ("reviews"."trigger_context"->>'sourceCommentId')::numeric = trunc(("reviews"."trigger_context"->>'sourceCommentId')::numeric) AND ("reviews"."trigger_context"->>'sourceCommentId')::numeric BETWEEN 1 AND 9007199254740991)) AND (NOT "reviews"."trigger_context" ? 'sourceUrl' OR (jsonb_typeof("reviews"."trigger_context"->'sourceUrl') = 'string' AND length("reviews"."trigger_context"->>'sourceUrl') <= 2048 AND "reviews"."trigger_context"->>'sourceUrl' ~* '^https://github[.]com([/?#]|$)')) AND (NOT "reviews"."trigger_context" ? 'requestedByGithubId' OR (jsonb_typeof("reviews"."trigger_context"->'requestedByGithubId') = 'number' AND ("reviews"."trigger_context"->>'requestedByGithubId')::numeric = trunc(("reviews"."trigger_context"->>'requestedByGithubId')::numeric) AND ("reviews"."trigger_context"->>'requestedByGithubId')::numeric BETWEEN 1 AND 9007199254740991)) AND (NOT "reviews"."trigger_context" ? 'requestedByLogin' OR (jsonb_typeof("reviews"."trigger_context"->'requestedByLogin') = 'string' AND length("reviews"."trigger_context"->>'requestedByLogin') <= 100)) AND (NOT "reviews"."trigger_context" ? 'checkName' OR (jsonb_typeof("reviews"."trigger_context"->'checkName') = 'string' AND length("reviews"."trigger_context"->>'checkName') <= 200)))) NOT VALID;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_trigger_source_check" CHECK ("usage_events"."trigger_source" IN ('unknown', 'automatic_pull_request', 'requested_review', 'github_check_rerun', 'finding_feedback', 'github_mention')) NOT VALID;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION suppress_duplicate_active_review_job()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  repository_identity text;
  pull_request_number text;
  head_sha text;
  review_identity text;
BEGIN
  -- Preserve feedback through same-head coalescing by an older queue writer.
  IF TG_OP = 'UPDATE' AND OLD.kind IN ('review', 'review-feedback') THEN
    IF OLD.payload ? 'reviewFeedback' AND NOT NEW.payload ? 'reviewFeedback'
       AND NEW.payload->>'githubRepoId' = OLD.payload->>'githubRepoId'
       AND NEW.payload->>'prNumber' = OLD.payload->>'prNumber'
       AND NEW.payload->>'headSha' = OLD.payload->>'headSha'
       AND NEW.payload->>'installationId' = OLD.payload->>'installationId' THEN
      NEW.payload := jsonb_set(NEW.payload, '{reviewFeedback}', OLD.payload->'reviewFeedback');
    END IF;
    IF jsonb_typeof(OLD.payload->'_postilCoalescedReviewPayload'->'reviewFeedback') = 'object'
       AND jsonb_typeof(NEW.payload->'_postilCoalescedReviewPayload') = 'object'
       AND NOT (NEW.payload->'_postilCoalescedReviewPayload') ? 'reviewFeedback'
       AND NEW.payload->'_postilCoalescedReviewPayload'->>'githubRepoId' = OLD.payload->'_postilCoalescedReviewPayload'->>'githubRepoId'
       AND NEW.payload->'_postilCoalescedReviewPayload'->>'prNumber' = OLD.payload->'_postilCoalescedReviewPayload'->>'prNumber'
       AND NEW.payload->'_postilCoalescedReviewPayload'->>'headSha' = OLD.payload->'_postilCoalescedReviewPayload'->>'headSha'
       AND NEW.payload->'_postilCoalescedReviewPayload'->>'installationId' = OLD.payload->'_postilCoalescedReviewPayload'->>'installationId' THEN
      NEW.payload := jsonb_set(NEW.payload, '{_postilCoalescedReviewPayload,reviewFeedback}',
        OLD.payload->'_postilCoalescedReviewPayload'->'reviewFeedback');
    END IF;
  END IF;
  -- Legacy retry SQL inserts kind=review. Promotion keeps old allowlists from claiming evidence.
  IF NEW.kind IN ('review', 'review-feedback') AND NEW.payload ? 'reviewFeedback' THEN
    NEW.kind := 'review-feedback';
  END IF;
  IF NEW.kind NOT IN ('review', 'review-feedback') OR NEW.status NOT IN ('queued', 'running') THEN
    RETURN NEW;
  END IF;

  pull_request_number := NEW.payload->>'prNumber';
  head_sha := NEW.payload->>'headSha';
  IF NEW.payload->>'repoFullName' IS NULL OR pull_request_number IS NULL OR head_sha IS NULL THEN
    RETURN NEW;
  END IF;

  IF jsonb_typeof(NEW.payload->'githubRepoId') = 'number'
    AND NEW.payload->>'githubRepoId' ~ '^[1-9][0-9]*$' THEN
    repository_identity := NEW.payload->>'githubRepoId';
  ELSE
    SELECT repository.github_repo_id::text
      INTO repository_identity
      FROM repositories repository
     WHERE repository.full_name = NEW.payload->>'repoFullName'
     LIMIT 1;
  END IF;
  IF repository_identity IS NULL THEN
    NEW.status := 'failed';
    NEW.locked_at := NULL;
    NEW.locked_by := NULL;
    NEW.last_error := 'active review repository identity could not be resolved';
    NEW.run_after := now();
    RETURN NEW;
  END IF;

  IF (
    jsonb_typeof(NEW.payload->'githubRepoId') = 'number'
    AND NEW.payload->>'githubRepoId' ~ '^[1-9][0-9]*$'
  ) IS NOT TRUE THEN
    NEW.payload := jsonb_set(
      NEW.payload,
      '{githubRepoId}',
      to_jsonb(repository_identity::bigint),
      true
    );
  END IF;

  review_identity := repository_identity || chr(31) || pull_request_number || chr(31) || head_sha;
  PERFORM pg_advisory_xact_lock(
    hashtextextended('postil:active-review:' || review_identity, 0)
  );
  -- Reject legacy coalescing atomically when it retires an unfinished recovery.
  IF TG_OP = 'INSERT' AND NOT NEW.payload ? 'recoveryReviewId' AND EXISTS (
    SELECT 1 FROM jobs recovering
    JOIN reviews review ON review.id::text = recovering.payload->>'recoveryReviewId'
    JOIN review_publication_receipts receipt ON receipt.review_id = review.id
    WHERE recovering.kind IN ('review', 'review-feedback')
      AND recovering.status IN ('done', 'failed')
      AND recovering.payload->>'githubRepoId' = repository_identity
      AND recovering.payload->>'prNumber' = pull_request_number
      AND recovering.payload->>'headSha' = NEW.payload->>'headSha'
      AND review.status = 'running'
  ) THEN
    RAISE EXCEPTION 'review publication recovery is unfinished';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jobs existing
    WHERE existing.kind IN ('review', 'review-feedback')
      AND existing.status IN ('queued', 'running')
      AND existing.id IS DISTINCT FROM NEW.id
      AND COALESCE(
        CASE
          WHEN jsonb_typeof(existing.payload->'githubRepoId') = 'number'
            AND existing.payload->>'githubRepoId' ~ '^[1-9][0-9]*$'
            THEN existing.payload->>'githubRepoId'
        END,
        (
          SELECT repository.github_repo_id::text
          FROM repositories repository
          WHERE repository.full_name = existing.payload->>'repoFullName'
          LIMIT 1
        )
      ) = repository_identity
      AND existing.payload->>'prNumber' = pull_request_number
      AND existing.payload->>'headSha' = head_sha
  ) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION "postil_guard_job_publication_identity"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."kind" IN ('review', 'review-feedback')
     AND OLD."payload" ? 'recoveryReviewId'
     AND NEW."payload"->'recoveryReviewId' IS DISTINCT FROM OLD."payload"->'recoveryReviewId' THEN
    RAISE EXCEPTION 'review recovery identity is immutable';
  END IF;
  IF OLD."kind" IN ('review', 'review-feedback', 'respond', 'respond-failure-comment', 'webhook-comment')
     AND (
       (NEW."kind" IS DISTINCT FROM OLD."kind" AND NOT ((OLD."kind" = 'review' AND OLD."status" = 'queued' AND NEW."kind" = 'review-feedback' AND jsonb_typeof(NEW."payload"->'reviewFeedback') = 'object') IS TRUE)) OR
       NEW."payload"->>'installationId' IS DISTINCT FROM OLD."payload"->>'installationId' OR
       NEW."payload"->>'sourceOrgId' IS DISTINCT FROM OLD."payload"->>'sourceOrgId' OR
       NEW."payload"->>'sourceInstallationId' IS DISTINCT FROM OLD."payload"->>'sourceInstallationId' OR
       NEW."payload"->>'githubRepoId' IS DISTINCT FROM OLD."payload"->>'githubRepoId' OR
       NEW."payload"->>'repoFullName' IS DISTINCT FROM OLD."payload"->>'repoFullName' OR
       NEW."payload"->>'prNumber' IS DISTINCT FROM OLD."payload"->>'prNumber' OR
       NEW."payload"->>'number' IS DISTINCT FROM OLD."payload"->>'number' OR
       NEW."payload"->>'isPr' IS DISTINCT FROM OLD."payload"->>'isPr' OR
       NEW."payload"->>'headSha' IS DISTINCT FROM OLD."payload"->>'headSha' OR
       NEW."payload"->>'baseSha' IS DISTINCT FROM OLD."payload"->>'baseSha' OR
       NEW."payload"->>'sourceHeadSha' IS DISTINCT FROM OLD."payload"->>'sourceHeadSha'
     ) THEN
    RAISE EXCEPTION 'job publication identity is immutable';
  END IF;
  RETURN NEW;
END $$;
