SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "finding_lifecycle_observations" ADD CONSTRAINT "finding_lifecycle_observations_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;
