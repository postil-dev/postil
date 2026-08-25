CREATE TABLE "cli_refresh_sessions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "cli_refresh_sessions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" bigint NOT NULL,
	"org_id" bigint NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "cli_refresh_sessions_expiry_check" CHECK ("cli_refresh_sessions"."expires_at" > "cli_refresh_sessions"."created_at")
);
--> statement-breakpoint
CREATE TABLE "cli_refresh_tokens" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "cli_refresh_tokens_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"token_sha256" "bytea" NOT NULL,
	"session_id" bigint NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "cli_refresh_tokens_expiry_check" CHECK ("cli_refresh_tokens"."expires_at" > "cli_refresh_tokens"."created_at"),
	CONSTRAINT "cli_refresh_tokens_consumed_after_created_check" CHECK ("cli_refresh_tokens"."consumed_at" IS NULL OR "cli_refresh_tokens"."consumed_at" >= "cli_refresh_tokens"."created_at")
);
--> statement-breakpoint
ALTER TABLE "cli_tokens" ADD COLUMN "refresh_session_id" bigint;--> statement-breakpoint
ALTER TABLE "cli_refresh_sessions" ADD CONSTRAINT "cli_refresh_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cli_refresh_sessions" ADD CONSTRAINT "cli_refresh_sessions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cli_refresh_tokens" ADD CONSTRAINT "cli_refresh_tokens_session_id_cli_refresh_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."cli_refresh_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cli_refresh_sessions_expiry_idx" ON "cli_refresh_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "cli_refresh_tokens_token_sha256_idx" ON "cli_refresh_tokens" USING btree ("token_sha256");--> statement-breakpoint
CREATE INDEX "cli_refresh_tokens_session_idx" ON "cli_refresh_tokens" USING btree ("session_id");--> statement-breakpoint
ALTER TABLE "cli_tokens" ADD CONSTRAINT "cli_tokens_refresh_session_id_cli_refresh_sessions_id_fk" FOREIGN KEY ("refresh_session_id") REFERENCES "public"."cli_refresh_sessions"("id") ON DELETE cascade ON UPDATE no action;
