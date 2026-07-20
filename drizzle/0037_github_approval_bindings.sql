ALTER TABLE "finding_approvals" ADD COLUMN "source_org_id" bigint;--> statement-breakpoint
ALTER TABLE "finding_approvals" ADD COLUMN "source_repository_id" bigint;--> statement-breakpoint
ALTER TABLE "finding_approvals" ADD COLUMN "source_github_installation_id" bigint;--> statement-breakpoint
ALTER TABLE "finding_approvals" ADD COLUMN "source_github_repo_id" bigint;--> statement-breakpoint
ALTER TABLE "finding_approvals" ADD COLUMN "source_pr_number" integer;--> statement-breakpoint
ALTER TABLE "finding_approvals" ADD COLUMN "source_head_sha" text;--> statement-breakpoint
ALTER TABLE "finding_approvals" ADD COLUMN "source_webhook_delivery_id" text;--> statement-breakpoint
ALTER TABLE "finding_approvals" ADD COLUMN "source_github_comment_id" bigint;--> statement-breakpoint
ALTER TABLE "finding_approvals" ADD COLUMN "source_comment_kind" text;--> statement-breakpoint
UPDATE "finding_approvals" approval
SET "source_org_id" = review."source_org_id",
    "source_repository_id" = review."repository_id",
    "source_github_installation_id" = review."source_github_installation_id",
    "source_github_repo_id" = review."source_github_repo_id",
    "source_pr_number" = review."pr_number",
    "source_head_sha" = review."head_sha"
FROM "reviews" review
WHERE review."id" = approval."review_id"
  AND review."source_org_id" IS NOT NULL
  AND review."source_github_installation_id" IS NOT NULL
  AND review."source_github_repo_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY "finding_approvals_github_comment_idx" ON "finding_approvals" USING btree ("source_github_installation_id","source_github_repo_id","source_comment_kind","source_github_comment_id") WHERE "finding_approvals"."source" = 'github';--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY "finding_approvals_github_delivery_idx" ON "finding_approvals" USING btree ("source_webhook_delivery_id") WHERE "finding_approvals"."source" = 'github';--> statement-breakpoint
ALTER TABLE "finding_approvals" ADD CONSTRAINT "finding_approvals_binding_check" CHECK (
  (
    "source_org_id" IS NULL
    AND "source_repository_id" IS NULL
    AND "source_github_installation_id" IS NULL
    AND "source_github_repo_id" IS NULL
    AND "source_pr_number" IS NULL
    AND "source_head_sha" IS NULL
  )
  OR (
    "source_org_id" > 0
    AND "source_repository_id" > 0
    AND "source_github_installation_id" > 0
    AND "source_github_repo_id" > 0
    AND "source_pr_number" > 0
    AND length(btrim("source_head_sha")) BETWEEN 1 AND 200
  )
) NOT VALID;--> statement-breakpoint
ALTER TABLE "finding_approvals" ADD CONSTRAINT "finding_approvals_github_source_check" CHECK (
  "source" <> 'github'
  OR (
    "source_webhook_delivery_id" IS NULL
    AND "source_github_comment_id" IS NULL
    AND "source_comment_kind" IS NULL
  )
  OR (
    length(btrim("source_webhook_delivery_id")) BETWEEN 1 AND 200
    AND "source_github_comment_id" > 0
    AND "source_comment_kind" IN ('issue_comment', 'pull_request_review_comment')
  )
) NOT VALID;--> statement-breakpoint
CREATE FUNCTION "postil_guard_finding_approval_identity"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NOT EXISTS (
    SELECT 1
    FROM "reviews" review
    WHERE review."id" = NEW."review_id"
      AND review."repository_id" = NEW."source_repository_id"
      AND review."source_org_id" = NEW."source_org_id"
      AND review."source_github_installation_id" = NEW."source_github_installation_id"
      AND review."source_github_repo_id" = NEW."source_github_repo_id"
      AND review."pr_number" = NEW."source_pr_number"
      AND review."head_sha" = NEW."source_head_sha"
  ) THEN
    RAISE EXCEPTION 'finding approval source identity does not match its review';
  END IF;

  IF TG_OP = 'INSERT' AND NEW."source" = 'github' AND (
    NULLIF(btrim(NEW."source_webhook_delivery_id"), '') IS NULL
    OR length(NEW."source_webhook_delivery_id") > 200
    OR NEW."source_github_comment_id" IS NULL
    OR NEW."source_github_comment_id" <= 0
    OR NEW."source_comment_kind" NOT IN ('issue_comment', 'pull_request_review_comment')
  ) THEN
    RAISE EXCEPTION 'GitHub finding approval provenance is incomplete';
  END IF;

  IF TG_OP = 'UPDATE' AND (
    NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."review_id" IS DISTINCT FROM OLD."review_id"
    OR NEW."finding_id" IS DISTINCT FROM OLD."finding_id"
    OR NEW."actor_user_id" IS DISTINCT FROM OLD."actor_user_id"
    OR NEW."actor_github_id" IS DISTINCT FROM OLD."actor_github_id"
    OR NEW."actor_login_snapshot" IS DISTINCT FROM OLD."actor_login_snapshot"
    OR NEW."actor_role_snapshot" IS DISTINCT FROM OLD."actor_role_snapshot"
    OR NEW."rationale" IS DISTINCT FROM OLD."rationale"
    OR NEW."source" IS DISTINCT FROM OLD."source"
    OR NEW."source_comment_id" IS DISTINCT FROM OLD."source_comment_id"
    OR NEW."source_url" IS DISTINCT FROM OLD."source_url"
    OR NEW."source_org_id" IS DISTINCT FROM OLD."source_org_id"
    OR NEW."source_repository_id" IS DISTINCT FROM OLD."source_repository_id"
    OR NEW."source_github_installation_id" IS DISTINCT FROM OLD."source_github_installation_id"
    OR NEW."source_github_repo_id" IS DISTINCT FROM OLD."source_github_repo_id"
    OR NEW."source_pr_number" IS DISTINCT FROM OLD."source_pr_number"
    OR NEW."source_head_sha" IS DISTINCT FROM OLD."source_head_sha"
    OR NEW."source_webhook_delivery_id" IS DISTINCT FROM OLD."source_webhook_delivery_id"
    OR NEW."source_github_comment_id" IS DISTINCT FROM OLD."source_github_comment_id"
    OR NEW."source_comment_kind" IS DISTINCT FROM OLD."source_comment_kind"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  ) THEN
    RAISE EXCEPTION 'finding approval identity is immutable';
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD."source_org_id" IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM "reviews" review
       WHERE review."id" = NEW."review_id"
         AND review."repository_id" = NEW."source_repository_id"
         AND review."source_org_id" = NEW."source_org_id"
         AND review."source_github_installation_id" = NEW."source_github_installation_id"
         AND review."source_github_repo_id" = NEW."source_github_repo_id"
         AND review."pr_number" = NEW."source_pr_number"
         AND review."head_sha" = NEW."source_head_sha"
     ) THEN
    RAISE EXCEPTION 'finding approval source identity does not match its review';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "finding_approvals_guard_identity"
BEFORE INSERT OR UPDATE ON "finding_approvals"
FOR EACH ROW EXECUTE FUNCTION "postil_guard_finding_approval_identity"();
