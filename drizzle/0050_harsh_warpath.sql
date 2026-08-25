CREATE TABLE "finding_feedback" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "finding_feedback_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"finding_publication_id" bigint NOT NULL,
	"source" text NOT NULL,
	"source_github_comment_id" bigint,
	"source_github_reaction_id" bigint,
	"body" text,
	"actor_github_id" bigint NOT NULL,
	"actor_login_snapshot" text NOT NULL,
	"pr_author_github_id" bigint NOT NULL,
	"pr_author_login_snapshot" text NOT NULL,
	"actor_is_pr_author" boolean NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"source_delivery_id" text,
	"suggested_reason_tag" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finding_feedback_source_check" CHECK ("finding_feedback"."source" IN ('reply', 'reaction')),
	CONSTRAINT "finding_feedback_identity_check" CHECK (("finding_feedback"."source" = 'reply' AND "finding_feedback"."source_github_comment_id" BETWEEN 1 AND 9007199254740991 AND "finding_feedback"."source_github_reaction_id" IS NULL AND "finding_feedback"."body" IS NOT NULL AND length(btrim("finding_feedback"."body")) BETWEEN 1 AND 65535 AND length(btrim("finding_feedback"."source_delivery_id")) BETWEEN 1 AND 200) OR ("finding_feedback"."source" = 'reaction' AND "finding_feedback"."source_github_comment_id" BETWEEN 1 AND 9007199254740991 AND "finding_feedback"."source_github_reaction_id" BETWEEN 1 AND 9007199254740991 AND "finding_feedback"."body" IS NULL AND "finding_feedback"."source_delivery_id" IS NULL)),
	CONSTRAINT "finding_feedback_actor_check" CHECK ("finding_feedback"."actor_github_id" BETWEEN 1 AND 9007199254740991 AND length(btrim("finding_feedback"."actor_login_snapshot")) BETWEEN 1 AND 100 AND "finding_feedback"."pr_author_github_id" BETWEEN 1 AND 9007199254740991 AND length(btrim("finding_feedback"."pr_author_login_snapshot")) BETWEEN 1 AND 100 AND "finding_feedback"."actor_is_pr_author" = ("finding_feedback"."actor_github_id" = "finding_feedback"."pr_author_github_id")),
	CONSTRAINT "finding_feedback_suggested_reason_check" CHECK ("finding_feedback"."suggested_reason_tag" IS NULL OR "finding_feedback"."suggested_reason_tag" IN ('false-positive', 'accepted-risk', 'out-of-scope'))
);
--> statement-breakpoint
ALTER TABLE "finding_feedback" ADD CONSTRAINT "finding_feedback_finding_publication_id_finding_publications_id_fk" FOREIGN KEY ("finding_publication_id") REFERENCES "public"."finding_publications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "finding_feedback_publication_observed_idx" ON "finding_feedback" USING btree ("finding_publication_id","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "finding_feedback_github_reply_idx" ON "finding_feedback" USING btree ("source_github_comment_id") WHERE "finding_feedback"."source" = 'reply';--> statement-breakpoint
CREATE UNIQUE INDEX "finding_feedback_github_reaction_idx" ON "finding_feedback" USING btree ("source_github_reaction_id") WHERE "finding_feedback"."source" = 'reaction';
--> statement-breakpoint
CREATE FUNCTION "postil_guard_finding_feedback_immutable"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'finding feedback is append-only';
END $$;
--> statement-breakpoint
CREATE TRIGGER "finding_feedback_guard_immutable"
BEFORE UPDATE ON "finding_feedback"
FOR EACH ROW EXECUTE FUNCTION "postil_guard_finding_feedback_immutable"();
