ALTER TABLE "respond_deliveries" ADD COLUMN "marker_nonce" uuid;--> statement-breakpoint
ALTER TABLE "respond_deliveries" ADD COLUMN "reply_to_review_comment_id" bigint;
