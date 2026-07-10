CREATE TABLE "review_logs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "review_logs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"review_id" bigint NOT NULL,
	"seq" integer NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"line" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "public_id" uuid;--> statement-breakpoint
UPDATE "reviews" SET "public_id" = gen_random_uuid() WHERE "public_id" IS NULL;--> statement-breakpoint
ALTER TABLE "reviews" ALTER COLUMN "public_id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "reviews" ALTER COLUMN "public_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "review_logs" ADD CONSTRAINT "review_logs_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "review_logs_review_seq_idx" ON "review_logs" USING btree ("review_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "reviews_public_id_idx" ON "reviews" USING btree ("public_id");
