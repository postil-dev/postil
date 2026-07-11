ALTER TABLE "usage_events" ADD COLUMN "cost_cents" integer;
--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_cost_cents_nonnegative" CHECK ("usage_events"."cost_cents" IS NULL OR "usage_events"."cost_cents" >= 0) NOT VALID;
