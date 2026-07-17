CREATE TABLE "github_webhook_delivery_recoveries" (
	"delivery_id" text PRIMARY KEY NOT NULL,
	"delivery_guid" text NOT NULL,
	"delivered_at" timestamp with time zone NOT NULL,
	"event" text NOT NULL,
	"redelivery" boolean NOT NULL,
	"outcome" text NOT NULL,
	"status_code" integer,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"request_state" text,
	"request_attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_requested_at" timestamp with time zone,
	"request_status_code" integer,
	"recovery_delivery_id" text,
	"last_error_category" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_webhook_delivery_recoveries_outcome_check" CHECK ("github_webhook_delivery_recoveries"."outcome" IN ('success', 'failure', 'pending')),
	CONSTRAINT "github_webhook_delivery_recoveries_request_state_check" CHECK ("github_webhook_delivery_recoveries"."request_state" IS NULL OR "github_webhook_delivery_recoveries"."request_state" IN ('requesting', 'retryable', 'accepted', 'terminal', 'exhausted', 'recovered')),
	CONSTRAINT "github_webhook_delivery_recoveries_attempts_check" CHECK ("github_webhook_delivery_recoveries"."request_attempts" >= 0 AND "github_webhook_delivery_recoveries"."request_attempts" <= 2)
);
--> statement-breakpoint
CREATE TABLE "github_webhook_redelivery_state" (
	"id" integer PRIMARY KEY NOT NULL,
	"cursor" text,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"sweep_started_at" timestamp with time zone,
	"last_page_at" timestamp with time zone,
	"last_sweep_completed_at" timestamp with time zone,
	"rate_limited_until" timestamp with time zone,
	"last_error_category" text,
	CONSTRAINT "github_webhook_redelivery_state_singleton_check" CHECK ("github_webhook_redelivery_state"."id" = 1)
);
--> statement-breakpoint
CREATE INDEX "github_webhook_delivery_recoveries_guid_idx" ON "github_webhook_delivery_recoveries" USING btree ("delivery_guid","delivered_at");--> statement-breakpoint
CREATE INDEX "github_webhook_delivery_recoveries_retry_idx" ON "github_webhook_delivery_recoveries" USING btree ("next_attempt_at","delivered_at") WHERE "github_webhook_delivery_recoveries"."outcome" = 'failure' AND "github_webhook_delivery_recoveries"."recovery_delivery_id" IS NULL;
