ALTER TABLE "finding_approvals" DROP CONSTRAINT "finding_approvals_dismissal_check";--> statement-breakpoint
ALTER TABLE "finding_approvals" DROP CONSTRAINT "finding_approvals_github_source_check";--> statement-breakpoint
ALTER TABLE "finding_approvals" ADD COLUMN "finding_scorer_model" text;--> statement-breakpoint
ALTER TABLE "finding_approvals" ADD CONSTRAINT "finding_approvals_dismissal_check" CHECK (("finding_approvals"."verb" = 'approve' AND "finding_approvals"."reason_tag" IS NULL AND "finding_approvals"."author_self_dismissal" = false AND "finding_approvals"."finding_kind" IS NULL AND "finding_approvals"."finding_severity" IS NULL AND "finding_approvals"."finding_confidence" IS NULL AND "finding_approvals"."finding_model" IS NULL AND "finding_approvals"."finding_scorer_model" IS NULL) OR ("finding_approvals"."verb" = 'dismiss' AND "finding_approvals"."reason_tag" IS NOT NULL AND "finding_approvals"."reason_tag" IN ('false-positive', 'accepted-risk', 'out-of-scope') AND "finding_approvals"."finding_kind" IS NOT NULL AND length(btrim("finding_approvals"."finding_kind")) > 0 AND "finding_approvals"."finding_severity" IS NOT NULL AND length(btrim("finding_approvals"."finding_severity")) > 0 AND "finding_approvals"."finding_confidence" IS NOT NULL AND "finding_approvals"."finding_confidence" BETWEEN 0 AND 1 AND "finding_approvals"."finding_model" IS NOT NULL AND length(btrim("finding_approvals"."finding_model")) > 0 AND ("finding_approvals"."finding_scorer_model" IS NULL OR length(btrim("finding_approvals"."finding_scorer_model")) > 0))) NOT VALID;--> statement-breakpoint
ALTER TABLE "finding_approvals" VALIDATE CONSTRAINT "finding_approvals_dismissal_check";--> statement-breakpoint
ALTER TABLE "finding_approvals" ADD CONSTRAINT "finding_approvals_github_source_check" CHECK (("finding_approvals"."source" = 'github' AND (("finding_approvals"."source_webhook_delivery_id" IS NULL AND "finding_approvals"."source_github_comment_id" IS NULL AND "finding_approvals"."source_comment_kind" IS NULL) OR (length(btrim("finding_approvals"."source_webhook_delivery_id")) BETWEEN 1 AND 200 AND "finding_approvals"."source_github_comment_id" > 0 AND "finding_approvals"."source_comment_kind" IN ('issue_comment', 'pull_request_review_comment')))) OR ("finding_approvals"."source" = 'dashboard' AND "finding_approvals"."source_webhook_delivery_id" IS NULL AND "finding_approvals"."source_github_comment_id" IS NULL AND "finding_approvals"."source_comment_kind" IS NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "finding_approvals" VALIDATE CONSTRAINT "finding_approvals_github_source_check";--> statement-breakpoint
CREATE OR REPLACE FUNCTION "postil_guard_finding_dismissal_audit"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW."verb" = 'dismiss' AND (
    NEW."reason_tag" IS NULL OR NEW."reason_tag" NOT IN ('false-positive', 'accepted-risk', 'out-of-scope')
    OR NULLIF(btrim(NEW."finding_kind"), '') IS NULL OR NULLIF(btrim(NEW."finding_severity"), '') IS NULL
    OR NEW."finding_confidence" IS NULL OR NULLIF(btrim(NEW."finding_model"), '') IS NULL
    OR (NEW."finding_scorer_model" IS NOT NULL AND NULLIF(btrim(NEW."finding_scorer_model"), '') IS NULL)
  ) THEN
    RAISE EXCEPTION 'finding dismissal audit is incomplete';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    NEW."verb" IS DISTINCT FROM OLD."verb" OR NEW."reason_tag" IS DISTINCT FROM OLD."reason_tag"
    OR NEW."author_self_dismissal" IS DISTINCT FROM OLD."author_self_dismissal"
    OR NEW."finding_kind" IS DISTINCT FROM OLD."finding_kind" OR NEW."finding_severity" IS DISTINCT FROM OLD."finding_severity"
    OR NEW."finding_confidence" IS DISTINCT FROM OLD."finding_confidence" OR NEW."finding_model" IS DISTINCT FROM OLD."finding_model"
    OR NEW."finding_scorer_model" IS DISTINCT FROM OLD."finding_scorer_model"
  ) THEN
    RAISE EXCEPTION 'finding approval identity is immutable';
  END IF;
  RETURN NEW;
END $$;
