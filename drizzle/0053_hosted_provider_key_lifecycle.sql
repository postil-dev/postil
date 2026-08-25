CREATE TABLE "hosted_provider_keys" (
	"org_id" bigint PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"provider_key_name" text NOT NULL,
	"sealed_runtime_key" "bytea",
	"provider_key_hash" text,
	"limit_micros" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hosted_provider_keys_state_check" CHECK ("hosted_provider_keys"."state" IN ('provisioning', 'active', 'revocation_pending', 'revoked', 'orphaned')),
	CONSTRAINT "hosted_provider_keys_provider_key_name_nonempty" CHECK (length(btrim("hosted_provider_keys"."provider_key_name")) > 0),
	CONSTRAINT "hosted_provider_keys_provider_key_hash_nonempty" CHECK ("hosted_provider_keys"."provider_key_hash" IS NULL OR length(btrim("hosted_provider_keys"."provider_key_hash")) > 0),
	CONSTRAINT "hosted_provider_keys_limit_micros_nonnegative" CHECK ("hosted_provider_keys"."limit_micros" >= 0),
	CONSTRAINT "hosted_provider_keys_credentials_match_state" CHECK ((
        "hosted_provider_keys"."state" = 'provisioning'
        AND "hosted_provider_keys"."sealed_runtime_key" IS NULL
        AND "hosted_provider_keys"."provider_key_hash" IS NULL
      ) OR (
        "hosted_provider_keys"."state" = 'active'
        AND "hosted_provider_keys"."sealed_runtime_key" IS NOT NULL
        AND "hosted_provider_keys"."provider_key_hash" IS NOT NULL
      ) OR (
        "hosted_provider_keys"."state" IN ('revocation_pending', 'revoked', 'orphaned')
        AND "hosted_provider_keys"."sealed_runtime_key" IS NULL
        AND "hosted_provider_keys"."provider_key_hash" IS NOT NULL
      ))
);
--> statement-breakpoint
ALTER TABLE "hosted_provider_keys" ADD CONSTRAINT "hosted_provider_keys_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;