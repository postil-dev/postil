CREATE TABLE "organization_notification_preferences" (
	"org_id" bigint PRIMARY KEY NOT NULL,
	"billing_summary_email" boolean DEFAULT true NOT NULL,
	"service_summary_email" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization_setting_events" DROP CONSTRAINT "organization_setting_events_setting_check";--> statement-breakpoint
ALTER TABLE "organization_setting_events" DROP CONSTRAINT "organization_setting_events_value_check";--> statement-breakpoint
ALTER TABLE "organization_notification_preferences" ADD CONSTRAINT "organization_notification_preferences_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_setting_events" ADD CONSTRAINT "organization_setting_events_setting_check" CHECK ("organization_setting_events"."setting" IN ('gate_enabled', 'billing_summary_email', 'service_summary_email'));--> statement-breakpoint
ALTER TABLE "organization_setting_events" ADD CONSTRAINT "organization_setting_events_value_check" CHECK ("organization_setting_events"."value" IN ('enabled', 'disabled', 'advisory'));