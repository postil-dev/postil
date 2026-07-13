CREATE TABLE "organization_entitlements" (
	"org_id" bigint PRIMARY KEY NOT NULL,
	"subscription_mode" text NOT NULL,
	"status" text NOT NULL,
	"trial_ends_at" timestamp with time zone,
	"past_due_grace_ends_at" timestamp with time zone,
	"period_starts_at" timestamp with time zone,
	"period_ends_at" timestamp with time zone,
	"included_usage_cents" integer DEFAULT 0 NOT NULL,
	"overage_hard_cap_cents" integer DEFAULT 0,
	"billing_contact_email" text,
	"billing_contact_verified_at" timestamp with time zone,
	"promotional_eligible" boolean DEFAULT false NOT NULL,
	"promotional_ends_at" timestamp with time zone,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_entitlements_subscription_mode_check" CHECK ("organization_entitlements"."subscription_mode" IN ('hosted', 'byok')),
	CONSTRAINT "organization_entitlements_status_check" CHECK ("organization_entitlements"."status" IN ('active', 'trialing', 'past_due', 'suspended')),
	CONSTRAINT "organization_entitlements_included_usage_nonnegative" CHECK ("organization_entitlements"."included_usage_cents" >= 0),
	CONSTRAINT "organization_entitlements_overage_cap_nonnegative" CHECK ("organization_entitlements"."overage_hard_cap_cents" IS NULL OR "organization_entitlements"."overage_hard_cap_cents" >= 0),
	CONSTRAINT "organization_entitlements_updated_by_nonempty" CHECK (length(btrim("organization_entitlements"."updated_by")) > 0)
);
--> statement-breakpoint
ALTER TABLE "organization_entitlements" ADD CONSTRAINT "organization_entitlements_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "author_github_id" bigint;
--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "author_login" text;
