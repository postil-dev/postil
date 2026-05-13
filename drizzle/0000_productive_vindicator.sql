CREATE TABLE "installations" (
	"id" bigint PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"account_login" text NOT NULL,
	"account_type" text NOT NULL,
	"repository_selection" text NOT NULL,
	"suspended" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"github_login" text,
	"github_installation_id" bigint,
	"polar_customer_id" text,
	"plan" text DEFAULT 'free' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"installation_id" bigint NOT NULL,
	"repo_full_name" text NOT NULL,
	"pull_number" integer NOT NULL,
	"head_sha" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"trigger_run_id" text,
	"result" jsonb,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"review_id" uuid,
	"kind" text NOT NULL,
	"quantity" integer NOT NULL,
	"metadata" jsonb,
	"reported_to_polar_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"image" text,
	"github_id" bigint,
	"github_login" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_github_id_unique" UNIQUE("github_id")
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"delivery_id" text NOT NULL,
	"event" text NOT NULL,
	"payload" jsonb NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "installations" ADD CONSTRAINT "installations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_slug_idx" ON "organizations" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "reviews_pr_sha_idx" ON "reviews" USING btree ("repo_full_name","pull_number","head_sha");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_src_id_idx" ON "webhook_deliveries" USING btree ("source","delivery_id");