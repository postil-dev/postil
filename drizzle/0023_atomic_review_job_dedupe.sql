CREATE FUNCTION "suppress_duplicate_active_review_job"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  repo_full_name text;
  pull_request_number text;
  head_sha text;
  review_identity text;
BEGIN
  IF NEW."kind" <> 'review' OR NEW."status" NOT IN ('queued', 'running') THEN
    RETURN NEW;
  END IF;

  repo_full_name := NEW."payload"->>'repoFullName';
  pull_request_number := NEW."payload"->>'prNumber';
  head_sha := NEW."payload"->>'headSha';
  IF repo_full_name IS NULL OR pull_request_number IS NULL OR head_sha IS NULL THEN
    RETURN NEW;
  END IF;

  review_identity := repo_full_name || chr(31) || pull_request_number || chr(31) || head_sha;
  PERFORM pg_advisory_xact_lock(
    hashtextextended('postil:active-review:' || review_identity, 0)
  );
  IF EXISTS (
    SELECT 1
      FROM "jobs"
     WHERE "kind" = 'review'
       AND "status" IN ('queued', 'running')
       AND "id" IS DISTINCT FROM NEW."id"
       AND "payload"->>'repoFullName' = repo_full_name
       AND "payload"->>'prNumber' = pull_request_number
       AND "payload"->>'headSha' = head_sha
  ) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "jobs_suppress_duplicate_active_review_trigger"
  BEFORE INSERT OR UPDATE OF "kind", "payload", "status" ON "jobs"
  FOR EACH ROW EXECUTE FUNCTION "suppress_duplicate_active_review_job"();

WITH ranked_active_reviews AS (
  SELECT "id",
         row_number() OVER (
           PARTITION BY "payload"->>'repoFullName',
                        "payload"->>'prNumber',
                        "payload"->>'headSha'
           ORDER BY CASE WHEN "status" = 'running' THEN 0 ELSE 1 END, "id"
         ) AS duplicate_position
    FROM "jobs"
   WHERE "kind" = 'review'
     AND "status" IN ('queued', 'running')
     AND "payload"->>'repoFullName' IS NOT NULL
     AND "payload"->>'prNumber' IS NOT NULL
     AND "payload"->>'headSha' IS NOT NULL
)
UPDATE "jobs" AS duplicate_job
   SET "status" = 'failed',
       "locked_at" = NULL,
       "locked_by" = NULL,
       "last_error" = 'duplicate active review suppressed by repository, pull request, and head identity',
       "run_after" = now()
  FROM ranked_active_reviews
 WHERE duplicate_job."id" = ranked_active_reviews."id"
   AND ranked_active_reviews.duplicate_position > 1;
