ALTER TABLE "organization_entitlements" ADD COLUMN "billing_contact_pending" text;
--> statement-breakpoint
ALTER TABLE "organization_entitlements" ADD COLUMN "billing_contact_verification_token_digest" bytea;
--> statement-breakpoint
ALTER TABLE "organization_entitlements" ADD COLUMN "billing_contact_verification_token_ciphertext" bytea;
--> statement-breakpoint
ALTER TABLE "organization_entitlements" ADD COLUMN "billing_contact_verification_expires_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "organization_entitlements" ADD COLUMN "billing_contact_verification_requested_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "organization_entitlements" ADD COLUMN "billing_contact_verification_sent_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "organization_entitlements" ADD COLUMN "billing_contact_verification_message_id" text;
--> statement-breakpoint
UPDATE "organization_entitlements"
SET
  "billing_contact_pending" = lower(btrim("billing_contact_email")),
  "billing_contact_email" = NULL,
  "billing_contact_verified_at" = NULL,
  "billing_contact_verification_token_digest" = NULL,
  "billing_contact_verification_token_ciphertext" = NULL,
  "billing_contact_verification_expires_at" = NULL,
  "billing_contact_verification_requested_at" = NULL,
  "billing_contact_verification_sent_at" = NULL,
  "billing_contact_verification_message_id" = NULL
WHERE "billing_contact_email" IS NOT NULL
  AND "billing_contact_verified_at" IS NULL
  AND "billing_contact_pending" IS NULL;
