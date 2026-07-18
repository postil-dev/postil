CREATE TABLE "billing_author_settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" bigint NOT NULL,
	"provider_subscription_id" text NOT NULL,
	"period_starts_at" timestamp with time zone NOT NULL,
	"period_ends_at" timestamp with time zone NOT NULL,
	"active_author_count" integer NOT NULL,
	"unit_amount_cents" integer DEFAULT 600 NOT NULL,
	"total_amount_cents" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"provider_transaction_id" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"attempt_started_at" timestamp with time zone,
	"next_reconcile_at" timestamp with time zone,
	"last_error_category" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_author_settlements_period_check" CHECK ("billing_author_settlements"."period_starts_at" < "billing_author_settlements"."period_ends_at"),
	CONSTRAINT "billing_author_settlements_author_count_check" CHECK ("billing_author_settlements"."active_author_count" >= 0),
	CONSTRAINT "billing_author_settlements_amount_check" CHECK ("billing_author_settlements"."unit_amount_cents" = 600 AND "billing_author_settlements"."total_amount_cents" = "billing_author_settlements"."active_author_count" * "billing_author_settlements"."unit_amount_cents"),
	CONSTRAINT "billing_author_settlements_status_check" CHECK ("billing_author_settlements"."status" IN ('pending', 'charging', 'reconciling', 'charged', 'no_charge', 'failed')),
	CONSTRAINT "billing_author_settlements_attempt_count_check" CHECK ("billing_author_settlements"."attempt_count" >= 0),
	CONSTRAINT "billing_author_settlements_subscription_nonempty" CHECK (length(btrim("billing_author_settlements"."provider_subscription_id")) > 0)
);
--> statement-breakpoint
CREATE TABLE "billing_checkout_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" bigint NOT NULL,
	"requested_by_user_id" bigint NOT NULL,
	"provider" text DEFAULT 'paddle' NOT NULL,
	"provider_transaction_id" text,
	"checkout_url" text,
	"status" text DEFAULT 'creating' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_error_category" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_checkout_transactions_provider_check" CHECK ("billing_checkout_transactions"."provider" = 'paddle'),
	CONSTRAINT "billing_checkout_transactions_status_check" CHECK ("billing_checkout_transactions"."status" IN ('creating', 'pending', 'completed', 'failed', 'expired', 'canceled')),
	CONSTRAINT "billing_checkout_transactions_provider_transaction_nonempty" CHECK ("billing_checkout_transactions"."provider_transaction_id" IS NULL OR length(btrim("billing_checkout_transactions"."provider_transaction_id")) > 0)
);
--> statement-breakpoint
CREATE TABLE "billing_provider_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"provider" text DEFAULT 'paddle' NOT NULL,
	"event_type" text NOT NULL,
	"provider_object_id" text,
	"org_id" bigint,
	"occurred_at" timestamp with time zone NOT NULL,
	"outcome" text NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_provider_events_provider_check" CHECK ("billing_provider_events"."provider" = 'paddle'),
	CONSTRAINT "billing_provider_events_outcome_check" CHECK ("billing_provider_events"."outcome" IN ('processing', 'applied', 'stale', 'ignored', 'unmatched')),
	CONSTRAINT "billing_provider_events_event_type_nonempty" CHECK (length(btrim("billing_provider_events"."event_type")) > 0)
);
--> statement-breakpoint
CREATE TABLE "billing_provider_subscriptions" (
	"org_id" bigint PRIMARY KEY NOT NULL,
	"provider" text DEFAULT 'paddle' NOT NULL,
	"provider_subscription_id" text NOT NULL,
	"provider_customer_id" text NOT NULL,
	"status" text NOT NULL,
	"current_period_starts_at" timestamp with time zone,
	"current_period_ends_at" timestamp with time zone,
	"latest_event_occurred_at" timestamp with time zone NOT NULL,
	"latest_event_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_provider_subscriptions_provider_check" CHECK ("billing_provider_subscriptions"."provider" = 'paddle'),
	CONSTRAINT "billing_provider_subscriptions_status_check" CHECK ("billing_provider_subscriptions"."status" IN ('active', 'trialing', 'past_due', 'paused', 'canceled')),
	CONSTRAINT "billing_provider_subscriptions_provider_subscription_nonempty" CHECK (length(btrim("billing_provider_subscriptions"."provider_subscription_id")) > 0),
	CONSTRAINT "billing_provider_subscriptions_provider_customer_nonempty" CHECK (length(btrim("billing_provider_subscriptions"."provider_customer_id")) > 0)
);
--> statement-breakpoint
ALTER TABLE "operator_alert_deliveries" DROP CONSTRAINT "operator_alert_deliveries_event_check";--> statement-breakpoint
ALTER TABLE "billing_author_settlements" ADD CONSTRAINT "billing_author_settlements_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_checkout_transactions" ADD CONSTRAINT "billing_checkout_transactions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_checkout_transactions" ADD CONSTRAINT "billing_checkout_transactions_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_provider_events" ADD CONSTRAINT "billing_provider_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_provider_subscriptions" ADD CONSTRAINT "billing_provider_subscriptions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_author_settlements_org_period_idx" ON "billing_author_settlements" USING btree ("org_id","period_starts_at","period_ends_at");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_author_settlements_provider_transaction_idx" ON "billing_author_settlements" USING btree ("provider_transaction_id");--> statement-breakpoint
CREATE INDEX "billing_author_settlements_status_reconcile_idx" ON "billing_author_settlements" USING btree ("status","next_reconcile_at");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_checkout_transactions_provider_transaction_idx" ON "billing_checkout_transactions" USING btree ("provider_transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_checkout_transactions_open_org_idx" ON "billing_checkout_transactions" USING btree ("org_id") WHERE "billing_checkout_transactions"."status" IN ('creating', 'pending');--> statement-breakpoint
CREATE INDEX "billing_checkout_transactions_status_expiry_idx" ON "billing_checkout_transactions" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "billing_provider_events_org_occurred_idx" ON "billing_provider_events" USING btree ("org_id","occurred_at");--> statement-breakpoint
CREATE INDEX "billing_provider_events_type_occurred_idx" ON "billing_provider_events" USING btree ("event_type","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_provider_subscriptions_provider_id_idx" ON "billing_provider_subscriptions" USING btree ("provider","provider_subscription_id");--> statement-breakpoint
CREATE INDEX "billing_provider_subscriptions_status_period_idx" ON "billing_provider_subscriptions" USING btree ("status","current_period_ends_at");--> statement-breakpoint
ALTER TABLE "operator_alert_deliveries" ADD CONSTRAINT "operator_alert_deliveries_event_check" CHECK ("operator_alert_deliveries"."event" IN ('trial_started', 'trial_expired', 'installation_removed', 'subscription_started', 'subscription_past_due', 'subscription_paused', 'subscription_canceled', 'billing_anomaly'));
