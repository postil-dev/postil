ALTER TABLE "org_settings" ADD COLUMN "gate_enabled" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
INSERT INTO "org_settings" ("org_id")
SELECT "id" FROM "organizations"
ON CONFLICT ("org_id") DO NOTHING;
--> statement-breakpoint
ALTER TABLE "org_settings" ALTER COLUMN "gate_enabled" SET DEFAULT false;
--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "gate_sync_lease_id" uuid;
--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "gate_sync_lease_expires_at" timestamp with time zone;
--> statement-breakpoint
CREATE TABLE "organization_setting_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
	"org_id" bigint NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
	"setting" text NOT NULL,
	"value" text NOT NULL,
	"actor_user_id" bigint REFERENCES "users"("id") ON DELETE set null,
	"source" text NOT NULL DEFAULT 'dashboard',
	"occurred_at" timestamp with time zone NOT NULL DEFAULT now(),
	CONSTRAINT "organization_setting_events_setting_check" CHECK ("setting" IN ('gate_enabled')),
	CONSTRAINT "organization_setting_events_value_check" CHECK ("value" IN ('enabled', 'advisory')),
	CONSTRAINT "organization_setting_events_source_check" CHECK ("source" IN ('dashboard'))
);
--> statement-breakpoint
CREATE INDEX "organization_setting_events_org_time_idx"
	ON "organization_setting_events" ("org_id", "occurred_at", "id");
--> statement-breakpoint
CREATE TABLE "repository_gate_enforcement" (
	"repository_id" bigint PRIMARY KEY REFERENCES "repositories"("id") ON DELETE cascade,
	"status" text NOT NULL,
	"default_branch" text,
	"branch_protection" text DEFAULT 'unknown' NOT NULL,
	"evidence" jsonb,
	"checked_at" timestamp with time zone NOT NULL,
	"last_successful_at" timestamp with time zone,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repository_gate_enforcement_status_check" CHECK ("status" IN ('required', 'not_required', 'unknown')),
	CONSTRAINT "repository_gate_enforcement_branch_protection_check" CHECK ("branch_protection" IN ('protected', 'unprotected', 'unknown'))
);
--> statement-breakpoint
CREATE INDEX "repository_gate_enforcement_status_checked_idx"
	ON "repository_gate_enforcement" ("status", "checked_at");
