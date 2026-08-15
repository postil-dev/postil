SET LOCAL lock_timeout = '5s';--> statement-breakpoint
DO $$
BEGIN
  IF NOT pg_try_advisory_xact_lock(
    hashtextextended('postil:queue-lock-generation-v1', 0)
  ) THEN
    RAISE EXCEPTION
      'publication-controller ownership migration could not acquire queue lock'
      USING ERRCODE = 'lock_not_available';
  END IF;
  IF NOT pg_try_advisory_xact_lock(
    hashtextextended('postil:publication-controller-release', 0)
  ) THEN
    RAISE EXCEPTION
      'publication-controller ownership migration could not acquire authority lock'
      USING ERRCODE = 'lock_not_available';
  END IF;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "stage_unactivated_release_job"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  fenced_run_after jsonb;
  release_v1_run_after jsonb;
  publication_controller_run_after jsonb;
  publication_controller_release text;
  publication_controller_release_count integer;
  publication_controller_claim_release text;
  publication_controller_claim_authorized boolean := false;
  publication_controller_restored_run_after timestamptz;
BEGIN
  IF jsonb_typeof(
    NEW."payload"->'_postilPublicationControllerClaimReleaseSha'
  ) = 'string' THEN
    publication_controller_claim_release :=
      NEW."payload"->>'_postilPublicationControllerClaimReleaseSha';
  END IF;
  NEW."payload" :=
    NEW."payload" - '_postilPublicationControllerClaimReleaseSha';

  -- Older activation code can still try to assign controller ownership to
  -- non-review jobs after this migration. Normalize those rows at the queue
  -- boundary so every deployed writer observes review-only ownership.
  IF NEW."status" = 'queued'
    AND NEW."kind" IN ('gate-state-sync', 'check-run-cleanup')
    AND NEW."payload"->>'_postilPublicationControllerFence' = 'true' THEN
    publication_controller_restored_run_after := clock_timestamp();
    IF TG_OP = 'UPDATE'
      AND OLD."kind" = NEW."kind"
      AND OLD."status" = 'queued'
      AND OLD."payload"->>'_postilPublicationControllerFence'
        IS DISTINCT FROM 'true' THEN
      publication_controller_restored_run_after := OLD."run_after";
      IF NOT isfinite(publication_controller_restored_run_after)
        AND jsonb_typeof(
          OLD."payload"->'_postilLockGenerationRunAfter'
        ) = 'string'
        AND pg_input_is_valid(
          OLD."payload"->>'_postilLockGenerationRunAfter',
          'timestamptz'
        ) THEN
        publication_controller_restored_run_after := (
          OLD."payload"->>'_postilLockGenerationRunAfter'
        )::timestamptz;
      END IF;
    ELSIF jsonb_typeof(
      NEW."payload"->'_postilPublicationControllerRunAfter'
    ) = 'string'
      AND pg_input_is_valid(
        NEW."payload"->>'_postilPublicationControllerRunAfter',
        'timestamptz'
      ) THEN
      publication_controller_restored_run_after := (
        NEW."payload"->>'_postilPublicationControllerRunAfter'
      )::timestamptz;
    ELSIF jsonb_typeof(
      NEW."payload"->'_postilLockGenerationRunAfter'
    ) = 'string'
      AND pg_input_is_valid(
        NEW."payload"->>'_postilLockGenerationRunAfter',
        'timestamptz'
      ) THEN
      publication_controller_restored_run_after := (
        NEW."payload"->>'_postilLockGenerationRunAfter'
      )::timestamptz;
    END IF;
    IF NOT isfinite(publication_controller_restored_run_after) THEN
      publication_controller_restored_run_after := clock_timestamp();
    END IF;
    NEW."payload" := NEW."payload" -
      '_postilPublicationControllerFence' -
      '_postilPublicationControllerRunAfter' -
      '_postilPublicationControllerReleaseSha';
    NEW."run_after" := publication_controller_restored_run_after;
  END IF;

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

    IF NEW."kind" = 'review' THEN
      PERFORM pg_advisory_xact_lock(
        hashtextextended('postil:publication-controller-release', 0)
      );
      publication_controller_release := NULL;
      SELECT count(*)::integer
        INTO publication_controller_release_count
        FROM "deployment_capabilities" active
       WHERE active."name" LIKE 'publication-controller-release:%'
         AND EXISTS (
           SELECT 1
             FROM "deployment_capabilities" ready
            WHERE ready."name" =
              'publication-controller-consumer-ready:' || substring(
                active."name"
                FROM char_length('publication-controller-release:') + 1
              )
         );
      IF publication_controller_release_count > 1 THEN
        RAISE EXCEPTION
          'multiple publication-controller releases are active'
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT substring(
               active."name"
               FROM char_length('publication-controller-release:') + 1
             )
        INTO publication_controller_release
        FROM "deployment_capabilities" active
       WHERE active."name" LIKE 'publication-controller-release:%'
         AND EXISTS (
           SELECT 1
             FROM "deployment_capabilities" ready
            WHERE ready."name" =
              'publication-controller-consumer-ready:' || substring(
                active."name"
                FROM char_length('publication-controller-release:') + 1
              )
         )
       ORDER BY active."name"
       LIMIT 1;
      IF publication_controller_release IS NOT NULL
        AND publication_controller_release !~ '^[0-9a-f]{7,40}$' THEN
        RAISE EXCEPTION
          'publication-controller active release identity is malformed'
          USING ERRCODE = 'check_violation';
      END IF;

      IF publication_controller_release IS NULL
        AND NEW."payload"->>'_postilPublicationControllerFence' = 'true'
        AND jsonb_typeof(
          NEW."payload"->'_postilPublicationControllerReleaseSha'
        ) = 'string' THEN
        SELECT count(*)::integer
          INTO publication_controller_release_count
          FROM "deployment_capabilities" recovery
         WHERE recovery."name" LIKE 'publication-controller-recovery:%'
           AND NEW."payload"->>'_postilPublicationControllerReleaseSha' =
             substring(
               recovery."name"
               FROM char_length('publication-controller-recovery:') + 1
             );
        IF publication_controller_release_count > 1 THEN
          RAISE EXCEPTION
            'multiple publication-controller releases own recovery'
            USING ERRCODE = 'check_violation';
        END IF;
        SELECT substring(
                 recovery."name"
                 FROM char_length('publication-controller-recovery:') + 1
               )
          INTO publication_controller_release
          FROM "deployment_capabilities" recovery
         WHERE recovery."name" LIKE 'publication-controller-recovery:%'
           AND NEW."payload"->>'_postilPublicationControllerReleaseSha' =
             substring(
               recovery."name"
               FROM char_length('publication-controller-recovery:') + 1
             )
         ORDER BY recovery."name"
         LIMIT 1;
        IF publication_controller_release IS NOT NULL
          AND publication_controller_release !~ '^[0-9a-f]{7,40}$' THEN
          RAISE EXCEPTION
            'publication-controller recovery release identity is malformed'
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;

      IF publication_controller_release IS NOT NULL THEN
        publication_controller_run_after := NULL;
        IF TG_OP = 'UPDATE'
          AND OLD."status" = 'queued'
          AND NEW."status" = 'queued'
          AND jsonb_typeof(
            OLD."payload"->'_postilPublicationControllerRunAfter'
          ) = 'string' THEN
          publication_controller_run_after :=
            OLD."payload"->'_postilPublicationControllerRunAfter';
        END IF;
        IF publication_controller_run_after IS NULL
          AND NEW."run_after" = 'infinity'::timestamptz
          AND jsonb_typeof(
            NEW."payload"->'_postilLockGenerationRunAfter'
          ) = 'string' THEN
          publication_controller_run_after :=
            NEW."payload"->'_postilLockGenerationRunAfter';
        END IF;
        IF publication_controller_run_after IS NULL THEN
          publication_controller_run_after := to_jsonb(NEW."run_after");
        END IF;
        NEW."payload" := (
          NEW."payload" - '_postilPublicationControllerFence' -
            '_postilPublicationControllerRunAfter' -
            '_postilPublicationControllerReleaseSha'
        ) || jsonb_build_object(
          '_postilPublicationControllerFence', true,
          '_postilPublicationControllerRunAfter',
          publication_controller_run_after,
          '_postilPublicationControllerReleaseSha',
          publication_controller_release
        );
        NEW."run_after" := 'infinity'::timestamptz;
      END IF;
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

    IF NEW."kind" = 'review' THEN
      PERFORM pg_advisory_xact_lock(
        hashtextextended('postil:publication-controller-release', 0)
      );
      publication_controller_release := NULL;
      SELECT count(*)::integer
        INTO publication_controller_release_count
        FROM "deployment_capabilities" active
       WHERE active."name" LIKE 'publication-controller-release:%'
         AND EXISTS (
           SELECT 1
             FROM "deployment_capabilities" ready
            WHERE ready."name" =
              'publication-controller-consumer-ready:' || substring(
                active."name"
                FROM char_length('publication-controller-release:') + 1
              )
         );
      IF publication_controller_release_count > 1 THEN
        RAISE EXCEPTION
          'multiple publication-controller releases are active'
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT substring(
               active."name"
               FROM char_length('publication-controller-release:') + 1
             )
        INTO publication_controller_release
        FROM "deployment_capabilities" active
       WHERE active."name" LIKE 'publication-controller-release:%'
         AND EXISTS (
           SELECT 1
             FROM "deployment_capabilities" ready
            WHERE ready."name" =
              'publication-controller-consumer-ready:' || substring(
                active."name"
                FROM char_length('publication-controller-release:') + 1
              )
         )
       ORDER BY active."name"
       LIMIT 1;
      IF publication_controller_release IS NOT NULL
        AND publication_controller_release !~ '^[0-9a-f]{7,40}$' THEN
        RAISE EXCEPTION
          'publication-controller active release identity is malformed'
          USING ERRCODE = 'check_violation';
      END IF;

      IF NEW."kind" = 'review'
        AND publication_controller_claim_release ~ '^[0-9a-f]{40}$'
        AND publication_controller_release = publication_controller_claim_release
        AND OLD."payload"->>'_postilPublicationControllerFence' = 'true'
        AND OLD."payload"->>'_postilPublicationControllerReleaseSha' =
          publication_controller_claim_release
        AND jsonb_typeof(
          OLD."payload"->'_postilPublicationControllerRunAfter'
        ) = 'string'
        AND NEW."payload" = OLD."payload"
        AND NEW."run_after" IS NOT DISTINCT FROM OLD."run_after"
        AND NEW."attempts" = OLD."attempts" + 1
        AND NEW."locked_at" IS NOT NULL
        AND NEW."locked_by" IS NOT NULL THEN
        publication_controller_claim_authorized := true;
      END IF;

      IF publication_controller_release IS NULL
        AND OLD."payload"->>'_postilPublicationControllerFence' = 'true'
        AND jsonb_typeof(
          OLD."payload"->'_postilPublicationControllerReleaseSha'
        ) = 'string' THEN
        SELECT count(*)::integer
          INTO publication_controller_release_count
          FROM "deployment_capabilities" recovery
         WHERE recovery."name" LIKE 'publication-controller-recovery:%'
           AND OLD."payload"->>'_postilPublicationControllerReleaseSha' =
             substring(
               recovery."name"
               FROM char_length('publication-controller-recovery:') + 1
             );
        IF publication_controller_release_count > 1 THEN
          RAISE EXCEPTION
            'multiple publication-controller releases own recovery'
            USING ERRCODE = 'check_violation';
        END IF;
        SELECT substring(
                 recovery."name"
                 FROM char_length('publication-controller-recovery:') + 1
               )
          INTO publication_controller_release
          FROM "deployment_capabilities" recovery
         WHERE recovery."name" LIKE 'publication-controller-recovery:%'
           AND OLD."payload"->>'_postilPublicationControllerReleaseSha' =
             substring(
               recovery."name"
               FROM char_length('publication-controller-recovery:') + 1
             )
         ORDER BY recovery."name"
         LIMIT 1;
        IF publication_controller_release IS NOT NULL
          AND publication_controller_release !~ '^[0-9a-f]{7,40}$' THEN
          RAISE EXCEPTION
            'publication-controller recovery release identity is malformed'
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;

      IF publication_controller_release IS NOT NULL
        AND NOT publication_controller_claim_authorized THEN
        NEW."status" := 'queued';
        NEW."attempts" := OLD."attempts";
        NEW."locked_at" := OLD."locked_at";
        NEW."locked_by" := OLD."locked_by";
        NEW."lock_generation" := OLD."lock_generation";
        publication_controller_run_after := NULL;
        IF jsonb_typeof(
          OLD."payload"->'_postilPublicationControllerRunAfter'
        ) = 'string' THEN
          publication_controller_run_after :=
            OLD."payload"->'_postilPublicationControllerRunAfter';
        END IF;
        IF publication_controller_run_after IS NULL
          AND jsonb_typeof(
            OLD."payload"->'_postilLockGenerationRunAfter'
          ) = 'string' THEN
          publication_controller_run_after :=
            OLD."payload"->'_postilLockGenerationRunAfter';
        END IF;
        IF publication_controller_run_after IS NULL THEN
          publication_controller_run_after := to_jsonb(OLD."run_after");
        END IF;
        NEW."payload" := (
          NEW."payload" - '_postilPublicationControllerFence' -
            '_postilPublicationControllerRunAfter' -
            '_postilPublicationControllerReleaseSha'
        ) || jsonb_build_object(
          '_postilPublicationControllerFence', true,
          '_postilPublicationControllerRunAfter',
          publication_controller_run_after,
          '_postilPublicationControllerReleaseSha',
          publication_controller_release
        );
        NEW."run_after" := 'infinity'::timestamptz;
        RETURN NEW;
      END IF;
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
$$;--> statement-breakpoint
DO $$
DECLARE
  held_job record;
  restored_run_after timestamptz;
BEGIN
  FOR held_job IN
    SELECT id, payload
      FROM jobs
     WHERE kind IN ('gate-state-sync', 'check-run-cleanup')
       AND status = 'queued'
       AND payload->>'_postilPublicationControllerFence' = 'true'
     FOR UPDATE
  LOOP
    restored_run_after := clock_timestamp();
    BEGIN
      IF jsonb_typeof(
        held_job.payload->'_postilPublicationControllerRunAfter'
      ) = 'string' THEN
        restored_run_after := (
          held_job.payload->>'_postilPublicationControllerRunAfter'
        )::timestamptz;
      ELSIF jsonb_typeof(
        held_job.payload->'_postilLockGenerationRunAfter'
      ) = 'string' THEN
        restored_run_after := (
          held_job.payload->>'_postilLockGenerationRunAfter'
        )::timestamptz;
      END IF;
    EXCEPTION
      WHEN invalid_datetime_format OR datetime_field_overflow THEN
        restored_run_after := clock_timestamp();
    END;
    IF NOT isfinite(restored_run_after) THEN
      restored_run_after := clock_timestamp();
    END IF;

    UPDATE jobs
       SET payload = payload - '_postilPublicationControllerFence' -
             '_postilPublicationControllerRunAfter' -
             '_postilPublicationControllerReleaseSha',
           run_after = restored_run_after
     WHERE id = held_job.id
       AND status = 'queued';
  END LOOP;
END;
$$;
