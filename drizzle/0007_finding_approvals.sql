CREATE TYPE "public"."finding_approval_role" AS ENUM('member', 'admin');--> statement-breakpoint
CREATE TYPE "public"."finding_approval_source" AS ENUM('github', 'dashboard');--> statement-breakpoint
CREATE TABLE "finding_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"review_id" bigint NOT NULL,
	"finding_id" text NOT NULL,
	"actor_user_id" bigint NOT NULL,
	"actor_github_id" text NOT NULL,
	"actor_login_snapshot" text NOT NULL,
	"actor_role_snapshot" "finding_approval_role" NOT NULL,
	"rationale" text NOT NULL,
	"source" "finding_approval_source" NOT NULL,
	"source_comment_id" uuid,
	"source_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" bigint,
	CONSTRAINT "finding_approvals_rationale_nonempty" CHECK (length(btrim("finding_approvals"."rationale")) > 0)
);
--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "engine_gate_failing" boolean;--> statement-breakpoint
ALTER TABLE "finding_approvals" ADD CONSTRAINT "finding_approvals_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_approvals" ADD CONSTRAINT "finding_approvals_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_approvals" ADD CONSTRAINT "finding_approvals_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "finding_approvals_active_idx" ON "finding_approvals" USING btree ("review_id","finding_id") WHERE "finding_approvals"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "finding_approvals_review_idx" ON "finding_approvals" USING btree ("review_id");
