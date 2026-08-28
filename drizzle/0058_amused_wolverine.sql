SELECT pg_advisory_xact_lock(hashtextextended('postil:publication-lifecycle-release', 0));--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "publication_lifecycle_reconciled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "publication_lifecycle_required_at" timestamp with time zone;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "postil_require_publication_lifecycle"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('postil:publication-lifecycle-release', 0));
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
CREATE TRIGGER "reviews_require_publication_lifecycle"
BEFORE INSERT OR UPDATE OF status, envelope ON "reviews"
FOR EACH ROW
EXECUTE FUNCTION "postil_require_publication_lifecycle"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "postil_stage_gate_sync_until_publication_lifecycle_activation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('postil:publication-lifecycle-release', 0));
  IF NOT EXISTS (
    SELECT 1 FROM deployment_capabilities
    WHERE name = 'publication-lifecycle-fleet-active'
  ) THEN
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
$$;--> statement-breakpoint
CREATE TRIGGER "jobs_stage_gate_sync_until_publication_lifecycle_activation"
BEFORE INSERT OR UPDATE OF kind, payload, run_after ON "jobs"
FOR EACH ROW
WHEN (NEW.kind = 'gate-state-sync')
EXECUTE FUNCTION "postil_stage_gate_sync_until_publication_lifecycle_activation"();--> statement-breakpoint
UPDATE "jobs"
SET "run_after" = 'infinity'::timestamptz,
    "payload" = jsonb_set(
      COALESCE("payload", '{}'::jsonb),
      '{_postilPublicationLifecycleDark}',
      'true'::jsonb,
      true
    )
WHERE "kind" = 'gate-state-sync'
  AND "status" = 'queued';
