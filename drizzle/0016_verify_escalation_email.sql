ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "escalation_email_pending" text;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "escalation_email_verified_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "escalation_email_verification_token_digest" bytea;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "escalation_email_verification_token_ciphertext" bytea;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "escalation_email_verification_expires_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "escalation_email_verification_requested_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "escalation_email_verification_sent_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "escalation_email_verification_message_id" text;
--> statement-breakpoint
UPDATE "org_settings"
SET
  "escalation_email_pending" = lower(btrim("escalation_email")),
  "escalation_email" = NULL,
  "escalation_email_verified_at" = NULL,
  "escalation_email_verification_token_digest" = NULL,
  "escalation_email_verification_token_ciphertext" = NULL,
  "escalation_email_verification_expires_at" = NULL,
  "escalation_email_verification_requested_at" = NULL,
  "escalation_email_verification_sent_at" = NULL,
  "escalation_email_verification_message_id" = NULL
WHERE "escalation_email" IS NOT NULL
  AND "escalation_email_pending" IS NULL
  AND "escalation_email_verified_at" IS NULL;
