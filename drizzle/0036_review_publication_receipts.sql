CREATE TABLE "finding_publications" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "finding_publications_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"review_id" bigint NOT NULL,
	"finding_id" text NOT NULL,
	"stable_identity" boolean NOT NULL,
	"initial_state" text NOT NULL,
	"current_state" text NOT NULL,
	"github_comment_id" text,
	"lifecycle_observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finding_publications_finding_id_check" CHECK (length(btrim("finding_publications"."finding_id")) BETWEEN 1 AND 500),
	CONSTRAINT "finding_publications_initial_state_check" CHECK ("finding_publications"."initial_state" IN ('inline', 'summaryOnly', 'carried', 'resolved', 'suppressed', 'inlineRejected', 'unknown')),
	CONSTRAINT "finding_publications_current_state_check" CHECK ("finding_publications"."current_state" IN ('inline', 'summaryOnly', 'carried', 'resolved', 'suppressed', 'inlineRejected', 'outdated', 'deleted', 'unknown')),
	CONSTRAINT "finding_publications_github_comment_id_check" CHECK ("finding_publications"."github_comment_id" IS NULL OR "finding_publications"."github_comment_id" ~ '^[1-9][0-9]{0,19}$')
);
--> statement-breakpoint
CREATE TABLE "review_publication_receipts" (
	"review_id" bigint PRIMARY KEY NOT NULL,
	"receipt_version" integer,
	"receipt_id" text,
	"github_review_id" text,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_publication_receipts_identity_check" CHECK (("review_publication_receipts"."receipt_version" IS NULL AND "review_publication_receipts"."receipt_id" IS NULL) OR ("review_publication_receipts"."receipt_version" = 1 AND length(btrim("review_publication_receipts"."receipt_id")) BETWEEN 1 AND 200)),
	CONSTRAINT "review_publication_receipts_github_review_id_check" CHECK ("review_publication_receipts"."github_review_id" IS NULL OR "review_publication_receipts"."github_review_id" ~ '^[1-9][0-9]{0,19}$')
);
--> statement-breakpoint
ALTER TABLE "finding_publications" ADD CONSTRAINT "finding_publications_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_publication_receipts" ADD CONSTRAINT "review_publication_receipts_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE FUNCTION "protect_publication_receipt_identity"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW.review_id IS DISTINCT FROM OLD.review_id
		OR NEW.receipt_version IS DISTINCT FROM OLD.receipt_version
		OR NEW.receipt_id IS DISTINCT FROM OLD.receipt_id
		OR NEW.github_review_id IS DISTINCT FROM OLD.github_review_id
		OR NEW.observed_at IS DISTINCT FROM OLD.observed_at THEN
		RAISE EXCEPTION 'review publication receipt identity is immutable';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "review_publication_receipts_immutable" BEFORE UPDATE ON "review_publication_receipts"
FOR EACH ROW EXECUTE FUNCTION "protect_publication_receipt_identity"();--> statement-breakpoint
CREATE FUNCTION "protect_finding_publication_identity"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW.review_id IS DISTINCT FROM OLD.review_id
		OR NEW.finding_id IS DISTINCT FROM OLD.finding_id
		OR NEW.stable_identity IS DISTINCT FROM OLD.stable_identity
		OR NEW.initial_state IS DISTINCT FROM OLD.initial_state
		OR NEW.github_comment_id IS DISTINCT FROM OLD.github_comment_id THEN
		RAISE EXCEPTION 'finding publication identity is immutable';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "finding_publications_identity_immutable" BEFORE UPDATE ON "finding_publications"
FOR EACH ROW EXECUTE FUNCTION "protect_finding_publication_identity"();--> statement-breakpoint
CREATE UNIQUE INDEX "finding_publications_review_finding_idx" ON "finding_publications" USING btree ("review_id","finding_id");--> statement-breakpoint
CREATE INDEX "finding_publications_comment_idx" ON "finding_publications" USING btree ("github_comment_id");--> statement-breakpoint
CREATE INDEX "finding_publications_stable_finding_idx" ON "finding_publications" USING btree ("finding_id","stable_identity");
