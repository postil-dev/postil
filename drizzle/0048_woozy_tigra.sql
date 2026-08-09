CREATE TYPE "public"."finding_approval_verb" AS ENUM('approve', 'dismiss');--> statement-breakpoint
ALTER TABLE "finding_approvals" ADD COLUMN "verb" "finding_approval_verb" DEFAULT 'approve' NOT NULL;--> statement-breakpoint
ALTER TABLE "finding_approvals" ADD COLUMN "reason_tag" text;--> statement-breakpoint
ALTER TABLE "finding_approvals" ADD COLUMN "author_self_dismissal" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "finding_approvals" ADD COLUMN "finding_kind" text;--> statement-breakpoint
ALTER TABLE "finding_approvals" ADD COLUMN "finding_severity" text;--> statement-breakpoint
ALTER TABLE "finding_approvals" ADD COLUMN "finding_confidence" real;--> statement-breakpoint
ALTER TABLE "finding_approvals" ADD COLUMN "finding_model" text;--> statement-breakpoint
ALTER TABLE "finding_approvals" ADD CONSTRAINT "finding_approvals_dismissal_check" CHECK (("finding_approvals"."verb" = 'approve' AND "finding_approvals"."reason_tag" IS NULL AND "finding_approvals"."author_self_dismissal" = false AND "finding_approvals"."finding_kind" IS NULL AND "finding_approvals"."finding_severity" IS NULL AND "finding_approvals"."finding_confidence" IS NULL AND "finding_approvals"."finding_model" IS NULL) OR ("finding_approvals"."verb" = 'dismiss' AND "finding_approvals"."reason_tag" IS NOT NULL AND "finding_approvals"."reason_tag" IN ('false-positive', 'accepted-risk', 'out-of-scope') AND "finding_approvals"."finding_kind" IS NOT NULL AND "finding_approvals"."finding_severity" IS NOT NULL AND "finding_approvals"."finding_confidence" IS NOT NULL AND "finding_approvals"."finding_confidence" BETWEEN 0 AND 1 AND "finding_approvals"."finding_model" IS NOT NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "finding_approvals" VALIDATE CONSTRAINT "finding_approvals_dismissal_check";--> statement-breakpoint
CREATE FUNCTION "postil_guard_finding_dismissal_audit"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW."verb" = 'dismiss' AND (
    NEW."reason_tag" IS NULL OR NEW."reason_tag" NOT IN ('false-positive', 'accepted-risk', 'out-of-scope')
    OR NEW."finding_kind" IS NULL OR NEW."finding_severity" IS NULL
    OR NEW."finding_confidence" IS NULL OR NEW."finding_model" IS NULL
  ) THEN
    RAISE EXCEPTION 'finding dismissal audit is incomplete';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    NEW."verb" IS DISTINCT FROM OLD."verb" OR NEW."reason_tag" IS DISTINCT FROM OLD."reason_tag"
    OR NEW."author_self_dismissal" IS DISTINCT FROM OLD."author_self_dismissal"
    OR NEW."finding_kind" IS DISTINCT FROM OLD."finding_kind" OR NEW."finding_severity" IS DISTINCT FROM OLD."finding_severity"
    OR NEW."finding_confidence" IS DISTINCT FROM OLD."finding_confidence" OR NEW."finding_model" IS DISTINCT FROM OLD."finding_model"
  ) THEN
    RAISE EXCEPTION 'finding approval identity is immutable';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "finding_approvals_guard_dismissal_audit"
BEFORE INSERT OR UPDATE ON "finding_approvals"
FOR EACH ROW EXECUTE FUNCTION "postil_guard_finding_dismissal_audit"();
--> statement-breakpoint
LOCK TABLE "jobs" IN SHARE ROW EXCLUSIVE MODE;
CREATE OR REPLACE FUNCTION suppress_duplicate_active_review_job()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  repository_identity text;
  pull_request_number text;
  head_sha text;
  review_identity text;
BEGIN
  IF NEW.kind <> 'review' OR NEW.status NOT IN ('queued', 'running') THEN
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
  pull_request_number := NEW.payload->>'prNumber';
  head_sha := NEW.payload->>'headSha';

  IF repository_identity IS NULL OR pull_request_number IS NULL OR head_sha IS NULL THEN
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
  IF EXISTS (
    SELECT 1 FROM jobs existing
    WHERE existing.kind = 'review'
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
UPDATE "jobs"
SET "payload" = jsonb_set("jobs"."payload", '{githubRepoId}', to_jsonb("repositories"."github_repo_id"), true)
FROM "repositories"
WHERE "jobs"."kind" = 'review'
  AND "jobs"."status" IN ('queued', 'running')
  AND (
    jsonb_typeof("jobs"."payload"->'githubRepoId') = 'number'
    AND "jobs"."payload"->>'githubRepoId' ~ '^[1-9][0-9]*$'
  ) IS NOT TRUE
  AND "jobs"."payload"->>'repoFullName' = "repositories"."full_name";
UPDATE "jobs"
SET "status" = 'failed',
    "locked_at" = NULL,
    "locked_by" = NULL,
    "last_error" = 'legacy active review repository identity could not be resolved',
    "run_after" = now()
WHERE "kind" = 'review'
  AND "status" IN ('queued', 'running')
  AND (
    jsonb_typeof("payload"->'githubRepoId') = 'number'
    AND "payload"->>'githubRepoId' ~ '^[1-9][0-9]*$'
  ) IS NOT TRUE;
