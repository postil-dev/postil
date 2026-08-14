SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "pull_request_publication_high_waters" (
	"repository_id" bigint NOT NULL,
	"pr_number" integer NOT NULL,
	"publication_generation" bigint NOT NULL,
	"accepted_review_id" bigint NOT NULL,
	"accepted_input_digest" text NOT NULL,
	"accepted_head_sha" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pull_request_publication_high_waters_pr_number_check" CHECK ("pull_request_publication_high_waters"."pr_number" > 0),
	CONSTRAINT "pull_request_publication_high_waters_generation_check" CHECK ("pull_request_publication_high_waters"."publication_generation" > 0),
	CONSTRAINT "pull_request_publication_high_waters_input_digest_check" CHECK ("pull_request_publication_high_waters"."accepted_input_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "pull_request_publication_high_waters_head_sha_check" CHECK ("pull_request_publication_high_waters"."accepted_head_sha" ~ '^[0-9a-f]{40}([0-9a-f]{24})?$')
);
--> statement-breakpoint
CREATE TABLE "review_publication_generations" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "review_publication_generations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"repository_id" bigint NOT NULL,
	"pr_number" integer NOT NULL,
	"publication_generation" bigint NOT NULL,
	"review_id" bigint NOT NULL,
	"accepted_input_digest" text NOT NULL,
	"head_sha" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_publication_generations_pr_number_check" CHECK ("review_publication_generations"."pr_number" > 0),
	CONSTRAINT "review_publication_generations_generation_check" CHECK ("review_publication_generations"."publication_generation" > 0),
	CONSTRAINT "review_publication_generations_input_digest_check" CHECK ("review_publication_generations"."accepted_input_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "review_publication_generations_head_sha_check" CHECK ("review_publication_generations"."head_sha" ~ '^[0-9a-f]{40}([0-9a-f]{24})?$')
);
--> statement-breakpoint
CREATE TABLE "review_publication_operations" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "review_publication_operations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"repository_id" bigint NOT NULL,
	"pr_number" integer NOT NULL,
	"publication_generation" bigint NOT NULL,
	"review_id" bigint NOT NULL,
	"operation_key" text NOT NULL,
	"kind" text NOT NULL,
	"desired_payload" jsonb NOT NULL,
	"desired_payload_digest" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"retry_after" timestamp with time zone,
	"deadline_at" timestamp with time zone,
	"last_error" text,
	"remote_identity" text,
	"remote_operation_id" text,
	"remote_observed_at" timestamp with time zone,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_publication_operations_pr_number_check" CHECK ("review_publication_operations"."pr_number" > 0),
	CONSTRAINT "review_publication_operations_generation_check" CHECK ("review_publication_operations"."publication_generation" > 0),
	CONSTRAINT "review_publication_operations_key_check" CHECK ("review_publication_operations"."operation_key" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "review_publication_operations_kind_check" CHECK ("review_publication_operations"."kind" ~ '^[a-z][a-z0-9_]{0,99}$'),
	CONSTRAINT "review_publication_operations_payload_check" CHECK (jsonb_typeof("review_publication_operations"."desired_payload") = 'object'),
	CONSTRAINT "review_publication_operations_payload_digest_check" CHECK ("review_publication_operations"."desired_payload_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "review_publication_operations_state_check" CHECK ("review_publication_operations"."state" IN ('pending', 'applying', 'unknown', 'applied', 'superseded', 'compensating', 'failed')),
	CONSTRAINT "review_publication_operations_attempt_count_check" CHECK ("review_publication_operations"."attempt_count" >= 0),
	CONSTRAINT "review_publication_operations_deadline_check" CHECK ("review_publication_operations"."deadline_at" IS NULL OR "review_publication_operations"."deadline_at" >= "review_publication_operations"."created_at"),
	CONSTRAINT "review_publication_operations_error_check" CHECK ("review_publication_operations"."last_error" IS NULL OR length(btrim("review_publication_operations"."last_error")) BETWEEN 1 AND 4000),
	CONSTRAINT "review_publication_operations_remote_identity_check" CHECK ("review_publication_operations"."remote_identity" IS NULL OR length(btrim("review_publication_operations"."remote_identity")) BETWEEN 1 AND 500),
	CONSTRAINT "review_publication_operations_remote_operation_id_check" CHECK ("review_publication_operations"."remote_operation_id" IS NULL OR length(btrim("review_publication_operations"."remote_operation_id")) BETWEEN 1 AND 500)
);
--> statement-breakpoint
ALTER TABLE "pull_request_publication_high_waters" ADD CONSTRAINT "pull_request_publication_high_waters_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_publication_generations" ADD CONSTRAINT "review_publication_generations_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_publication_generations" ADD CONSTRAINT "review_publication_generations_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pull_request_publication_high_waters_pr_idx" ON "pull_request_publication_high_waters" USING btree ("repository_id","pr_number");--> statement-breakpoint
CREATE UNIQUE INDEX "review_publication_generations_pr_generation_idx" ON "review_publication_generations" USING btree ("repository_id","pr_number","publication_generation");--> statement-breakpoint
CREATE UNIQUE INDEX "review_publication_generations_operation_identity_idx" ON "review_publication_generations" USING btree ("repository_id","pr_number","publication_generation","review_id");--> statement-breakpoint
CREATE UNIQUE INDEX "review_publication_generations_identity_idx" ON "review_publication_generations" USING btree ("repository_id","pr_number","publication_generation","review_id","accepted_input_digest","head_sha");--> statement-breakpoint
CREATE UNIQUE INDEX "review_publication_operations_identity_idx" ON "review_publication_operations" USING btree ("repository_id","pr_number","publication_generation","operation_key");--> statement-breakpoint
CREATE INDEX "review_publication_operations_recovery_idx" ON "review_publication_operations" USING btree ("state","retry_after","deadline_at");--> statement-breakpoint
ALTER TABLE "pull_request_publication_high_waters" ADD CONSTRAINT "pull_request_publication_high_waters_generation_fk" FOREIGN KEY ("repository_id","pr_number","publication_generation","accepted_review_id","accepted_input_digest","accepted_head_sha") REFERENCES "public"."review_publication_generations"("repository_id","pr_number","publication_generation","review_id","accepted_input_digest","head_sha") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_publication_operations" ADD CONSTRAINT "review_publication_operations_generation_fk" FOREIGN KEY ("repository_id","pr_number","publication_generation","review_id") REFERENCES "public"."review_publication_generations"("repository_id","pr_number","publication_generation","review_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE FUNCTION "postil_guard_review_publication_generation"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'review publication generation creation time is immutable';
  END IF;

  IF TG_OP = 'UPDATE' AND (
    NEW."repository_id" IS DISTINCT FROM OLD."repository_id"
    OR NEW."pr_number" IS DISTINCT FROM OLD."pr_number"
    OR NEW."publication_generation" IS DISTINCT FROM OLD."publication_generation"
    OR NEW."review_id" IS DISTINCT FROM OLD."review_id"
    OR NEW."accepted_input_digest" IS DISTINCT FROM OLD."accepted_input_digest"
    OR NEW."head_sha" IS DISTINCT FROM OLD."head_sha"
  ) THEN
    RAISE EXCEPTION 'review publication generation identity is immutable';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "reviews"
    WHERE "id" = NEW."review_id"
      AND "repository_id" = NEW."repository_id"
      AND "pr_number" = NEW."pr_number"
      AND "head_sha" = NEW."head_sha"
  ) THEN
    RAISE EXCEPTION 'review publication generation does not match its review identity'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "review_publication_generations_guard_identity"
BEFORE INSERT OR UPDATE ON "review_publication_generations"
FOR EACH ROW EXECUTE FUNCTION "postil_guard_review_publication_generation"();--> statement-breakpoint
CREATE FUNCTION "postil_guard_pull_request_publication_high_water"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."repository_id" IS DISTINCT FROM OLD."repository_id"
       OR NEW."pr_number" IS DISTINCT FROM OLD."pr_number" THEN
      RAISE EXCEPTION 'pull request publication high-water identity is immutable';
    END IF;

    IF NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
      RAISE EXCEPTION 'pull request publication high-water creation time is immutable';
    END IF;

    IF NEW."publication_generation" < OLD."publication_generation" THEN
      RAISE EXCEPTION 'pull request publication generation cannot decrease';
    END IF;

    IF NEW."publication_generation" = OLD."publication_generation" AND (
      NEW."accepted_review_id" IS DISTINCT FROM OLD."accepted_review_id"
      OR NEW."accepted_input_digest" IS DISTINCT FROM OLD."accepted_input_digest"
      OR NEW."accepted_head_sha" IS DISTINCT FROM OLD."accepted_head_sha"
    ) THEN
      RAISE EXCEPTION 'pull request publication identity requires a higher generation';
    END IF;

    IF NEW IS DISTINCT FROM OLD
       AND NEW."updated_at" <= OLD."updated_at" THEN
      RAISE EXCEPTION 'pull request publication high-water updates must advance updated_at';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "pull_request_publication_high_waters_guard_generation"
BEFORE UPDATE ON "pull_request_publication_high_waters"
FOR EACH ROW EXECUTE FUNCTION "postil_guard_pull_request_publication_high_water"();--> statement-breakpoint
CREATE FUNCTION "postil_guard_review_publication_operation_intent"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'review publication operation creation time is immutable';
  END IF;

  IF TG_OP = 'UPDATE' AND (
    NEW."repository_id" IS DISTINCT FROM OLD."repository_id"
    OR NEW."pr_number" IS DISTINCT FROM OLD."pr_number"
    OR NEW."publication_generation" IS DISTINCT FROM OLD."publication_generation"
    OR NEW."review_id" IS DISTINCT FROM OLD."review_id"
    OR NEW."operation_key" IS DISTINCT FROM OLD."operation_key"
    OR NEW."kind" IS DISTINCT FROM OLD."kind"
    OR NEW."desired_payload" IS DISTINCT FROM OLD."desired_payload"
    OR NEW."desired_payload_digest" IS DISTINCT FROM OLD."desired_payload_digest"
  ) THEN
    RAISE EXCEPTION 'review publication operation intent is immutable';
  END IF;

  IF TG_OP = 'UPDATE' AND NEW IS DISTINCT FROM OLD
     AND NEW."updated_at" <= OLD."updated_at" THEN
    RAISE EXCEPTION 'review publication operation updates must advance updated_at';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "review_publication_operations_guard_intent"
BEFORE UPDATE ON "review_publication_operations"
FOR EACH ROW EXECUTE FUNCTION "postil_guard_review_publication_operation_intent"();
