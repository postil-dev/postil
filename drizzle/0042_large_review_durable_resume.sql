CREATE TABLE "large_review_attempts" (
	"attempt_key" text PRIMARY KEY NOT NULL,
	"run_key" text NOT NULL,
	"request_sha256" text NOT NULL,
	"batch_identity" text NOT NULL,
	"attempt" integer NOT NULL,
	"model" text NOT NULL,
	"state" text NOT NULL,
	"lease_id" uuid NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"response_status" integer,
	"response_headers" jsonb,
	"response_body" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "large_review_attempts_key_check" CHECK ("large_review_attempts"."attempt_key" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "large_review_attempts_request_check" CHECK ("large_review_attempts"."request_sha256" ~ '^[0-9a-f]{64}$' AND "large_review_attempts"."batch_identity" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "large_review_attempts_attempt_check" CHECK ("large_review_attempts"."attempt" BETWEEN 1 AND 10),
	CONSTRAINT "large_review_attempts_state_check" CHECK ("large_review_attempts"."state" IN ('pending', 'completed')),
	CONSTRAINT "large_review_attempts_response_check" CHECK (("large_review_attempts"."state" = 'pending' AND "large_review_attempts"."response_status" IS NULL AND "large_review_attempts"."response_headers" IS NULL AND "large_review_attempts"."response_body" IS NULL AND "large_review_attempts"."completed_at" IS NULL) OR ("large_review_attempts"."state" = 'completed' AND "large_review_attempts"."response_status" BETWEEN 200 AND 299 AND "large_review_attempts"."response_headers" IS NOT NULL AND "large_review_attempts"."response_body" IS NOT NULL AND "large_review_attempts"."completed_at" IS NOT NULL)),
	CONSTRAINT "large_review_attempts_model_check" CHECK (length(btrim("large_review_attempts"."model")) BETWEEN 1 AND 500)
);
--> statement-breakpoint
CREATE TABLE "large_review_runs" (
	"run_key" text PRIMARY KEY NOT NULL,
	"current_review_id" bigint NOT NULL,
	"repository_id" bigint NOT NULL,
	"pr_number" integer NOT NULL,
	"cli_version" text NOT NULL,
	"configuration_sha256" text NOT NULL,
	"provider_identity" text NOT NULL,
	"head_sha" text NOT NULL,
	"base_sha" text NOT NULL,
	"retry_lineage" text NOT NULL,
	"plan_sha256" text NOT NULL,
	"hosted_reservation_id" uuid,
	"billing_state" text DEFAULT 'active' NOT NULL,
	"conservatively_settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "large_review_runs_key_check" CHECK ("large_review_runs"."run_key" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "large_review_runs_configuration_check" CHECK ("large_review_runs"."configuration_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "large_review_runs_plan_check" CHECK ("large_review_runs"."plan_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "large_review_runs_identity_lengths_check" CHECK ("large_review_runs"."pr_number" > 0 AND length(btrim("large_review_runs"."cli_version")) BETWEEN 1 AND 100 AND length(btrim("large_review_runs"."provider_identity")) BETWEEN 1 AND 2048 AND length(btrim("large_review_runs"."head_sha")) BETWEEN 1 AND 200 AND length(btrim("large_review_runs"."base_sha")) BETWEEN 1 AND 200 AND length(btrim("large_review_runs"."retry_lineage")) BETWEEN 1 AND 200),
	CONSTRAINT "large_review_runs_billing_state_check" CHECK (("large_review_runs"."billing_state" = 'active' AND "large_review_runs"."conservatively_settled_at" IS NULL) OR ("large_review_runs"."billing_state" = 'conservative' AND "large_review_runs"."conservatively_settled_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "large_review_attempts" ADD CONSTRAINT "large_review_attempts_run_key_large_review_runs_run_key_fk" FOREIGN KEY ("run_key") REFERENCES "public"."large_review_runs"("run_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "large_review_runs" ADD CONSTRAINT "large_review_runs_current_review_id_reviews_id_fk" FOREIGN KEY ("current_review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "large_review_runs" ADD CONSTRAINT "large_review_runs_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "large_review_attempts_run_request_attempt_idx" ON "large_review_attempts" USING btree ("run_key","request_sha256","attempt");--> statement-breakpoint
CREATE UNIQUE INDEX "large_review_attempts_pending_request_idx" ON "large_review_attempts" USING btree ("run_key","request_sha256") WHERE "large_review_attempts"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "large_review_attempts_run_idx" ON "large_review_attempts" USING btree ("run_key");--> statement-breakpoint
CREATE INDEX "large_review_runs_expiry_idx" ON "large_review_runs" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "large_review_runs_resume_identity_idx" ON "large_review_runs" USING btree ("repository_id","pr_number","head_sha","base_sha","cli_version","configuration_sha256","retry_lineage");
