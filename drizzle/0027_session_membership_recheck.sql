ALTER TABLE "sessions" ADD COLUMN "github_access_token_ciphertext" "bytea";--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "membership_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "membership_check_available_at" timestamp with time zone;
