CREATE TABLE "private_monitor_incidents" (
	"key" text PRIMARY KEY NOT NULL,
	"group" text NOT NULL,
	"severity" text NOT NULL,
	"summary" text NOT NULL,
	"detail" text NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"occurrence_count" integer DEFAULT 1 NOT NULL,
	"first_detected_at" timestamp with time zone NOT NULL,
	"last_detected_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"pending_notification_key" text,
	"pending_notification_kind" text,
	"notification_attempts" integer DEFAULT 0 NOT NULL,
	"notification_available_at" timestamp with time zone,
	"notification_lease_owner" text,
	"notification_lease_expires_at" timestamp with time zone,
	"last_notified_at" timestamp with time zone,
	"last_notification_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "private_monitor_incidents_state_check" CHECK ("private_monitor_incidents"."state" IN ('open', 'resolved')),
	CONSTRAINT "private_monitor_incidents_severity_check" CHECK ("private_monitor_incidents"."severity" IN ('warning', 'critical')),
	CONSTRAINT "private_monitor_incidents_notification_kind_check" CHECK ("private_monitor_incidents"."pending_notification_kind" IS NULL OR "private_monitor_incidents"."pending_notification_kind" IN ('opened', 'reminder', 'resolved')),
	CONSTRAINT "private_monitor_incidents_notification_pair_check" CHECK (("private_monitor_incidents"."pending_notification_key" IS NULL) = ("private_monitor_incidents"."pending_notification_kind" IS NULL)),
	CONSTRAINT "private_monitor_incidents_occurrence_count_check" CHECK ("private_monitor_incidents"."occurrence_count" > 0 AND "private_monitor_incidents"."notification_attempts" >= 0 AND "private_monitor_incidents"."notification_attempts" <= 5),
	CONSTRAINT "private_monitor_incidents_text_nonempty" CHECK (length(btrim("private_monitor_incidents"."key")) > 0 AND length(btrim("private_monitor_incidents"."group")) > 0 AND length(btrim("private_monitor_incidents"."summary")) > 0)
);
--> statement-breakpoint
CREATE TABLE "private_monitor_runs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "private_monitor_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"scheduled_for" timestamp with time zone NOT NULL,
	"owner" text NOT NULL,
	"status" text NOT NULL,
	"check_count" integer DEFAULT 0 NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"error" text,
	CONSTRAINT "private_monitor_runs_status_check" CHECK ("private_monitor_runs"."status" IN ('running', 'completed', 'failed')),
	CONSTRAINT "private_monitor_runs_counts_check" CHECK ("private_monitor_runs"."check_count" >= 0 AND "private_monitor_runs"."failure_count" >= 0 AND "private_monitor_runs"."failure_count" <= "private_monitor_runs"."check_count"),
	CONSTRAINT "private_monitor_runs_owner_nonempty" CHECK (length(btrim("private_monitor_runs"."owner")) > 0)
);
--> statement-breakpoint
CREATE TABLE "private_monitor_state" (
	"id" integer PRIMARY KEY NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"last_started_at" timestamp with time zone,
	"last_completed_at" timestamp with time zone,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "private_monitor_state_singleton_check" CHECK ("private_monitor_state"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "service_heartbeats" (
	"component" text PRIMARY KEY NOT NULL,
	"instance_id" text NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_heartbeats_component_check" CHECK ("service_heartbeats"."component" IN ('worker', 'monitor')),
	CONSTRAINT "service_heartbeats_instance_nonempty" CHECK (length(btrim("service_heartbeats"."instance_id")) > 0)
);
--> statement-breakpoint
CREATE INDEX "private_monitor_incidents_state_updated_idx" ON "private_monitor_incidents" USING btree ("state","updated_at");--> statement-breakpoint
CREATE INDEX "private_monitor_incidents_notification_idx" ON "private_monitor_incidents" USING btree ("notification_available_at","notification_lease_expires_at") WHERE "private_monitor_incidents"."pending_notification_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "private_monitor_runs_scheduled_idx" ON "private_monitor_runs" USING btree ("scheduled_for");--> statement-breakpoint
CREATE INDEX "private_monitor_runs_started_idx" ON "private_monitor_runs" USING btree ("started_at");