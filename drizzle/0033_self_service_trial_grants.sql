CREATE TABLE "self_service_trial_grants" (
	"org_id" bigint PRIMARY KEY NOT NULL,
	"initiated_by_github_id" bigint NOT NULL,
	"requested_mode" text NOT NULL,
	"granted_mode" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "self_service_trial_grants_requested_mode_check" CHECK ("self_service_trial_grants"."requested_mode" IN ('hosted', 'byok')),
	CONSTRAINT "self_service_trial_grants_granted_mode_check" CHECK ("self_service_trial_grants"."granted_mode" IN ('hosted', 'byok'))
);
--> statement-breakpoint
CREATE INDEX "self_service_trial_grants_actor_created_idx" ON "self_service_trial_grants" USING btree ("initiated_by_github_id","created_at");
