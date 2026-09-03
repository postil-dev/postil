ALTER TABLE "ilert_alert_events" ADD COLUMN "alert_key" text;--> statement-breakpoint
ALTER TABLE "ilert_alert_events" ADD CONSTRAINT "ilert_alert_events_alert_key_check" CHECK ("ilert_alert_events"."alert_key" IS NULL OR length("ilert_alert_events"."alert_key") BETWEEN 1 AND 512);--> statement-breakpoint
CREATE INDEX CONCURRENTLY "ilert_alert_events_canary_observation_idx" ON "ilert_alert_events" USING btree ("alert_key","event_type","alert_source_id") WHERE "alert_key" IS NOT NULL;
