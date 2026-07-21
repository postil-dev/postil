CREATE TABLE "customer_notification_email_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" bigint NOT NULL,
	"email_category" text NOT NULL,
	"event_count" integer NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"message_id" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_notification_email_deliveries_category_check" CHECK ("customer_notification_email_deliveries"."email_category" IN ('security', 'verification', 'payment_failure', 'trial_expiry', 'service_incident', 'billing_summary', 'service_summary')),
	CONSTRAINT "customer_notification_email_deliveries_status_check" CHECK ("customer_notification_email_deliveries"."status" IN ('queued', 'retrying', 'delivered', 'suppressed', 'failed')),
	CONSTRAINT "customer_notification_email_deliveries_event_count_check" CHECK ("customer_notification_email_deliveries"."event_count" BETWEEN 1 AND 20)
);
--> statement-breakpoint
CREATE TABLE "customer_notification_email_delivery_events" (
	"event_id" bigint PRIMARY KEY NOT NULL,
	"delivery_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customer_notification_email_deliveries" ADD CONSTRAINT "customer_notification_email_deliveries_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_notification_email_delivery_events" ADD CONSTRAINT "customer_notification_email_delivery_events_delivery_id_customer_notification_email_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."customer_notification_email_deliveries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_notification_email_deliveries_status_created_idx" ON "customer_notification_email_deliveries" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "customer_notification_email_deliveries_org_created_idx" ON "customer_notification_email_deliveries" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "customer_notification_email_delivery_events_delivery_idx" ON "customer_notification_email_delivery_events" USING btree ("delivery_id");
