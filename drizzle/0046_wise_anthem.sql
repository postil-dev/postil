CREATE TABLE "cli_device_authorizations" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "cli_device_authorizations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"device_code_sha256" "bytea" NOT NULL,
	"user_code" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"user_id" bigint,
	"org_id" bigint,
	"token_id" bigint,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_at" timestamp with time zone,
	"poll_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "cli_device_authorizations_status_check" CHECK ("cli_device_authorizations"."status" IN ('pending', 'approved', 'denied', 'claimed'))
);
--> statement-breakpoint
CREATE TABLE "cli_tokens" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "cli_tokens_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"token_sha256" "bytea" NOT NULL,
	"user_id" bigint NOT NULL,
	"org_id" bigint NOT NULL,
	"scope" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "cli_tokens_scope_check" CHECK ("cli_tokens"."scope" IN ('inference'))
);
--> statement-breakpoint
ALTER TABLE "hosted_usage_reservations" DROP CONSTRAINT "hosted_usage_reservations_operation_check";--> statement-breakpoint
ALTER TABLE "hosted_usage_reservations" DROP CONSTRAINT "hosted_usage_reservations_operation_reference_check";--> statement-breakpoint
ALTER TABLE "cli_device_authorizations" ADD CONSTRAINT "cli_device_authorizations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cli_device_authorizations" ADD CONSTRAINT "cli_device_authorizations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cli_device_authorizations" ADD CONSTRAINT "cli_device_authorizations_token_id_cli_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."cli_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cli_tokens" ADD CONSTRAINT "cli_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cli_tokens" ADD CONSTRAINT "cli_tokens_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cli_device_authorizations_device_code_sha256_idx" ON "cli_device_authorizations" USING btree ("device_code_sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "cli_device_authorizations_user_code_idx" ON "cli_device_authorizations" USING btree ("user_code");--> statement-breakpoint
CREATE UNIQUE INDEX "cli_tokens_token_sha256_idx" ON "cli_tokens" USING btree ("token_sha256");--> statement-breakpoint
CREATE INDEX "cli_tokens_org_created_idx" ON "cli_tokens" USING btree ("org_id","created_at");--> statement-breakpoint
ALTER TABLE "hosted_usage_reservations" ADD CONSTRAINT "hosted_usage_reservations_operation_check" CHECK ("hosted_usage_reservations"."operation" IN ('review', 'respond', 'cli_gateway'));--> statement-breakpoint
ALTER TABLE "hosted_usage_reservations" ADD CONSTRAINT "hosted_usage_reservations_operation_reference_check" CHECK (("hosted_usage_reservations"."operation" = 'review' AND "hosted_usage_reservations"."review_id" IS NOT NULL) OR ("hosted_usage_reservations"."operation" IN ('respond', 'cli_gateway') AND "hosted_usage_reservations"."review_id" IS NULL));
