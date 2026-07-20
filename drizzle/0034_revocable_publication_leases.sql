ALTER TABLE "reviews"
  ADD COLUMN "source_org_id" bigint,
  ADD COLUMN "source_installation_id" bigint,
  ADD COLUMN "source_github_installation_id" bigint,
  ADD COLUMN "source_github_repo_id" bigint,
  ADD COLUMN "source_repo_full_name" text;

UPDATE "reviews" review
SET "source_org_id" = installation."org_id",
    "source_installation_id" = installation."id",
    "source_github_installation_id" = installation."github_installation_id",
    "source_github_repo_id" = repository."github_repo_id",
    "source_repo_full_name" = repository."full_name"
FROM "repositories" repository
JOIN "installations" installation ON installation."id" = repository."installation_id"
WHERE repository."id" = review."repository_id";

CREATE FUNCTION "postil_guard_review_publication_identity"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."repository_id" IS DISTINCT FROM OLD."repository_id"
     OR NEW."pr_number" IS DISTINCT FROM OLD."pr_number"
     OR NEW."head_sha" IS DISTINCT FROM OLD."head_sha"
     OR NEW."base_sha" IS DISTINCT FROM OLD."base_sha"
     OR NEW."source_org_id" IS DISTINCT FROM OLD."source_org_id"
     OR NEW."source_installation_id" IS DISTINCT FROM OLD."source_installation_id"
     OR NEW."source_github_installation_id" IS DISTINCT FROM OLD."source_github_installation_id"
     OR NEW."source_github_repo_id" IS DISTINCT FROM OLD."source_github_repo_id"
     OR NEW."source_repo_full_name" IS DISTINCT FROM OLD."source_repo_full_name" THEN
    RAISE EXCEPTION 'review publication identity is immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "reviews_guard_publication_identity"
BEFORE UPDATE ON "reviews"
FOR EACH ROW EXECUTE FUNCTION "postil_guard_review_publication_identity"();

UPDATE "jobs" job
SET "payload" = job."payload" || jsonb_build_object(
  'sourceOrgId', installation."org_id",
  'sourceInstallationId', installation."id",
  'githubRepoId', repository."github_repo_id"
)
FROM "installations" installation
JOIN "repositories" repository ON repository."installation_id" = installation."id"
WHERE job."kind" IN ('review', 'respond', 'respond-failure-comment', 'webhook-comment')
  AND job."status" IN ('queued', 'running')
  AND job."payload"->>'installationId' = installation."github_installation_id"::text
  AND lower(job."payload"->>'repoFullName') = lower(repository."full_name");

UPDATE "jobs"
SET "status" = 'failed',
    "locked_at" = NULL,
    "locked_by" = NULL,
    "last_error" = 'publication job lacks immutable source identity'
WHERE "kind" IN ('review', 'respond', 'respond-failure-comment', 'webhook-comment')
  AND "status" IN ('queued', 'running')
  AND (
    "payload"->>'sourceOrgId' IS NULL OR
    "payload"->>'sourceInstallationId' IS NULL OR
    "payload"->>'githubRepoId' IS NULL OR
    (
      "kind" IN ('respond', 'respond-failure-comment', 'webhook-comment')
      AND (
        jsonb_typeof("payload"->'isPr') IS DISTINCT FROM 'boolean' OR
        ("payload"->>'isPr')::boolean AND "payload"->>'sourceHeadSha' IS NULL
      )
    )
  );

CREATE FUNCTION "postil_guard_job_publication_identity"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."kind" IN ('review', 'respond', 'respond-failure-comment', 'webhook-comment')
     AND (
       NEW."kind" IS DISTINCT FROM OLD."kind" OR
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

CREATE TRIGGER "jobs_guard_publication_identity"
BEFORE UPDATE ON "jobs"
FOR EACH ROW EXECUTE FUNCTION "postil_guard_job_publication_identity"();

ALTER TABLE "respond_deliveries"
  ADD COLUMN "source_org_id" bigint,
  ADD COLUMN "source_installation_id" bigint,
  ADD COLUMN "source_github_installation_id" bigint,
  ADD COLUMN "source_github_repo_id" bigint,
  ADD COLUMN "is_pr" boolean NOT NULL DEFAULT false,
  ADD COLUMN "source_head_sha" text,
  ADD COLUMN "publication_lease_id" uuid,
  ADD COLUMN "publication_lease_expires_at" timestamptz,
  ADD COLUMN "cancelled_at" timestamptz;

UPDATE "respond_deliveries" delivery
SET "source_org_id" = installation."org_id",
    "source_installation_id" = installation."id",
    "source_github_installation_id" = installation."github_installation_id",
    "source_github_repo_id" = repository."github_repo_id",
    "is_pr" = COALESCE((job."payload"->>'isPr')::boolean, false)
FROM "jobs" job, "repositories" repository
JOIN "installations" installation ON installation."id" = repository."installation_id"
WHERE job."id" = delivery."job_id"
  AND repository."id" = delivery."repository_id";

ALTER TABLE "respond_deliveries"
  DROP CONSTRAINT "respond_deliveries_state_check",
  ADD CONSTRAINT "respond_deliveries_state_check"
    CHECK ("state" IN ('prepared', 'delivering', 'delivered', 'cancelled'));

UPDATE "respond_deliveries"
SET "state" = 'cancelled', "cancelled_at" = now()
WHERE "state" IN ('prepared', 'delivering')
  AND (
    "source_org_id" IS NULL OR
    "source_installation_id" IS NULL OR
    "source_github_installation_id" IS NULL OR
    "source_github_repo_id" IS NULL OR
    ("is_pr" AND "source_head_sha" IS NULL)
  );

ALTER TABLE "respond_deliveries"
  ADD CONSTRAINT "respond_deliveries_pr_head_check"
    CHECK (NOT "is_pr" OR "source_head_sha" IS NOT NULL OR "state" = 'cancelled');

CREATE FUNCTION "postil_guard_respond_publication_identity"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."repository_id" IS DISTINCT FROM OLD."repository_id"
     OR NEW."repo_full_name" IS DISTINCT FROM OLD."repo_full_name"
     OR NEW."issue_number" IS DISTINCT FROM OLD."issue_number"
     OR NEW."source_org_id" IS DISTINCT FROM OLD."source_org_id"
     OR NEW."source_installation_id" IS DISTINCT FROM OLD."source_installation_id"
     OR NEW."source_github_installation_id" IS DISTINCT FROM OLD."source_github_installation_id"
     OR NEW."source_github_repo_id" IS DISTINCT FROM OLD."source_github_repo_id"
     OR NEW."is_pr" IS DISTINCT FROM OLD."is_pr"
     OR NEW."source_head_sha" IS DISTINCT FROM OLD."source_head_sha" THEN
    RAISE EXCEPTION 'respond publication identity is immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "respond_deliveries_guard_publication_identity"
BEFORE UPDATE ON "respond_deliveries"
FOR EACH ROW EXECUTE FUNCTION "postil_guard_respond_publication_identity"();

CREATE INDEX "respond_deliveries_pr_identity_idx"
  ON "respond_deliveries" (
    "source_github_installation_id",
    "source_github_repo_id",
    "issue_number",
    "source_head_sha"
  ) WHERE "is_pr" AND "state" IN ('prepared', 'delivering');
