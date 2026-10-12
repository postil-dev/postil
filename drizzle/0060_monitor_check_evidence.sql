CREATE TABLE "private_monitor_check_failures" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "private_monitor_check_failures_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"run_id" bigint NOT NULL,
	"key" text NOT NULL,
	"attempt" integer NOT NULL,
	"recovered" boolean NOT NULL,
	"detail" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "private_monitor_check_failures_attempt_check" CHECK ("private_monitor_check_failures"."attempt" > 0),
	CONSTRAINT "private_monitor_check_failures_key_nonempty" CHECK (length(btrim("private_monitor_check_failures"."key")) > 0)
);
--> statement-breakpoint
CREATE TABLE "private_monitor_incident_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "private_monitor_incident_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"key" text NOT NULL,
	"group" text NOT NULL,
	"severity" text NOT NULL,
	"transition" text NOT NULL,
	"summary" text NOT NULL,
	"detail" text NOT NULL,
	"occurrence_count" integer NOT NULL,
	"first_detected_at" timestamp with time zone NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "private_monitor_incident_events_transition_check" CHECK ("private_monitor_incident_events"."transition" IN ('opened', 'resolved')),
	CONSTRAINT "private_monitor_incident_events_severity_check" CHECK ("private_monitor_incident_events"."severity" IN ('warning', 'critical')),
	CONSTRAINT "private_monitor_incident_events_text_nonempty" CHECK (length(btrim("private_monitor_incident_events"."key")) > 0 AND length(btrim("private_monitor_incident_events"."group")) > 0 AND length(btrim("private_monitor_incident_events"."summary")) > 0 AND "private_monitor_incident_events"."occurrence_count" > 0)
);
--> statement-breakpoint
ALTER TABLE "private_monitor_incidents" ADD COLUMN "opened_detail" text;--> statement-breakpoint
ALTER TABLE "private_monitor_state" ADD COLUMN "heartbeat_delivery_error" text;--> statement-breakpoint
CREATE INDEX "private_monitor_check_failures_observed_idx" ON "private_monitor_check_failures" USING btree ("observed_at");--> statement-breakpoint
CREATE INDEX "private_monitor_incident_events_occurred_idx" ON "private_monitor_incident_events" USING btree ("occurred_at");