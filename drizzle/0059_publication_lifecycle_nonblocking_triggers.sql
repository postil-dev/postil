SELECT pg_advisory_xact_lock(hashtextextended('postil:publication-lifecycle-release', 0));--> statement-breakpoint
CREATE OR REPLACE FUNCTION "postil_require_publication_lifecycle"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Include ordinary completions in release quiescence when possible, but do
  -- not wait behind a queued deactivation while the UPDATE already owns its
  -- review row. The lifecycle marker is monotonic and its gate is staged by
  -- the companion trigger below.
  PERFORM pg_try_advisory_xact_lock_shared(
    hashtextextended('postil:publication-lifecycle-release', 0)
  );
  IF NEW.publication_lifecycle_required_at IS NULL
     AND NEW.envelope IS NOT NULL
     AND NEW.status IN ('running', 'completed')
     AND (
       TG_OP = 'INSERT'
       OR OLD.envelope IS NULL
       OR OLD.status NOT IN ('running', 'completed')
       OR (
         NEW.status = 'completed'
         AND OLD.status IS DISTINCT FROM 'completed'
       )
     )
  THEN
    NEW.publication_lifecycle_required_at := now();
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "postil_stage_gate_sync_until_publication_lifecycle_activation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  lifecycle_active boolean := false;
BEGIN
  -- A failed try-lock means deactivation owns or is queued for the boundary.
  -- Park the job without waiting while its caller may hold narrower locks.
  IF pg_try_advisory_xact_lock_shared(
    hashtextextended('postil:publication-lifecycle-release', 0)
  ) THEN
    SELECT EXISTS (
      SELECT 1 FROM deployment_capabilities
      WHERE name = 'publication-lifecycle-fleet-active'
    ) INTO lifecycle_active;
  END IF;
  IF NOT lifecycle_active THEN
    NEW.run_after := 'infinity'::timestamptz;
    NEW.payload := jsonb_set(
      COALESCE(NEW.payload, '{}'::jsonb),
      '{_postilPublicationLifecycleDark}',
      'true'::jsonb,
      true
    );
  END IF;
  RETURN NEW;
END;
$$;
