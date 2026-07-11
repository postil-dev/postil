ALTER TABLE "usage_events" ADD COLUMN "cost_cents" integer;
--> statement-breakpoint
UPDATE "usage_events"
SET "cost_cents" = CASE "model_used"
	WHEN 'deepseek/deepseek-v4-pro' THEN CEIL(("prompt_tokens" * 0.000000435 + "completion_tokens" * 0.00000087) * 100 - 0.000000001)::integer
	WHEN 'moonshotai/kimi-k2.6' THEN CEIL(("prompt_tokens" * 0.00000066 + "completion_tokens" * 0.00000341) * 100 - 0.000000001)::integer
	WHEN 'deepseek/deepseek-v4-flash' THEN CEIL(("prompt_tokens" * 0.00000009 + "completion_tokens" * 0.00000018) * 100 - 0.000000001)::integer
	WHEN 'qwen/qwen3-32b' THEN CEIL(("prompt_tokens" * 0.00000008 + "completion_tokens" * 0.00000028) * 100 - 0.000000001)::integer
	WHEN 'mistralai/mistral-small-3.2-24b-instruct' THEN CEIL(("prompt_tokens" * 0.000000075 + "completion_tokens" * 0.0000002) * 100 - 0.000000001)::integer
	WHEN 'google/gemma-3-27b-it' THEN CEIL(("prompt_tokens" * 0.00000008 + "completion_tokens" * 0.00000016) * 100 - 0.000000001)::integer
	ELSE NULL
END
WHERE "cost_cents" IS NULL;
--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_cost_cents_nonnegative" CHECK ("usage_events"."cost_cents" IS NULL OR "usage_events"."cost_cents" >= 0);
--> statement-breakpoint
CREATE TABLE "billing_credit_grants" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "billing_credit_grants_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"org_id" bigint NOT NULL,
	"amount_cents" integer NOT NULL,
	"reason" text NOT NULL,
	"actor" text NOT NULL,
	"source" text DEFAULT 'admin_script' NOT NULL,
	"idempotency_key" text NOT NULL,
	"applies_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_credit_grants_amount_cents_positive" CHECK ("billing_credit_grants"."amount_cents" > 0),
	CONSTRAINT "billing_credit_grants_reason_nonempty" CHECK (length(btrim("billing_credit_grants"."reason")) > 0),
	CONSTRAINT "billing_credit_grants_actor_nonempty" CHECK (length(btrim("billing_credit_grants"."actor")) > 0),
	CONSTRAINT "billing_credit_grants_source_nonempty" CHECK (length(btrim("billing_credit_grants"."source")) > 0),
	CONSTRAINT "billing_credit_grants_idempotency_key_nonempty" CHECK (length(btrim("billing_credit_grants"."idempotency_key")) > 0)
);
--> statement-breakpoint
ALTER TABLE "billing_credit_grants" ADD CONSTRAINT "billing_credit_grants_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "billing_credit_grants_org_created_idx" ON "billing_credit_grants" USING btree ("org_id","created_at","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "billing_credit_grants_org_idempotency_idx" ON "billing_credit_grants" USING btree ("org_id","idempotency_key");
