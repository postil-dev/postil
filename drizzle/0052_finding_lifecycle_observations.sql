SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "finding_lifecycle_observations" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "finding_lifecycle_observations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"review_id" bigint NOT NULL,
	"source_delivery_id" text NOT NULL,
	"webhook_action" text NOT NULL,
	"finding_id" text NOT NULL,
	"github_comment_id" text NOT NULL,
	"observed_state" text NOT NULL,
	"resolver_github_id" text,
	"resolver_login" text,
	"resolution_authorized" boolean NOT NULL,
	"forge_observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finding_lifecycle_observations_delivery_check" CHECK (length(btrim("finding_lifecycle_observations"."source_delivery_id")) BETWEEN 1 AND 200),
	CONSTRAINT "finding_lifecycle_observations_action_check" CHECK ("finding_lifecycle_observations"."webhook_action" = 'resolved'),
	CONSTRAINT "finding_lifecycle_observations_finding_check" CHECK (length(btrim("finding_lifecycle_observations"."finding_id")) BETWEEN 1 AND 500),
	CONSTRAINT "finding_lifecycle_observations_comment_check" CHECK ("finding_lifecycle_observations"."github_comment_id" ~ '^[1-9][0-9]{0,19}$'),
	CONSTRAINT "finding_lifecycle_observations_state_check" CHECK ("finding_lifecycle_observations"."observed_state" = 'resolved'),
	CONSTRAINT "finding_lifecycle_observations_resolver_check" CHECK (("finding_lifecycle_observations"."resolution_authorized" = false) OR ("finding_lifecycle_observations"."resolver_github_id" ~ '^[1-9][0-9]{0,19}$' AND length(btrim("finding_lifecycle_observations"."resolver_login")) BETWEEN 1 AND 100))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "finding_lifecycle_observations_delivery_comment_idx" ON "finding_lifecycle_observations" USING btree ("source_delivery_id","github_comment_id","observed_state");--> statement-breakpoint
CREATE INDEX "finding_lifecycle_observations_finding_idx" ON "finding_lifecycle_observations" USING btree ("finding_id","created_at");--> statement-breakpoint
CREATE FUNCTION "postil_guard_finding_publication_comment_identity"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW."github_comment_id" IS NULL THEN
		RETURN NEW;
	END IF;

	PERFORM pg_advisory_xact_lock(
		hashtextextended(
			'postil:finding-publication-comment:' || NEW."github_comment_id",
			0
		)
	);

	IF EXISTS (
		SELECT 1
		FROM "finding_publications" publication
		WHERE publication."github_comment_id" = NEW."github_comment_id"
			AND publication."finding_id" <> NEW."finding_id"
			AND publication."id" IS DISTINCT FROM NEW."id"
	) THEN
		RAISE EXCEPTION 'GitHub publication comment identity already belongs to another finding'
			USING ERRCODE = 'unique_violation';
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "finding_publications_guard_comment_identity"
BEFORE INSERT OR UPDATE OF "finding_id", "github_comment_id" ON "finding_publications"
FOR EACH ROW EXECUTE FUNCTION "postil_guard_finding_publication_comment_identity"();
