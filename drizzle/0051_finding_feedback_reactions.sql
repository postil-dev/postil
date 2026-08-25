CREATE TABLE "finding_feedback_reconciliations" (
	"finding_publication_id" bigint PRIMARY KEY NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_reconcile_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_successful_at" timestamp with time zone,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finding_feedback_reconcile_attempt_count_check" CHECK ("finding_feedback_reconciliations"."attempt_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "finding_feedback" DROP CONSTRAINT "finding_feedback_identity_check";--> statement-breakpoint
ALTER TABLE "operator_alert_deliveries" DROP CONSTRAINT "operator_alert_deliveries_event_check";--> statement-breakpoint
ALTER TABLE "finding_feedback" ADD COLUMN "reaction_content" text;--> statement-breakpoint
ALTER TABLE "finding_feedback_reconciliations" ADD CONSTRAINT "finding_feedback_reconciliations_finding_publication_id_finding_publications_id_fk" FOREIGN KEY ("finding_publication_id") REFERENCES "public"."finding_publications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "finding_feedback_reconcile_due_idx" ON "finding_feedback_reconciliations" USING btree ("next_reconcile_at");--> statement-breakpoint
ALTER TABLE "finding_feedback" ADD CONSTRAINT "finding_feedback_identity_check" CHECK (("finding_feedback"."source" = 'reply' AND "finding_feedback"."source_github_comment_id" IS NOT NULL AND "finding_feedback"."source_github_comment_id" BETWEEN 1 AND 9007199254740991 AND "finding_feedback"."source_github_reaction_id" IS NULL AND "finding_feedback"."reaction_content" IS NULL AND "finding_feedback"."body" IS NOT NULL AND length(btrim("finding_feedback"."body")) BETWEEN 1 AND 65535 AND length(btrim("finding_feedback"."source_delivery_id")) BETWEEN 1 AND 200) OR ("finding_feedback"."source" = 'reaction' AND "finding_feedback"."source_github_comment_id" IS NOT NULL AND "finding_feedback"."source_github_comment_id" BETWEEN 1 AND 9007199254740991 AND "finding_feedback"."source_github_reaction_id" IS NOT NULL AND "finding_feedback"."source_github_reaction_id" BETWEEN 1 AND 9007199254740991 AND "finding_feedback"."reaction_content" IS NOT NULL AND "finding_feedback"."reaction_content" IN ('+1', '-1') AND "finding_feedback"."body" IS NULL AND "finding_feedback"."source_delivery_id" IS NULL));--> statement-breakpoint
ALTER TABLE "operator_alert_deliveries" ADD CONSTRAINT "operator_alert_deliveries_event_check" CHECK ("operator_alert_deliveries"."event" IN ('trial_started', 'trial_expired', 'installation_removed', 'subscription_started', 'subscription_past_due', 'subscription_paused', 'subscription_canceled', 'billing_anomaly', 'finding_feedback_digest'));
