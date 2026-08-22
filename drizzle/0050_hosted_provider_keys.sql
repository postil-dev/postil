CREATE TABLE "hosted_provider_keys" (
	"org_id" bigint PRIMARY KEY NOT NULL,
	"key_ciphertext" "bytea" NOT NULL,
	"openrouter_key_hash" text NOT NULL,
	"key_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "hosted_provider_keys" ADD CONSTRAINT "hosted_provider_keys_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
