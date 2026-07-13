ALTER TABLE "usage_events" ADD COLUMN "cost_micros" bigint;
--> statement-breakpoint
UPDATE "usage_events"
SET "cost_micros" = "cost_cents"::bigint * 10000
WHERE "cost_micros" IS NULL AND "cost_cents" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_cost_micros_nonnegative" CHECK ("usage_events"."cost_micros" IS NULL OR "usage_events"."cost_micros" >= 0) NOT VALID;
--> statement-breakpoint
ALTER TABLE "organization_entitlements" ADD COLUMN "included_usage_micros" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "organization_entitlements" ADD COLUMN "overage_hard_cap_micros" bigint DEFAULT 0;
--> statement-breakpoint
UPDATE "organization_entitlements"
SET
  "included_usage_micros" = "included_usage_cents"::bigint * 10000,
  "overage_hard_cap_micros" = CASE
    WHEN "overage_hard_cap_cents" IS NULL THEN NULL
    ELSE "overage_hard_cap_cents"::bigint * 10000
  END;
--> statement-breakpoint
ALTER TABLE "organization_entitlements" ADD CONSTRAINT "organization_entitlements_included_usage_micros_nonnegative" CHECK ("organization_entitlements"."included_usage_micros" >= 0);
--> statement-breakpoint
ALTER TABLE "organization_entitlements" ADD CONSTRAINT "organization_entitlements_overage_cap_micros_nonnegative" CHECK ("organization_entitlements"."overage_hard_cap_micros" IS NULL OR "organization_entitlements"."overage_hard_cap_micros" >= 0);
--> statement-breakpoint
CREATE TABLE "hosted_usage_reservations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" bigint NOT NULL,
  "review_id" bigint NOT NULL,
  "reserved_micros" bigint NOT NULL,
  "actual_micros" bigint,
  "status" text DEFAULT 'active' NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "hosted_usage_reservations_status_check" CHECK ("hosted_usage_reservations"."status" IN ('active', 'reconciled', 'released')),
  CONSTRAINT "hosted_usage_reservations_reserved_positive" CHECK ("hosted_usage_reservations"."reserved_micros" > 0),
  CONSTRAINT "hosted_usage_reservations_actual_nonnegative" CHECK ("hosted_usage_reservations"."actual_micros" IS NULL OR "hosted_usage_reservations"."actual_micros" >= 0)
);
--> statement-breakpoint
ALTER TABLE "hosted_usage_reservations" ADD CONSTRAINT "hosted_usage_reservations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "hosted_usage_reservations" ADD CONSTRAINT "hosted_usage_reservations_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "hosted_usage_reservations_review_idx" ON "hosted_usage_reservations" USING btree ("review_id");
--> statement-breakpoint
CREATE INDEX "hosted_usage_reservations_active_org_expiry_idx" ON "hosted_usage_reservations" USING btree ("org_id","expires_at") WHERE "hosted_usage_reservations"."status" = 'active';
