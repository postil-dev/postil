-- Legacy transaction-pool workers can leave the session-level lifecycle lock
-- attached to an idle Supavisor backend after the logical client returns to
-- the pool. Retire only those exact idle holders before replacing the lock
-- protocol. Active sessions and every unrelated advisory lock remain untouched.
DO $$
DECLARE
  stale_pid integer;
  cleanup_deadline timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  LOOP
    PERFORM pg_stat_clear_snapshot();
    stale_pid := NULL;
    SELECT advisory.pid
    INTO stale_pid
    FROM pg_locks AS advisory
    INNER JOIN pg_stat_activity AS activity ON activity.pid = advisory.pid
    WHERE advisory.locktype = 'advisory'
      AND advisory.granted
      AND advisory.mode IN ('ShareLock', 'ExclusiveLock')
      AND advisory.objsubid = 1
      AND activity.datname = current_database()
      AND activity.usename = current_user
      AND advisory.classid::bigint = (
        (hashtextextended('postil:publication-lifecycle-release', 0) >> 32)
        & 4294967295
      )
      AND advisory.objid::bigint = (
        hashtextextended('postil:publication-lifecycle-release', 0)
        & 4294967295
      )
      AND advisory.pid <> pg_backend_pid()
      AND activity.application_name = 'Supavisor'
      AND activity.state = 'idle'
    ORDER BY advisory.pid
    LIMIT 1;

    IF stale_pid IS NOT NULL THEN
      PERFORM pg_terminate_backend(stale_pid);
      PERFORM pg_sleep(0.05);
      CONTINUE;
    END IF;

    EXIT WHEN NOT EXISTS (
      SELECT 1
      FROM pg_locks AS advisory
      INNER JOIN pg_stat_activity AS activity ON activity.pid = advisory.pid
      WHERE advisory.locktype = 'advisory'
        AND advisory.granted
        AND advisory.mode IN ('ShareLock', 'ExclusiveLock')
        AND advisory.objsubid = 1
        AND activity.datname = current_database()
        AND activity.usename = current_user
        AND advisory.classid::bigint = (
          (hashtextextended('postil:publication-lifecycle-release', 0) >> 32)
          & 4294967295
        )
        AND advisory.objid::bigint = (
          hashtextextended('postil:publication-lifecycle-release', 0)
          & 4294967295
        )
        AND advisory.pid <> pg_backend_pid()
        AND activity.application_name = 'Supavisor'
    );

    IF clock_timestamp() >= cleanup_deadline THEN
      RAISE EXCEPTION 'active legacy publication lifecycle lock did not quiesce';
    END IF;
    PERFORM pg_sleep(0.1);
  END LOOP;
END;
$$;--> statement-breakpoint
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
  lifecycle_locked boolean := false;
  lifecycle_active boolean := false;
BEGIN
  -- A failed try-lock means deactivation owns or is queued for the boundary.
  -- Park the job without waiting while its caller may hold narrower locks.
  lifecycle_locked := pg_try_advisory_xact_lock_shared(
    hashtextextended('postil:publication-lifecycle-release', 0)
  );
  IF lifecycle_locked THEN
    SELECT EXISTS (
      SELECT 1 FROM deployment_capabilities
      WHERE name = 'publication-lifecycle-fleet-active'
    ) INTO lifecycle_active;
  END IF;
  IF NOT lifecycle_active THEN
    NEW.run_after := CASE
      WHEN lifecycle_locked THEN 'infinity'::timestamptz
      ELSE now() + interval '30 seconds'
    END;
    NEW.payload := jsonb_set(
      COALESCE(NEW.payload, '{}'::jsonb),
      '{_postilPublicationLifecycleDark}',
      'true'::jsonb,
      true
    );
  ELSE
    NEW.payload := COALESCE(NEW.payload, '{}'::jsonb)
      - '_postilPublicationLifecycleDark';
  END IF;
  RETURN NEW;
END;
$$;
