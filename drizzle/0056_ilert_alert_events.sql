CREATE TABLE "ilert_alert_events" (
	"sequence" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ilert_alert_events_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"event_id" uuid NOT NULL,
	"alert_id" text NOT NULL,
	"event_type" text NOT NULL,
	"status" text NOT NULL,
	"priority" text NOT NULL,
	"summary" text NOT NULL,
	"details" text NOT NULL,
	"alert_source_id" bigint NOT NULL,
	"alert_source_name" text NOT NULL,
	"report_time" timestamp with time zone NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"payload_sha256" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ilert_alert_events_alert_id_check" CHECK ("ilert_alert_events"."alert_id" ~ '^[1-9][0-9]{0,63}$'),
	CONSTRAINT "ilert_alert_events_event_type_check" CHECK (length("ilert_alert_events"."event_type") <= 64 AND "ilert_alert_events"."event_type" ~ '^alert-[a-z]+(-[a-z]+)*$'),
	CONSTRAINT "ilert_alert_events_status_check" CHECK ("ilert_alert_events"."status" IN ('PENDING', 'ACCEPTED', 'RESOLVED')),
	CONSTRAINT "ilert_alert_events_priority_check" CHECK ("ilert_alert_events"."priority" IN ('HIGH', 'LOW')),
	CONSTRAINT "ilert_alert_events_summary_check" CHECK (length("ilert_alert_events"."summary") BETWEEN 1 AND 512),
	CONSTRAINT "ilert_alert_events_details_check" CHECK (length("ilert_alert_events"."details") BETWEEN 0 AND 8192),
	CONSTRAINT "ilert_alert_events_source_name_check" CHECK (length("ilert_alert_events"."alert_source_name") BETWEEN 1 AND 256),
	CONSTRAINT "ilert_alert_events_payload_sha256_check" CHECK ("ilert_alert_events"."payload_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ilert_alert_events_event_id_idx" ON "ilert_alert_events" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "ilert_alert_events_alert_sequence_idx" ON "ilert_alert_events" USING btree ("alert_id","sequence");
