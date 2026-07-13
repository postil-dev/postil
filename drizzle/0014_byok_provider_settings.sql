ALTER TABLE "org_settings" ADD COLUMN "api_format" text DEFAULT 'openai-compatible' NOT NULL;
ALTER TABLE "org_settings" ADD COLUMN "api_auth_header_ciphertext" bytea;
ALTER TABLE "org_settings" ADD COLUMN "api_auth_value_ciphertext" bytea;

ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_api_format_valid"
CHECK ("api_format" IN ('openai-compatible', 'anthropic'));

ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_api_auth_pair"
CHECK (("api_auth_header_ciphertext" IS NULL) = ("api_auth_value_ciphertext" IS NULL));
