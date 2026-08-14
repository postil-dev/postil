SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "lock_generation" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE SEQUENCE "review_input_arrival_sequence" AS bigint;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "stage_unactivated_release_job"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  fenced_run_after jsonb;
  release_v1_run_after jsonb;
BEGIN
  -- Pre-rollout workers and the bounded release backfill both cross this
  -- boundary. Assign arrival-order authority here so neither path can bypass
  -- equal-timestamp supersession.
  IF NEW."kind" = 'review' AND NOT NEW."payload" ? 'reviewInputSequence' THEN
    NEW."payload" := jsonb_set(
      NEW."payload",
      '{reviewInputSequence}',
      to_jsonb(nextval('review_input_arrival_sequence')::text),
      true
    );
  END IF;

  IF NEW."kind" = 'review'
    AND jsonb_typeof(NEW."payload"->'_postilCoalescedReviewPayload') = 'object'
    AND NOT ((NEW."payload"->'_postilCoalescedReviewPayload') ? 'reviewInputSequence') THEN
    NEW."payload" := jsonb_set(
      NEW."payload",
      '{_postilCoalescedReviewPayload,reviewInputSequence}',
      to_jsonb(nextval('review_input_arrival_sequence')::text),
      true
    );
  END IF;

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
      release_v1_run_after := NULL;
      IF TG_OP = 'UPDATE'
        AND jsonb_typeof(OLD."payload"->'_postilReleaseV1RunAfter') = 'string' THEN
        release_v1_run_after := OLD."payload"->'_postilReleaseV1RunAfter';
      END IF;
      IF release_v1_run_after IS NULL THEN
        release_v1_run_after := CASE
          WHEN TG_OP = 'UPDATE'
            AND OLD."run_after" = 'infinity'::timestamptz
            AND NEW."run_after" = 'infinity'::timestamptz
            THEN to_jsonb(clock_timestamp())
          ELSE to_jsonb(NEW."run_after")
        END;
      END IF;
      NEW."payload" := (
        NEW."payload" - '_postilReleaseV1RunAfter'
      ) || jsonb_build_object(
        '_postilReleaseV1RunAfter', release_v1_run_after
      );
      NEW."run_after" := 'infinity'::timestamptz;
    END IF;
  END IF;

  IF NEW."status" = 'queued' THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('postil:queue-lock-generation-v1', 0)
    );
    IF NOT EXISTS (
      SELECT 1 FROM "deployment_capabilities"
      WHERE "name" = 'queue-lock-generation-v1'
    ) THEN
      fenced_run_after := NULL;
      IF TG_OP = 'UPDATE'
        AND OLD."payload"->>'_postilLockGenerationFence' = 'true'
        AND jsonb_typeof(
          OLD."payload"->'_postilLockGenerationRunAfter'
        ) = 'string' THEN
        fenced_run_after := OLD."payload"->'_postilLockGenerationRunAfter';
      END IF;
      IF fenced_run_after IS NULL
        AND NEW."kind" IN (
          'escalation-email-verification',
          'billing-contact-verification',
          'respond-delivery',
          'webhook-comment'
        )
        AND jsonb_typeof(
          NEW."payload"->'_postilReleaseV1RunAfter'
        ) = 'string' THEN
        fenced_run_after := NEW."payload"->'_postilReleaseV1RunAfter';
      END IF;
      IF fenced_run_after IS NULL THEN
        fenced_run_after := to_jsonb(NEW."run_after");
      END IF;
      NEW."payload" := (
        NEW."payload" - '_postilLockGenerationFence' -
          '_postilLockGenerationRunAfter'
      ) || jsonb_build_object(
        '_postilLockGenerationFence', true,
        '_postilLockGenerationRunAfter', fenced_run_after
      );
      NEW."run_after" := 'infinity'::timestamptz;
    END IF;
  END IF;

  IF TG_OP = 'UPDATE'
    AND OLD."status" = 'queued'
    AND NEW."status" = 'running' THEN
    -- Activation and claims share this transaction lock. Claims remain held
    -- while the capability is inactive, including claims from a worker whose
    -- statement predates the lock-generation column.
    PERFORM pg_advisory_xact_lock(
      hashtextextended('postil:queue-lock-generation-v1', 0)
    );
    IF NOT EXISTS (
      SELECT 1 FROM "deployment_capabilities"
      WHERE "name" = 'queue-lock-generation-v1'
    ) THEN
      NEW."status" := 'queued';
      NEW."attempts" := OLD."attempts";
      NEW."locked_at" := OLD."locked_at";
      NEW."locked_by" := OLD."locked_by";
      NEW."lock_generation" := OLD."lock_generation";
      fenced_run_after := NULL;
      IF OLD."payload"->>'_postilLockGenerationFence' = 'true'
        AND jsonb_typeof(
          OLD."payload"->'_postilLockGenerationRunAfter'
        ) = 'string' THEN
        fenced_run_after := OLD."payload"->'_postilLockGenerationRunAfter';
      END IF;
      IF fenced_run_after IS NULL THEN
        fenced_run_after := to_jsonb(OLD."run_after");
      END IF;
      NEW."payload" := (
        NEW."payload" - '_postilLockGenerationFence' -
          '_postilLockGenerationRunAfter'
      ) || jsonb_build_object(
        '_postilLockGenerationFence', true,
        '_postilLockGenerationRunAfter', fenced_run_after
      );
      NEW."run_after" := 'infinity'::timestamptz;
      RETURN NEW;
    END IF;

    IF NEW."lock_generation" IS NOT DISTINCT FROM OLD."lock_generation" THEN
      -- Keep rollback to a pre-generation worker safe after activation.
      -- The database supplies the increment that its claim statement omits.
      NEW."lock_generation" := OLD."lock_generation" + 1;
    ELSIF NEW."lock_generation" IS DISTINCT FROM OLD."lock_generation" + 1 THEN
      RAISE EXCEPTION
        'queue-lock-generation-v1 queued-to-running claim must advance lock_generation by one'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER "jobs_stage_unactivated_release_trigger" ON "jobs";
--> statement-breakpoint
CREATE TRIGGER "jobs_stage_unactivated_release_trigger"
  BEFORE INSERT OR UPDATE OF "kind", "payload", "status", "run_after" ON "jobs"
  FOR EACH ROW EXECUTE FUNCTION "stage_unactivated_release_job"();
