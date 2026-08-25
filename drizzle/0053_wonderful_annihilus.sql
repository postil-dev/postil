CREATE TABLE "hosted_provider_keys" (
	"create_intent_id" uuid PRIMARY KEY NOT NULL,
	"org_id" bigint NOT NULL,
	"state" text NOT NULL,
	"provider_key_name" text NOT NULL,
	"provider_key_hash" text,
	"conflicting_provider_key_hash" text,
	"sealed_runtime_key" "bytea",
	"entitlement_period_starts_at" timestamp with time zone NOT NULL,
	"entitlement_period_ends_at" timestamp with time zone NOT NULL,
	"entitlement_updated_at" timestamp with time zone NOT NULL,
	"limit_micros" bigint NOT NULL,
	"create_attempted_at" timestamp with time zone,
	"create_outcome" text,
	"revocation_requested_at" timestamp with time zone,
	"revoke_attempted_at" timestamp with time zone,
	"revoke_outcome" text,
	"revoked_at" timestamp with time zone,
	"reconciliation_required_at" timestamp with time zone,
	"lease_id" uuid,
	"lease_kind" text,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "hosted_provider_keys_provider_key_name_unique" UNIQUE("provider_key_name"),
	CONSTRAINT "hosted_provider_keys_state_check" CHECK ("hosted_provider_keys"."state" IN ('provisioning', 'activating', 'active', 'rejected', 'orphaned', 'revocation_pending', 'revoked', 'cancelled')),
	CONSTRAINT "hosted_provider_keys_provider_key_name_nonempty" CHECK (length(btrim("hosted_provider_keys"."provider_key_name")) > 0),
	CONSTRAINT "hosted_provider_keys_provider_key_hash_nonempty" CHECK ("hosted_provider_keys"."provider_key_hash" IS NULL OR length(btrim("hosted_provider_keys"."provider_key_hash")) > 0),
	CONSTRAINT "hosted_provider_keys_conflicting_hash_nonempty" CHECK ("hosted_provider_keys"."conflicting_provider_key_hash" IS NULL OR length(btrim("hosted_provider_keys"."conflicting_provider_key_hash")) > 0),
	CONSTRAINT "hosted_provider_keys_entitlement_period_check" CHECK ("hosted_provider_keys"."entitlement_period_ends_at" > "hosted_provider_keys"."entitlement_period_starts_at"),
	CONSTRAINT "hosted_provider_keys_limit_exact_range" CHECK ("hosted_provider_keys"."limit_micros" > 0 AND "hosted_provider_keys"."limit_micros" <= 2251799813685247),
	CONSTRAINT "hosted_provider_keys_create_outcome_check" CHECK ("hosted_provider_keys"."create_outcome" IS NULL OR "hosted_provider_keys"."create_outcome" IN ('created', 'rejected', 'ambiguous', 'name_present', 'name_not_unique', 'credential_persistence_failed', 'intent_changed', 'ownership_conflict')),
	CONSTRAINT "hosted_provider_keys_revoke_outcome_check" CHECK ("hosted_provider_keys"."revoke_outcome" IS NULL OR "hosted_provider_keys"."revoke_outcome" IN ('ambiguous', 'rejected', 'disabled', 'absent')),
	CONSTRAINT "hosted_provider_keys_lease_shape" CHECK ((
        "hosted_provider_keys"."lease_id" IS NULL
        AND "hosted_provider_keys"."lease_kind" IS NULL
        AND "hosted_provider_keys"."lease_expires_at" IS NULL
      ) OR (
        "hosted_provider_keys"."lease_id" IS NOT NULL
        AND "hosted_provider_keys"."lease_kind" IN ('create', 'revoke')
        AND "hosted_provider_keys"."lease_expires_at" IS NOT NULL
      )),
	CONSTRAINT "hosted_provider_keys_lease_state" CHECK ("hosted_provider_keys"."lease_id" IS NULL OR (
        ("hosted_provider_keys"."lease_kind" = 'create' AND "hosted_provider_keys"."state" IN ('provisioning', 'activating', 'orphaned'))
        OR ("hosted_provider_keys"."lease_kind" = 'revoke' AND "hosted_provider_keys"."state" = 'revocation_pending')
      )),
	CONSTRAINT "hosted_provider_keys_lifecycle_shape" CHECK ((
        "hosted_provider_keys"."state" = 'provisioning'
        AND "hosted_provider_keys"."sealed_runtime_key" IS NULL
        AND "hosted_provider_keys"."provider_key_hash" IS NULL
        AND "hosted_provider_keys"."conflicting_provider_key_hash" IS NULL
        AND "hosted_provider_keys"."create_outcome" IS NULL
        AND "hosted_provider_keys"."revocation_requested_at" IS NULL
        AND "hosted_provider_keys"."revoke_outcome" IS NULL
        AND "hosted_provider_keys"."revoked_at" IS NULL
      ) OR (
        "hosted_provider_keys"."state" = 'activating'
        AND "hosted_provider_keys"."sealed_runtime_key" IS NULL
        AND "hosted_provider_keys"."provider_key_hash" IS NOT NULL
        AND "hosted_provider_keys"."conflicting_provider_key_hash" IS NULL
        AND "hosted_provider_keys"."create_attempted_at" IS NOT NULL
        AND "hosted_provider_keys"."create_outcome" = 'created'
        AND "hosted_provider_keys"."reconciliation_required_at" IS NOT NULL
        AND "hosted_provider_keys"."revocation_requested_at" IS NULL
        AND "hosted_provider_keys"."revoke_outcome" IS NULL
        AND "hosted_provider_keys"."revoked_at" IS NULL
      ) OR (
        "hosted_provider_keys"."state" = 'active'
        AND "hosted_provider_keys"."sealed_runtime_key" IS NOT NULL
        AND "hosted_provider_keys"."provider_key_hash" IS NOT NULL
        AND "hosted_provider_keys"."conflicting_provider_key_hash" IS NULL
        AND "hosted_provider_keys"."create_attempted_at" IS NOT NULL
        AND "hosted_provider_keys"."create_outcome" = 'created'
        AND "hosted_provider_keys"."reconciliation_required_at" IS NULL
        AND "hosted_provider_keys"."revocation_requested_at" IS NULL
        AND "hosted_provider_keys"."revoke_outcome" IS NULL
        AND "hosted_provider_keys"."revoked_at" IS NULL
      ) OR (
        "hosted_provider_keys"."state" = 'rejected'
        AND "hosted_provider_keys"."sealed_runtime_key" IS NULL
        AND "hosted_provider_keys"."provider_key_hash" IS NULL
        AND "hosted_provider_keys"."conflicting_provider_key_hash" IS NULL
        AND "hosted_provider_keys"."create_attempted_at" IS NOT NULL
        AND "hosted_provider_keys"."create_outcome" = 'rejected'
        AND "hosted_provider_keys"."reconciliation_required_at" IS NULL
        AND "hosted_provider_keys"."revocation_requested_at" IS NULL
        AND "hosted_provider_keys"."revoke_outcome" IS NULL
        AND "hosted_provider_keys"."revoked_at" IS NULL
      ) OR (
        "hosted_provider_keys"."state" = 'orphaned'
        AND "hosted_provider_keys"."sealed_runtime_key" IS NULL
        AND "hosted_provider_keys"."create_outcome" IN ('ambiguous', 'name_present', 'name_not_unique', 'credential_persistence_failed', 'intent_changed', 'ownership_conflict')
        AND "hosted_provider_keys"."reconciliation_required_at" IS NOT NULL
        AND "hosted_provider_keys"."revocation_requested_at" IS NULL
        AND "hosted_provider_keys"."revoke_outcome" IS NULL
        AND "hosted_provider_keys"."revoked_at" IS NULL
        AND (
          ("hosted_provider_keys"."create_outcome" = 'ownership_conflict' AND "hosted_provider_keys"."provider_key_hash" IS NULL AND "hosted_provider_keys"."conflicting_provider_key_hash" IS NOT NULL)
          OR ("hosted_provider_keys"."create_outcome" <> 'ownership_conflict' AND "hosted_provider_keys"."conflicting_provider_key_hash" IS NULL)
        )
      ) OR (
        "hosted_provider_keys"."state" = 'revocation_pending'
        AND "hosted_provider_keys"."sealed_runtime_key" IS NULL
        AND "hosted_provider_keys"."provider_key_hash" IS NOT NULL
        AND "hosted_provider_keys"."conflicting_provider_key_hash" IS NULL
        AND "hosted_provider_keys"."create_attempted_at" IS NOT NULL
        AND "hosted_provider_keys"."create_outcome" IN ('created', 'ambiguous', 'credential_persistence_failed')
        AND "hosted_provider_keys"."revocation_requested_at" IS NOT NULL
        AND "hosted_provider_keys"."reconciliation_required_at" IS NOT NULL
        AND "hosted_provider_keys"."revoked_at" IS NULL
      ) OR (
        "hosted_provider_keys"."state" = 'revoked'
        AND "hosted_provider_keys"."sealed_runtime_key" IS NULL
        AND "hosted_provider_keys"."provider_key_hash" IS NOT NULL
        AND "hosted_provider_keys"."conflicting_provider_key_hash" IS NULL
        AND "hosted_provider_keys"."create_attempted_at" IS NOT NULL
        AND "hosted_provider_keys"."create_outcome" IN ('created', 'ambiguous', 'credential_persistence_failed')
        AND "hosted_provider_keys"."revocation_requested_at" IS NOT NULL
        AND "hosted_provider_keys"."revoke_outcome" IN ('disabled', 'absent')
        AND "hosted_provider_keys"."revoked_at" IS NOT NULL
        AND "hosted_provider_keys"."reconciliation_required_at" IS NULL
        AND "hosted_provider_keys"."lease_id" IS NULL
      ) OR (
        "hosted_provider_keys"."state" = 'cancelled'
        AND "hosted_provider_keys"."sealed_runtime_key" IS NULL
        AND "hosted_provider_keys"."provider_key_hash" IS NULL
        AND "hosted_provider_keys"."conflicting_provider_key_hash" IS NULL
        AND "hosted_provider_keys"."create_attempted_at" IS NULL
        AND "hosted_provider_keys"."create_outcome" IS NULL
        AND "hosted_provider_keys"."revocation_requested_at" IS NULL
        AND "hosted_provider_keys"."revoke_outcome" IS NULL
        AND "hosted_provider_keys"."revoked_at" IS NULL
        AND "hosted_provider_keys"."reconciliation_required_at" IS NULL
        AND "hosted_provider_keys"."lease_id" IS NULL
      ))
);
--> statement-breakpoint
ALTER TABLE "organization_entitlements" ALTER COLUMN "included_usage_micros" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "organization_entitlements" ALTER COLUMN "overage_hard_cap_micros" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "hosted_provider_keys" ADD CONSTRAINT "hosted_provider_keys_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hosted_provider_keys_provider_key_hash_unique" ON "hosted_provider_keys" USING btree ("provider_key_hash") WHERE "hosted_provider_keys"."provider_key_hash" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "hosted_provider_keys_entitlement_binding_unique" ON "hosted_provider_keys" USING btree ("org_id","entitlement_period_starts_at","entitlement_period_ends_at","limit_micros");--> statement-breakpoint
CREATE UNIQUE INDEX "hosted_provider_keys_active_org_unique" ON "hosted_provider_keys" USING btree ("org_id") WHERE "hosted_provider_keys"."state" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "hosted_provider_keys_runtime_org_unique" ON "hosted_provider_keys" USING btree ("org_id") WHERE "hosted_provider_keys"."sealed_runtime_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "hosted_provider_keys_reconciliation_idx" ON "hosted_provider_keys" USING btree ("state","reconciliation_required_at");
