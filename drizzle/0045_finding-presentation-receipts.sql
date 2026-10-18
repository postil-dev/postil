ALTER TABLE "finding_publications" DROP CONSTRAINT "finding_publications_initial_state_check";--> statement-breakpoint
ALTER TABLE "finding_publications" DROP CONSTRAINT "finding_publications_current_state_check";--> statement-breakpoint
ALTER TABLE "review_publication_receipts" DROP CONSTRAINT "review_publication_receipts_identity_check";--> statement-breakpoint
ALTER TABLE "review_publication_receipts" ADD COLUMN "publication_channel" text;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "protect_publication_receipt_identity"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW.review_id IS DISTINCT FROM OLD.review_id
		OR NEW.receipt_version IS DISTINCT FROM OLD.receipt_version
		OR NEW.receipt_id IS DISTINCT FROM OLD.receipt_id
		OR NEW.publication_channel IS DISTINCT FROM OLD.publication_channel
		OR NEW.github_review_id IS DISTINCT FROM OLD.github_review_id
		OR NEW.observed_at IS DISTINCT FROM OLD.observed_at THEN
		RAISE EXCEPTION 'review publication receipt identity is immutable';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
ALTER TABLE "finding_publications" ADD CONSTRAINT "finding_publications_initial_state_check" CHECK ("finding_publications"."initial_state" IN ('inline', 'checkAnnotation', 'summaryOnly', 'carried', 'resolved', 'suppressed', 'inlineRejected', 'unknown'));--> statement-breakpoint
ALTER TABLE "finding_publications" ADD CONSTRAINT "finding_publications_current_state_check" CHECK ("finding_publications"."current_state" IN ('inline', 'checkAnnotation', 'summaryOnly', 'carried', 'resolved', 'suppressed', 'inlineRejected', 'outdated', 'deleted', 'unknown'));--> statement-breakpoint
ALTER TABLE "review_publication_receipts" ADD CONSTRAINT "review_publication_receipts_identity_check" CHECK (("review_publication_receipts"."receipt_version" IS NULL AND "review_publication_receipts"."receipt_id" IS NULL AND "review_publication_receipts"."publication_channel" IS NULL) OR ("review_publication_receipts"."receipt_version" = 1 AND length(btrim("review_publication_receipts"."receipt_id")) BETWEEN 1 AND 200 AND ("review_publication_receipts"."publication_channel" IS NULL OR "review_publication_receipts"."publication_channel" = 'reviewComments')) OR ("review_publication_receipts"."receipt_version" = 2 AND length(btrim("review_publication_receipts"."receipt_id")) BETWEEN 1 AND 200 AND "review_publication_receipts"."publication_channel" IS NOT NULL AND "review_publication_receipts"."publication_channel" IN ('reviewComments', 'checkAnnotations')));
