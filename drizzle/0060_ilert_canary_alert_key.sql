ALTER TABLE "ilert_alert_events" ADD COLUMN "alert_key" text;--> statement-breakpoint
ALTER TABLE "ilert_alert_events" ADD CONSTRAINT "ilert_alert_events_alert_key_check" CHECK ("ilert_alert_events"."alert_key" IS NULL OR length("ilert_alert_events"."alert_key") BETWEEN 1 AND 512);
