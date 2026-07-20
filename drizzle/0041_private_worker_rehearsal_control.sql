CREATE TABLE "private_worker_rehearsals" (
	"nonce" uuid PRIMARY KEY NOT NULL,
	"state" text DEFAULT 'armed' NOT NULL,
	"operator_github_id" bigint NOT NULL,
	"org_id" bigint NOT NULL,
	"repository_id" bigint NOT NULL,
	"review_id" bigint NOT NULL,
	"job_id" bigint NOT NULL,
	"org_slug" text NOT NULL,
	"repo_full_name" text NOT NULL,
	"pr_number" integer NOT NULL,
	"head_sha" text NOT NULL,
	"review_public_id" uuid NOT NULL,
	"armed_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"interrupted_worker_instance" text,
	"replacement_worker_instance" text,
	"replacement_observed_at" timestamp with time zone,
	"before_review_count" integer,
	"before_usage_count" integer,
	"before_check_count" integer,
	"before_publication_count" integer,
	"after_review_count" integer,
	"after_usage_count" integer,
	"after_check_count" integer,
	"after_publication_count" integer,
	"failure_reason" text,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "private_worker_rehearsals_state_check" CHECK ("private_worker_rehearsals"."state" IN ('armed', 'awaiting_replacement', 'replacement_verified', 'completed', 'expired', 'failed')),
	CONSTRAINT "private_worker_rehearsals_identity_check" CHECK (length(btrim("private_worker_rehearsals"."org_slug")) > 0 AND length(btrim("private_worker_rehearsals"."repo_full_name")) > 0 AND "private_worker_rehearsals"."pr_number" > 0 AND "private_worker_rehearsals"."head_sha" ~ '^[0-9a-f]{40}$'),
	CONSTRAINT "private_worker_rehearsals_arming_window_check" CHECK ("private_worker_rehearsals"."expires_at" > "private_worker_rehearsals"."armed_at" AND "private_worker_rehearsals"."expires_at" <= "private_worker_rehearsals"."armed_at" + interval '10 minutes'),
	CONSTRAINT "private_worker_rehearsals_before_counts_check" CHECK (("private_worker_rehearsals"."before_review_count" IS NULL AND "private_worker_rehearsals"."before_usage_count" IS NULL AND "private_worker_rehearsals"."before_check_count" IS NULL AND "private_worker_rehearsals"."before_publication_count" IS NULL) OR ("private_worker_rehearsals"."before_review_count" >= 0 AND "private_worker_rehearsals"."before_usage_count" >= 0 AND "private_worker_rehearsals"."before_check_count" >= 0 AND "private_worker_rehearsals"."before_publication_count" >= 0)),
	CONSTRAINT "private_worker_rehearsals_after_counts_check" CHECK (("private_worker_rehearsals"."after_review_count" IS NULL AND "private_worker_rehearsals"."after_usage_count" IS NULL AND "private_worker_rehearsals"."after_check_count" IS NULL AND "private_worker_rehearsals"."after_publication_count" IS NULL) OR ("private_worker_rehearsals"."after_review_count" >= 0 AND "private_worker_rehearsals"."after_usage_count" >= 0 AND "private_worker_rehearsals"."after_check_count" >= 0 AND "private_worker_rehearsals"."after_publication_count" >= 0)),
	CONSTRAINT "private_worker_rehearsals_replacement_pair_check" CHECK (("private_worker_rehearsals"."replacement_worker_instance" IS NULL) = ("private_worker_rehearsals"."replacement_observed_at" IS NULL)),
	CONSTRAINT "private_worker_rehearsals_consumed_state_check" CHECK (("private_worker_rehearsals"."state" IN ('armed', 'expired') AND "private_worker_rehearsals"."consumed_at" IS NULL AND "private_worker_rehearsals"."interrupted_worker_instance" IS NULL AND "private_worker_rehearsals"."before_review_count" IS NULL) OR ("private_worker_rehearsals"."state" IN ('awaiting_replacement', 'replacement_verified', 'completed', 'failed') AND "private_worker_rehearsals"."consumed_at" IS NOT NULL AND "private_worker_rehearsals"."interrupted_worker_instance" IS NOT NULL AND "private_worker_rehearsals"."before_review_count" IS NOT NULL)),
	CONSTRAINT "private_worker_rehearsals_replacement_state_check" CHECK (("private_worker_rehearsals"."state" IN ('armed', 'awaiting_replacement', 'expired') AND "private_worker_rehearsals"."replacement_worker_instance" IS NULL) OR ("private_worker_rehearsals"."state" IN ('replacement_verified', 'completed') AND "private_worker_rehearsals"."replacement_worker_instance" IS NOT NULL) OR "private_worker_rehearsals"."state" = 'failed'),
	CONSTRAINT "private_worker_rehearsals_completion_state_check" CHECK (("private_worker_rehearsals"."state" = 'completed' AND "private_worker_rehearsals"."after_review_count" IS NOT NULL AND "private_worker_rehearsals"."completed_at" IS NOT NULL AND "private_worker_rehearsals"."failure_reason" IS NULL) OR ("private_worker_rehearsals"."state" IN ('expired', 'failed') AND "private_worker_rehearsals"."after_review_count" IS NULL AND "private_worker_rehearsals"."completed_at" IS NOT NULL AND "private_worker_rehearsals"."failure_reason" IS NOT NULL) OR ("private_worker_rehearsals"."state" IN ('armed', 'awaiting_replacement', 'replacement_verified') AND "private_worker_rehearsals"."after_review_count" IS NULL AND "private_worker_rehearsals"."completed_at" IS NULL AND "private_worker_rehearsals"."failure_reason" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "private_worker_rehearsals" ADD CONSTRAINT "private_worker_rehearsals_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "private_worker_rehearsals" ADD CONSTRAINT "private_worker_rehearsals_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "private_worker_rehearsals" ADD CONSTRAINT "private_worker_rehearsals_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "private_worker_rehearsals" ADD CONSTRAINT "private_worker_rehearsals_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "private_worker_rehearsals_review_idx" ON "private_worker_rehearsals" USING btree ("review_id");--> statement-breakpoint
CREATE UNIQUE INDEX "private_worker_rehearsals_job_idx" ON "private_worker_rehearsals" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "private_worker_rehearsals_state_idx" ON "private_worker_rehearsals" USING btree ("state","updated_at");