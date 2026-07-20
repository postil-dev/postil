CREATE TABLE "customer_notification_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "customer_notification_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"org_id" bigint NOT NULL,
	"idempotency_key" text NOT NULL,
	"severity" text NOT NULL,
	"category" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"action_label" text,
	"action_href" text,
	"visibility" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "customer_notification_events_severity_check" CHECK ("customer_notification_events"."severity" IN ('info', 'warning', 'critical')),
	CONSTRAINT "customer_notification_events_category_check" CHECK ("customer_notification_events"."category" IN ('trial', 'billing', 'service', 'security')),
	CONSTRAINT "customer_notification_events_visibility_check" CHECK ("customer_notification_events"."visibility" IN ('members', 'admins')),
	CONSTRAINT "customer_notification_events_content_check" CHECK (length(btrim("customer_notification_events"."idempotency_key")) BETWEEN 1 AND 200 AND length(btrim("customer_notification_events"."title")) BETWEEN 1 AND 120 AND length(btrim("customer_notification_events"."body")) BETWEEN 1 AND 500),
	CONSTRAINT "customer_notification_events_action_check" CHECK (("customer_notification_events"."action_label" IS NULL AND "customer_notification_events"."action_href" IS NULL) OR ("customer_notification_events"."action_label" IS NOT NULL AND "customer_notification_events"."action_href" IS NOT NULL AND length(btrim("customer_notification_events"."action_label")) BETWEEN 1 AND 60 AND "customer_notification_events"."action_href" ~ '^/orgs/')),
	CONSTRAINT "customer_notification_events_expiry_check" CHECK ("customer_notification_events"."expires_at" > "customer_notification_events"."created_at")
);
--> statement-breakpoint
CREATE TABLE "customer_notification_reads" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "customer_notification_reads_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"event_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customer_notification_events" ADD CONSTRAINT "customer_notification_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_notification_reads" ADD CONSTRAINT "customer_notification_reads_event_id_customer_notification_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."customer_notification_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_notification_reads" ADD CONSTRAINT "customer_notification_reads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_notification_events_org_key_idx" ON "customer_notification_events" USING btree ("org_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "customer_notification_events_org_created_idx" ON "customer_notification_events" USING btree ("org_id","created_at","id");--> statement-breakpoint
CREATE INDEX "customer_notification_events_expiry_idx" ON "customer_notification_events" USING btree ("expires_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_notification_reads_event_user_idx" ON "customer_notification_reads" USING btree ("event_id","user_id");--> statement-breakpoint
CREATE INDEX "customer_notification_reads_user_event_idx" ON "customer_notification_reads" USING btree ("user_id","event_id");