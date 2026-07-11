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
