ALTER TABLE "finding_approvals" ADD COLUMN "finding_scorer_model" text;--> statement-breakpoint
ALTER TABLE "finding_approvals" ADD CONSTRAINT "finding_approvals_dismissal_check_v2" CHECK (("finding_approvals"."verb" = 'approve' AND "finding_approvals"."reason_tag" IS NULL AND "finding_approvals"."author_self_dismissal" = false AND "finding_approvals"."finding_kind" IS NULL AND "finding_approvals"."finding_severity" IS NULL AND "finding_approvals"."finding_confidence" IS NULL AND "finding_approvals"."finding_model" IS NULL AND "finding_approvals"."finding_scorer_model" IS NULL) OR ("finding_approvals"."verb" = 'dismiss' AND "finding_approvals"."reason_tag" IS NOT NULL AND "finding_approvals"."reason_tag" IN ('false-positive', 'accepted-risk', 'out-of-scope') AND "finding_approvals"."finding_kind" IS NOT NULL AND "finding_approvals"."finding_severity" IS NOT NULL AND "finding_approvals"."finding_confidence" IS NOT NULL AND "finding_approvals"."finding_confidence" BETWEEN 0 AND 1 AND "finding_approvals"."finding_model" IS NOT NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "finding_approvals" VALIDATE CONSTRAINT "finding_approvals_dismissal_check_v2";--> statement-breakpoint
ALTER TABLE "finding_approvals" DROP CONSTRAINT "finding_approvals_dismissal_check";--> statement-breakpoint
ALTER TABLE "finding_approvals" RENAME CONSTRAINT "finding_approvals_dismissal_check_v2" TO "finding_approvals_dismissal_check";--> statement-breakpoint
CREATE OR REPLACE FUNCTION "postil_guard_finding_dismissal_audit"()
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
    OR NEW."finding_scorer_model" IS DISTINCT FROM OLD."finding_scorer_model"
  ) THEN
    RAISE EXCEPTION 'finding approval identity is immutable';
  END IF;
  RETURN NEW;
END $$;
