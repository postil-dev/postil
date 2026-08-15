SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE FUNCTION "postil_publication_controller_supersession_authorized"(
  candidate_repository_id bigint,
  candidate_pr_number integer,
  candidate_publication_generation bigint
)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.review_publication_generations generation
    JOIN public.jobs job
      ON job.kind = 'review'
     AND job.status = 'running'
     AND job.locked_by IS NOT NULL
     AND job.lock_generation > 0
     AND job.payload->>'recoveryReviewId' = generation.review_id::text
     AND job.payload->>'reviewInputSequence' = generation.review_input_sequence::text
    LEFT JOIN public.pull_request_publication_high_waters high_water
      ON high_water.repository_id = generation.repository_id
     AND high_water.pr_number = generation.pr_number
    WHERE generation.repository_id = candidate_repository_id
      AND generation.pr_number = candidate_pr_number
      AND generation.publication_generation = candidate_publication_generation
      AND generation.sealed_at IS NOT NULL
      AND job.payload->>'_postilPublicationControllerFence' = 'true'
      AND job.payload->>'_postilPublicationControllerReleaseSha' ~ '^[0-9a-f]{40}$'
      AND EXISTS (
        SELECT 1
        FROM public.deployment_capabilities active
        JOIN public.deployment_capabilities ready
          ON ready.name = 'publication-controller-consumer-ready:' ||
            (job.payload->>'_postilPublicationControllerReleaseSha')
        WHERE active.name = 'publication-controller-release:' ||
          (job.payload->>'_postilPublicationControllerReleaseSha')
      )
      AND (
        SELECT count(*)
        FROM public.deployment_capabilities
        WHERE name LIKE 'publication-controller-release:%'
      ) = 1
      AND EXISTS (
        SELECT 1
        FROM public.deployment_capabilities
        WHERE name = 'queue-lock-generation-v1'
      )
      AND (
        jsonb_typeof(job.payload->'_postilCoalescedReviewPayload') = 'object'
        OR high_water.publication_generation IS DISTINCT FROM
          generation.publication_generation
        OR high_water.accepted_review_id IS DISTINCT FROM generation.review_id
        OR high_water.accepted_input_digest IS DISTINCT FROM
          generation.accepted_input_digest
      )
  );
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "postil_guard_review_publication_operation"()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  database_now timestamp with time zone := pg_catalog.clock_timestamp();
  has_not_dispatched boolean;
  has_applied boolean;
  has_rejected boolean;
  has_ambiguous boolean;
  has_retry_absence boolean;
  has_terminal_absence boolean;
  has_terminal_applied boolean;
  has_controller_supersession boolean;
  dependencies_terminal boolean;
  activation_eligible boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.repositories WHERE id = OLD.repository_id) THEN
      RAISE EXCEPTION 'review publication operations can only be deleted by repository teardown';
    END IF;
    RETURN OLD;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(NEW.repository_id::text || ':' || NEW.pr_number::text, 0)
  );

  IF TG_OP = 'INSERT' THEN
    IF EXISTS (
      SELECT 1
      FROM public.review_publication_generations
      WHERE repository_id = NEW.repository_id
        AND pr_number = NEW.pr_number
        AND publication_generation = NEW.publication_generation
        AND sealed_at IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'sealed publication generations cannot accept operations';
    END IF;
    IF NEW.state <> 'pending'
       OR NEW.attempt_count <> 0
       OR NEW.lease_generation <> 0
       OR NEW.claim_owner IS NOT NULL
       OR NEW.lease_id IS NOT NULL
       OR NEW.lease_expires_at IS NOT NULL
       OR NEW.selected_variant IS NOT NULL
       OR NEW.retry_after IS NOT NULL
       OR NEW.last_error IS NOT NULL
       OR NEW.terminal_evidence IS NOT NULL
       OR NEW.evidence_generation <> 0
       OR NEW.created_at <> NEW.updated_at THEN
      RAISE EXCEPTION 'publication operations must be inserted in pristine pending state';
    END IF;
    IF (
      SELECT 2 + count(*) + COALESCE(sum(octet_length(controller_record_bytes)), 0)
      FROM public.review_publication_operations
      WHERE repository_id = NEW.repository_id
        AND pr_number = NEW.pr_number
        AND publication_generation = NEW.publication_generation
    ) + octet_length(NEW.controller_record_bytes) > 8388608 THEN
      RAISE EXCEPTION 'publication generation exceeds the 8 MiB canonical controller-record limit';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF NEW.updated_at < OLD.updated_at
     OR NEW.updated_at > database_now + interval '1 second' THEN
    RAISE EXCEPTION 'publication operation timestamps must not be backdated or future-dated';
  END IF;
  NEW.updated_at := database_now;
  IF NEW.repository_id IS DISTINCT FROM OLD.repository_id
     OR NEW.pr_number IS DISTINCT FROM OLD.pr_number
     OR NEW.publication_generation IS DISTINCT FROM OLD.publication_generation
     OR NEW.review_id IS DISTINCT FROM OLD.review_id
     OR NEW.operation_key IS DISTINCT FROM OLD.operation_key
     OR NEW.operation_ordinal IS DISTINCT FROM OLD.operation_ordinal
     OR NEW.operation_source IS DISTINCT FROM OLD.operation_source
     OR NEW.controller_record IS DISTINCT FROM OLD.controller_record
     OR NEW.controller_record_bytes IS DISTINCT FROM OLD.controller_record_bytes
     OR NEW.operation_record IS DISTINCT FROM OLD.operation_record
     OR NEW.operation_record_bytes IS DISTINCT FROM OLD.operation_record_bytes
     OR NEW.activation IS DISTINCT FROM OLD.activation
     OR NEW.activation_bytes IS DISTINCT FROM OLD.activation_bytes
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.desired_payload IS DISTINCT FROM OLD.desired_payload
     OR NEW.desired_payload_bytes IS DISTINCT FROM OLD.desired_payload_bytes
     OR NEW.desired_payload_digest IS DISTINCT FROM OLD.desired_payload_digest
     OR NEW.deadline_at IS DISTINCT FROM OLD.deadline_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'publication operation intent is immutable';
  END IF;
  IF NEW.attempt_count < OLD.attempt_count
     OR NEW.lease_generation < OLD.lease_generation THEN
    RAISE EXCEPTION 'publication operation attempt counters cannot decrease';
  END IF;
  IF OLD.terminal_evidence IS NOT NULL
     AND NEW.terminal_evidence IS DISTINCT FROM OLD.terminal_evidence THEN
    RAISE EXCEPTION 'publication operation terminal evidence is immutable';
  END IF;
  IF NEW.evidence_generation <> OLD.evidence_generation THEN
    IF NEW.evidence_generation = OLD.evidence_generation + 1
       AND (to_jsonb(NEW) - ARRAY['evidence_generation', 'updated_at'])
            = (to_jsonb(OLD) - ARRAY['evidence_generation', 'updated_at']) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'publication operation evidence generation is database-serialized';
  END IF;
  IF OLD.state IN ('applied', 'skipped', 'superseded', 'failed') THEN
    RAISE EXCEPTION 'terminal publication operations are immutable';
  END IF;

  SELECT
    EXISTS (
      SELECT 1 FROM public.review_publication_operation_attempts
      WHERE repository_id = OLD.repository_id
        AND pr_number = OLD.pr_number
        AND publication_generation = OLD.publication_generation
        AND operation_key = OLD.operation_key
        AND attempt_number = OLD.attempt_count
        AND lease_generation = OLD.lease_generation
        AND phase = 'not_dispatched'
    ),
    EXISTS (
      SELECT 1 FROM public.review_publication_operation_attempts
      WHERE repository_id = OLD.repository_id
        AND pr_number = OLD.pr_number
        AND publication_generation = OLD.publication_generation
        AND operation_key = OLD.operation_key
        AND attempt_number = OLD.attempt_count
        AND lease_generation = OLD.lease_generation
        AND phase = 'applied'
    ),
    EXISTS (
      SELECT 1 FROM public.review_publication_operation_attempts
      WHERE repository_id = OLD.repository_id
        AND pr_number = OLD.pr_number
        AND publication_generation = OLD.publication_generation
        AND operation_key = OLD.operation_key
        AND attempt_number = OLD.attempt_count
        AND lease_generation = OLD.lease_generation
        AND phase = 'rejected'
    ),
    EXISTS (
      SELECT 1 FROM public.review_publication_operation_attempts
      WHERE repository_id = OLD.repository_id
        AND pr_number = OLD.pr_number
        AND publication_generation = OLD.publication_generation
        AND operation_key = OLD.operation_key
        AND attempt_number = OLD.attempt_count
        AND lease_generation = OLD.lease_generation
        AND phase = 'ambiguous'
    ),
    EXISTS (
      SELECT 1 FROM public.review_publication_operation_reconciliations
      WHERE repository_id = OLD.repository_id
        AND pr_number = OLD.pr_number
        AND publication_generation = OLD.publication_generation
        AND operation_key = OLD.operation_key
        AND attempt_number = OLD.attempt_count
        AND lease_generation = OLD.lease_generation
        AND phase = 'retry' AND outcome = 'exact_absence'
        AND observed_at >= database_now - interval '5 minutes'
        AND observed_at <= database_now + interval '1 second'
    ),
    EXISTS (
      SELECT 1 FROM public.review_publication_operation_reconciliations
      WHERE repository_id = OLD.repository_id
        AND pr_number = OLD.pr_number
        AND publication_generation = OLD.publication_generation
        AND operation_key = OLD.operation_key
        AND attempt_number = OLD.attempt_count
        AND lease_generation = OLD.lease_generation
        AND phase = 'terminal' AND outcome = 'exact_absence'
    ),
    EXISTS (
      SELECT 1 FROM public.review_publication_operation_reconciliations
      WHERE repository_id = OLD.repository_id
        AND pr_number = OLD.pr_number
        AND publication_generation = OLD.publication_generation
        AND operation_key = OLD.operation_key
        AND attempt_number = OLD.attempt_count
        AND lease_generation = OLD.lease_generation
        AND phase = 'terminal' AND outcome = 'applied'
    ),
    EXISTS (
      SELECT 1 FROM public.review_publication_operation_attempts
      WHERE repository_id = OLD.repository_id
        AND pr_number = OLD.pr_number
        AND publication_generation = OLD.publication_generation
        AND operation_key = OLD.operation_key
        AND attempt_number = NEW.attempt_count
        AND lease_generation = NEW.lease_generation
        AND phase = 'not_dispatched'
        AND selected_variant = 'controller-supersession'
    )
  INTO has_not_dispatched, has_applied, has_rejected, has_ambiguous,
       has_retry_absence, has_terminal_absence, has_terminal_applied,
       has_controller_supersession;

  IF NEW.state = OLD.state THEN
    IF OLD.state = 'pending' THEN
      IF (to_jsonb(NEW) - ARRAY['retry_after', 'last_error', 'updated_at'])
           <> (to_jsonb(OLD) - ARRAY['retry_after', 'last_error', 'updated_at']) THEN
        RAISE EXCEPTION 'pending publication updates may only change retry metadata';
      END IF;
      RETURN NEW;
    END IF;
    IF OLD.state = 'unknown' THEN
      IF (to_jsonb(NEW) - ARRAY['retry_after', 'updated_at'])
           <> (to_jsonb(OLD) - ARRAY['retry_after', 'updated_at']) THEN
        RAISE EXCEPTION 'unknown publication updates may only change retry scheduling';
      END IF;
      RETURN NEW;
    END IF;
    IF OLD.state = 'applying' THEN
      IF NEW.lease_id = OLD.lease_id
         AND NEW.claim_owner = OLD.claim_owner
         AND NEW.attempt_count = OLD.attempt_count
         AND NEW.lease_generation = OLD.lease_generation
         AND NEW.selected_variant = OLD.selected_variant THEN
        IF OLD.lease_expires_at <= database_now
           OR NEW.lease_expires_at <= OLD.lease_expires_at
           OR NEW.lease_expires_at <= database_now
           OR (to_jsonb(NEW) - ARRAY['lease_expires_at', 'updated_at'])
                <> (to_jsonb(OLD) - ARRAY['lease_expires_at', 'updated_at']) THEN
          RAISE EXCEPTION 'publication lease renewal may only extend the current lease';
        END IF;
        RETURN NEW;
      END IF;
      IF OLD.lease_expires_at > database_now
         OR NEW.lease_id IS NOT DISTINCT FROM OLD.lease_id
         OR NEW.attempt_count <> OLD.attempt_count + 1
         OR NEW.lease_generation <> OLD.lease_generation + 1
         OR NEW.last_error IS DISTINCT FROM OLD.last_error
         OR NEW.retry_after IS DISTINCT FROM OLD.retry_after
         OR NEW.terminal_evidence IS DISTINCT FROM OLD.terminal_evidence
         OR EXISTS (
           SELECT 1 FROM public.review_publication_operation_attempts
           WHERE repository_id = OLD.repository_id
             AND pr_number = OLD.pr_number
             AND publication_generation = OLD.publication_generation
             AND operation_key = OLD.operation_key
             AND attempt_number = OLD.attempt_count
             AND lease_generation = OLD.lease_generation
             AND phase = 'dispatched'
         ) THEN
        RAISE EXCEPTION 'publication lease replacement requires an expired undispatched attempt and new counters';
      END IF;
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'publication operation state is terminal';
  END IF;

  IF OLD.state = 'pending' AND NEW.state = 'applying' THEN
    IF NEW.attempt_count <> OLD.attempt_count + 1
       OR NEW.lease_generation <> OLD.lease_generation + 1
       OR NEW.lease_id IS NULL
       OR NEW.claim_owner IS NULL
       OR NEW.selected_variant IS NULL
       OR NEW.last_error IS DISTINCT FROM OLD.last_error
       OR NEW.terminal_evidence IS NOT NULL THEN
      RAISE EXCEPTION 'claiming a publication operation requires a fresh attempt and lease';
    END IF;
    IF NEW.lease_expires_at <= database_now THEN
      RAISE EXCEPTION 'publication claims require a lease that expires after the database clock';
    END IF;
    SELECT NOT EXISTS (
      SELECT 1
      FROM public.review_publication_operation_dependencies dependency
      JOIN public.review_publication_operations predecessor
        ON predecessor.repository_id = dependency.repository_id
       AND predecessor.pr_number = dependency.pr_number
       AND predecessor.publication_generation = dependency.publication_generation
       AND predecessor.operation_key = dependency.dependency_operation_key
      WHERE dependency.repository_id = OLD.repository_id
        AND dependency.pr_number = OLD.pr_number
        AND dependency.publication_generation = OLD.publication_generation
        AND dependency.operation_key = OLD.operation_key
        AND predecessor.state NOT IN ('applied', 'skipped', 'superseded', 'failed')
    ) INTO dependencies_terminal;
    IF NOT EXISTS (
      SELECT 1
      FROM public.pull_request_publication_high_waters high_water
      JOIN public.review_publication_generations generation
        ON generation.repository_id = high_water.repository_id
       AND generation.pr_number = high_water.pr_number
       AND generation.publication_generation = high_water.publication_generation
      WHERE high_water.repository_id = OLD.repository_id
        AND high_water.pr_number = OLD.pr_number
        AND high_water.publication_generation = OLD.publication_generation
        AND generation.sealed_at IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'only the current sealed publication generation can be claimed';
    END IF;
    SELECT COALESCE(bool_or(
      CASE condition->>'condition'
        WHEN 'always' THEN condition = jsonb_build_object('condition', 'always')
        WHEN 'markerAbsent' THEN public.postil_has_exact_json_keys(condition, ARRAY['condition', 'guard'])
        WHEN 'findingContentDiffers' THEN public.postil_has_exact_json_keys(
          condition, ARRAY['condition', 'observedCommentId', 'expectedMarkers']
        )
        WHEN 'allDependenciesTerminal' THEN condition = jsonb_build_object('condition', 'allDependenciesTerminal')
          AND dependencies_terminal
        WHEN 'semanticPlacementRejected' THEN EXISTS (
          SELECT 1
          FROM public.review_publication_operations predecessor
          WHERE predecessor.repository_id = OLD.repository_id
            AND predecessor.pr_number = OLD.pr_number
            AND predecessor.publication_generation = OLD.publication_generation
            AND predecessor.operation_key = condition->>'dependencyOperationKey'
            AND predecessor.state = 'failed'
            AND predecessor.terminal_evidence @> jsonb_build_object(
              'httpStatus', condition->'httpStatus',
              'classification', condition->'classification'
            )
        )
        WHEN 'partialReviewObserved' THEN EXISTS (
          SELECT 1
          FROM public.review_publication_operations predecessor
          JOIN public.review_publication_operation_attempts evidence
            ON evidence.repository_id = predecessor.repository_id
           AND evidence.pr_number = predecessor.pr_number
           AND evidence.publication_generation = predecessor.publication_generation
           AND evidence.operation_key = predecessor.operation_key
           AND evidence.attempt_number = predecessor.attempt_count
           AND evidence.lease_generation = predecessor.lease_generation
           AND evidence.phase = 'applied'
          WHERE predecessor.repository_id = OLD.repository_id
            AND predecessor.pr_number = OLD.pr_number
            AND predecessor.publication_generation = OLD.publication_generation
            AND predecessor.operation_key = condition->>'dependencyOperationKey'
            AND predecessor.state = 'applied'
            AND evidence.evidence_payload @> jsonb_build_object('reviewMarkers', condition->'reviewMarkers')
        )
        WHEN 'reviewSelectionTerminal' THEN NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(condition->'selectedReviewOperationKeys') selected(operation_key)
          LEFT JOIN public.review_publication_operations predecessor
            ON predecessor.repository_id = OLD.repository_id
           AND predecessor.pr_number = OLD.pr_number
           AND predecessor.publication_generation = OLD.publication_generation
           AND predecessor.operation_key = selected.operation_key
          WHERE predecessor.operation_key IS NULL
             OR predecessor.state NOT IN ('applied', 'skipped', 'superseded', 'failed')
        )
        ELSE false
      END
    ), false)
    INTO activation_eligible
    FROM jsonb_array_elements(OLD.activation->'anyOf') condition;
    IF NOT dependencies_terminal OR NOT activation_eligible THEN
      RAISE EXCEPTION 'publication claim requires terminal dependencies and immutable activation evidence';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.state = 'pending' AND NEW.state IN ('skipped', 'superseded', 'failed') THEN
    IF NEW.state = 'superseded'
       AND has_controller_supersession
       AND public.postil_publication_controller_supersession_authorized(
         OLD.repository_id,
         OLD.pr_number,
         OLD.publication_generation
       )
       AND NEW.attempt_count = OLD.attempt_count + 1
       AND NEW.lease_generation = OLD.lease_generation + 1
       AND NEW.selected_variant = 'controller-supersession'
       AND NEW.terminal_evidence IS NOT DISTINCT FROM (
         SELECT evidence_payload
         FROM public.review_publication_operation_attempts
         WHERE repository_id = OLD.repository_id
           AND pr_number = OLD.pr_number
           AND publication_generation = OLD.publication_generation
           AND operation_key = OLD.operation_key
           AND attempt_number = NEW.attempt_count
           AND lease_generation = NEW.lease_generation
           AND phase = 'not_dispatched'
       ) THEN
      RETURN NEW;
    END IF;
    IF NEW.attempt_count <> OLD.attempt_count
       OR NEW.lease_generation <> OLD.lease_generation
       OR NEW.selected_variant IS NOT NULL THEN
      RAISE EXCEPTION 'unclaimed terminal publication operations cannot add attempt state';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.state = 'applying' AND NEW.state = 'pending' THEN
    IF NOT has_not_dispatched
       OR NEW.attempt_count <> OLD.attempt_count
       OR NEW.lease_generation <> OLD.lease_generation
       OR NEW.selected_variant IS NOT NULL
       OR NEW.terminal_evidence IS NOT NULL THEN
      RAISE EXCEPTION 'retrying an applying operation requires exact not-dispatched evidence';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.state = 'applying' AND NEW.state = 'unknown' THEN
    IF NOT has_ambiguous
       OR NEW.attempt_count <> OLD.attempt_count
       OR NEW.lease_generation <> OLD.lease_generation
       OR NEW.selected_variant IS DISTINCT FROM OLD.selected_variant
       OR NEW.last_error IS DISTINCT FROM (
         SELECT error_reason
         FROM public.review_publication_operation_attempts
         WHERE repository_id = OLD.repository_id
           AND pr_number = OLD.pr_number
           AND publication_generation = OLD.publication_generation
           AND operation_key = OLD.operation_key
           AND attempt_number = OLD.attempt_count
           AND lease_generation = OLD.lease_generation
           AND phase = 'ambiguous'
       ) THEN
      RAISE EXCEPTION 'unknown publication state requires matching ambiguous attempt evidence';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.state = 'applying' AND NEW.state = 'applied' THEN
    IF NOT has_applied
       OR NEW.attempt_count <> OLD.attempt_count
       OR NEW.lease_generation <> OLD.lease_generation
       OR NEW.selected_variant IS DISTINCT FROM OLD.selected_variant THEN
      RAISE EXCEPTION 'applied publication state requires exact applied attempt evidence';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.state = 'applying' AND NEW.state = 'superseded' THEN
    IF NOT has_not_dispatched
       OR NEW.attempt_count <> OLD.attempt_count
       OR NEW.lease_generation <> OLD.lease_generation
       OR NEW.selected_variant IS DISTINCT FROM OLD.selected_variant THEN
      RAISE EXCEPTION 'terminating an applying operation requires proof no mutation was dispatched';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.state = 'applying' AND NEW.state = 'failed' THEN
    IF has_rejected THEN
      IF NEW.attempt_count <> OLD.attempt_count
         OR NEW.lease_generation <> OLD.lease_generation
         OR NEW.selected_variant IS DISTINCT FROM OLD.selected_variant
         OR NEW.last_error IS DISTINCT FROM (
           SELECT error_reason
           FROM public.review_publication_operation_attempts
           WHERE repository_id = OLD.repository_id
             AND pr_number = OLD.pr_number
             AND publication_generation = OLD.publication_generation
             AND operation_key = OLD.operation_key
             AND attempt_number = OLD.attempt_count
             AND lease_generation = OLD.lease_generation
             AND phase = 'rejected'
         )
         OR NEW.terminal_evidence IS DISTINCT FROM (
           SELECT evidence_payload
           FROM public.review_publication_operation_attempts
           WHERE repository_id = OLD.repository_id
             AND pr_number = OLD.pr_number
             AND publication_generation = OLD.publication_generation
             AND operation_key = OLD.operation_key
             AND attempt_number = OLD.attempt_count
             AND lease_generation = OLD.lease_generation
             AND phase = 'rejected'
         ) THEN
        RAISE EXCEPTION 'rejected publication state requires exact rejection evidence';
      END IF;
      RETURN NEW;
    END IF;
    IF NOT has_not_dispatched
       OR NEW.attempt_count <> OLD.attempt_count
       OR NEW.lease_generation <> OLD.lease_generation
       OR NEW.selected_variant IS DISTINCT FROM OLD.selected_variant THEN
      RAISE EXCEPTION 'terminating an applying operation requires proof no mutation was dispatched';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.state = 'unknown' AND NEW.state = 'pending' THEN
    IF NOT has_retry_absence
       OR NEW.attempt_count <> OLD.attempt_count
       OR NEW.lease_generation <> OLD.lease_generation
       OR NEW.selected_variant IS NOT NULL THEN
      RAISE EXCEPTION 'retrying an ambiguous operation requires fresh exact-absence reconciliation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.state = 'unknown' AND NEW.state = 'applied' THEN
    IF NOT has_terminal_applied
       OR NEW.attempt_count <> OLD.attempt_count
       OR NEW.lease_generation <> OLD.lease_generation
       OR NEW.selected_variant IS DISTINCT FROM OLD.selected_variant THEN
      RAISE EXCEPTION 'applied reconciliation must match the ambiguous attempt';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.state = 'unknown' AND NEW.state IN ('superseded', 'failed') THEN
    IF NOT has_terminal_absence
       OR NEW.attempt_count <> OLD.attempt_count
       OR NEW.lease_generation <> OLD.lease_generation
       OR NEW.selected_variant IS DISTINCT FROM OLD.selected_variant THEN
      RAISE EXCEPTION 'terminal ambiguous operations require exact-absence reconciliation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid publication operation state transition from % to %', OLD.state, NEW.state;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "postil_guard_review_publication_operation_attempt"()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  operation_row public.review_publication_operations%ROWTYPE;
  claimed_at timestamp with time zone;
  database_now timestamp with time zone := pg_catalog.clock_timestamp();
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.repositories WHERE id = OLD.repository_id) THEN
      RAISE EXCEPTION 'review publication operation attempts are append-only';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'review publication operation attempts are append-only';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(NEW.repository_id::text || ':' || NEW.pr_number::text, 0)
  );
  SELECT * INTO operation_row
  FROM public.review_publication_operations
  WHERE repository_id = NEW.repository_id
    AND pr_number = NEW.pr_number
    AND publication_generation = NEW.publication_generation
    AND operation_key = NEW.operation_key
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.review_publication_generations
    WHERE repository_id = NEW.repository_id
      AND pr_number = NEW.pr_number
      AND publication_generation = NEW.publication_generation
      AND sealed_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'publication attempt evidence requires a sealed generation';
  END IF;
  IF NEW.observed_at < database_now - interval '5 minutes'
     OR NEW.observed_at > database_now + interval '1 second'
     OR NEW.created_at < database_now - interval '5 minutes'
     OR NEW.created_at > database_now + interval '1 second' THEN
    RAISE EXCEPTION 'publication attempt evidence timestamps must be fresh database-time observations';
  END IF;

  IF NEW.phase = 'claimed' THEN
    IF operation_row.state <> 'applying'
       OR operation_row.attempt_count <> NEW.attempt_number
       OR operation_row.lease_generation <> NEW.lease_generation
       OR operation_row.selected_variant IS DISTINCT FROM NEW.selected_variant
       OR NEW.observed_at <> operation_row.updated_at
       OR NEW.created_at <> NEW.observed_at THEN
      RAISE EXCEPTION 'claimed attempt evidence is recorded atomically with its lease';
    END IF;
    UPDATE public.review_publication_operations
    SET evidence_generation = evidence_generation + 1
    WHERE id = operation_row.id;
    RETURN NEW;
  END IF;

  IF operation_row.state = 'pending'
     AND NEW.phase = 'not_dispatched'
     AND public.postil_publication_controller_supersession_authorized(
       NEW.repository_id,
       NEW.pr_number,
       NEW.publication_generation
     )
     AND NEW.attempt_number = operation_row.attempt_count + 1
     AND NEW.lease_generation = operation_row.lease_generation + 1
     AND NEW.selected_variant = 'controller-supersession'
     AND NEW.evidence_payload->>'outcome' = 'superseded'
     AND NEW.evidence_payload->'result'->>'dispatched' = 'false' THEN
    UPDATE public.review_publication_operations
    SET evidence_generation = evidence_generation + 1
    WHERE id = operation_row.id;
    RETURN NEW;
  END IF;

  IF operation_row.state <> 'applying'
     OR operation_row.attempt_count <> NEW.attempt_number
     OR operation_row.lease_generation <> NEW.lease_generation
     OR operation_row.selected_variant IS DISTINCT FROM NEW.selected_variant THEN
    RAISE EXCEPTION 'attempt evidence must match the active publication lease';
  END IF;
  SELECT observed_at INTO claimed_at
  FROM public.review_publication_operation_attempts
  WHERE repository_id = NEW.repository_id
    AND pr_number = NEW.pr_number
    AND publication_generation = NEW.publication_generation
    AND operation_key = NEW.operation_key
    AND attempt_number = NEW.attempt_number
    AND lease_generation = NEW.lease_generation
    AND phase = 'claimed';
  IF claimed_at IS NULL OR NEW.observed_at < claimed_at THEN
    RAISE EXCEPTION 'attempt evidence requires its preceding claim';
  END IF;

  UPDATE public.review_publication_operations
  SET evidence_generation = evidence_generation + 1
  WHERE id = operation_row.id;

  IF NEW.phase = 'dispatched' THEN
    IF EXISTS (
      SELECT 1 FROM public.review_publication_operation_attempts
      WHERE repository_id = NEW.repository_id
        AND pr_number = NEW.pr_number
        AND publication_generation = NEW.publication_generation
        AND operation_key = NEW.operation_key
        AND attempt_number = NEW.attempt_number
        AND lease_generation = NEW.lease_generation
        AND phase = 'not_dispatched'
    ) THEN
      RAISE EXCEPTION 'a not-dispatched attempt cannot later be dispatched';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.phase = 'not_dispatched' THEN
    IF EXISTS (
      SELECT 1 FROM public.review_publication_operation_attempts
      WHERE repository_id = NEW.repository_id
        AND pr_number = NEW.pr_number
        AND publication_generation = NEW.publication_generation
        AND operation_key = NEW.operation_key
        AND attempt_number = NEW.attempt_number
        AND lease_generation = NEW.lease_generation
        AND phase IN ('dispatched', 'ambiguous', 'applied', 'rejected')
    ) THEN
      RAISE EXCEPTION 'dispatched attempts require remote outcome evidence';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.phase = 'ambiguous' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.review_publication_operation_attempts
      WHERE repository_id = NEW.repository_id
        AND pr_number = NEW.pr_number
        AND publication_generation = NEW.publication_generation
        AND operation_key = NEW.operation_key
        AND attempt_number = NEW.attempt_number
        AND lease_generation = NEW.lease_generation
        AND phase = 'dispatched' AND observed_at <= NEW.observed_at
    ) OR EXISTS (
      SELECT 1 FROM public.review_publication_operation_attempts
      WHERE repository_id = NEW.repository_id
        AND pr_number = NEW.pr_number
        AND publication_generation = NEW.publication_generation
        AND operation_key = NEW.operation_key
        AND attempt_number = NEW.attempt_number
        AND lease_generation = NEW.lease_generation
        AND phase IN ('applied', 'rejected')
    ) THEN
      RAISE EXCEPTION 'ambiguous evidence requires a dispatched attempt without terminal proof';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.phase = 'rejected' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.review_publication_operation_attempts
      WHERE repository_id = NEW.repository_id
        AND pr_number = NEW.pr_number
        AND publication_generation = NEW.publication_generation
        AND operation_key = NEW.operation_key
        AND attempt_number = NEW.attempt_number
        AND lease_generation = NEW.lease_generation
        AND phase = 'dispatched' AND observed_at <= NEW.observed_at
    ) OR EXISTS (
      SELECT 1 FROM public.review_publication_operation_attempts
      WHERE repository_id = NEW.repository_id
        AND pr_number = NEW.pr_number
        AND publication_generation = NEW.publication_generation
        AND operation_key = NEW.operation_key
        AND attempt_number = NEW.attempt_number
        AND lease_generation = NEW.lease_generation
        AND phase IN ('ambiguous', 'applied')
    ) THEN
      RAISE EXCEPTION 'rejected attempt evidence requires an unambiguous dispatch';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.phase = 'applied' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.review_publication_operation_attempts
      WHERE repository_id = NEW.repository_id
        AND pr_number = NEW.pr_number
        AND publication_generation = NEW.publication_generation
        AND operation_key = NEW.operation_key
        AND attempt_number = NEW.attempt_number
        AND lease_generation = NEW.lease_generation
        AND phase = 'dispatched' AND observed_at <= NEW.observed_at
    ) OR EXISTS (
      SELECT 1 FROM public.review_publication_operation_attempts
      WHERE repository_id = NEW.repository_id
        AND pr_number = NEW.pr_number
        AND publication_generation = NEW.publication_generation
        AND operation_key = NEW.operation_key
        AND attempt_number = NEW.attempt_number
        AND lease_generation = NEW.lease_generation
        AND phase IN ('ambiguous', 'rejected')
    ) THEN
      RAISE EXCEPTION 'applied attempt evidence requires an unambiguous dispatch';
    END IF;
    RETURN NEW;
  END IF;
  RETURN NEW;
END;
$$;
