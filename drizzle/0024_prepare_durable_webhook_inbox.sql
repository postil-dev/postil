ALTER TABLE "webhook_deliveries" ADD COLUMN "payload" jsonb;
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "completed_at" timestamp with time zone DEFAULT now();
