ALTER TABLE "hosted_usage_reservations" ALTER COLUMN "review_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "hosted_usage_reservations" ADD COLUMN "operation" text DEFAULT 'review' NOT NULL;
--> statement-breakpoint
ALTER TABLE "hosted_usage_reservations" ADD CONSTRAINT "hosted_usage_reservations_operation_check"
CHECK ("operation" IN ('review', 'respond'));
--> statement-breakpoint
ALTER TABLE "hosted_usage_reservations" ADD CONSTRAINT "hosted_usage_reservations_operation_reference_check"
CHECK (
  ("operation" = 'review' AND "review_id" IS NOT NULL)
  OR ("operation" = 'respond' AND "review_id" IS NULL)
);
