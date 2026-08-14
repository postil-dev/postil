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
	CONSTRAINT "pull_request_publication_high_waters_head_sha_check" CHECK ("pull_request_publication_high_waters"."accepted_head_sha" ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
	CONSTRAINT "pull_request_publication_high_waters_timestamps_check" CHECK (isfinite("pull_request_publication_high_waters"."created_at") AND isfinite("pull_request_publication_high_waters"."updated_at"))
);
--> statement-breakpoint
CREATE TABLE "review_publication_generations" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "review_publication_generations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"repository_id" bigint NOT NULL,
	"pr_number" integer NOT NULL,
	"publication_generation" bigint NOT NULL,
	"review_id" bigint NOT NULL,
	"plan_version" text NOT NULL,
	"accepted_plan" jsonb NOT NULL,
	"accepted_plan_bytes" "bytea" NOT NULL,
	"accepted_plan_digest" text NOT NULL,
	"plan_semantic_digest" text NOT NULL,
	"review_input_sequence" bigint NOT NULL,
	"expected_pull_request_updated_at" timestamp with time zone NOT NULL,
	"accepted_input_digest" text NOT NULL,
	"envelope_digest" text NOT NULL,
	"repository_full_name" text NOT NULL,
	"head_sha" text NOT NULL,
	"base_sha" text NOT NULL,
	"target_sha" text NOT NULL,
	"target_branch" text NOT NULL,
	"pull_request_title" text NOT NULL,
	"pull_request_body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_publication_generations_pr_number_check" CHECK ("review_publication_generations"."pr_number" > 0),
	CONSTRAINT "review_publication_generations_generation_check" CHECK ("review_publication_generations"."publication_generation" > 0),
	CONSTRAINT "review_publication_generations_input_digest_check" CHECK ("review_publication_generations"."accepted_input_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "review_publication_generations_plan_check" CHECK ("review_publication_generations"."plan_version" ~ '^github-publication-v[1-9][0-9]{0,8}$' AND jsonb_typeof("review_publication_generations"."accepted_plan") = 'object' AND octet_length("review_publication_generations"."accepted_plan_bytes") BETWEEN 2 AND 8388608 AND convert_from("review_publication_generations"."accepted_plan_bytes", 'UTF8')::jsonb = "review_publication_generations"."accepted_plan" AND "review_publication_generations"."accepted_plan_digest" ~ '^[0-9a-f]{64}$' AND "review_publication_generations"."accepted_plan_digest" = encode(sha256("review_publication_generations"."accepted_plan_bytes"), 'hex')),
	CONSTRAINT "review_publication_generations_plan_semantic_digest_check" CHECK ("review_publication_generations"."plan_semantic_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "review_publication_generations_review_input_sequence_check" CHECK ("review_publication_generations"."review_input_sequence" > 0),
	CONSTRAINT "review_publication_generations_envelope_digest_check" CHECK ("review_publication_generations"."envelope_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "review_publication_generations_repository_snapshot_check" CHECK (length("review_publication_generations"."repository_full_name") BETWEEN 3 AND 200 AND "review_publication_generations"."repository_full_name" ~ '^[^/[:space:]]+/[^/[:space:]]+$'),
	CONSTRAINT "review_publication_generations_head_sha_check" CHECK ("review_publication_generations"."head_sha" ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
	CONSTRAINT "review_publication_generations_base_sha_check" CHECK ("review_publication_generations"."base_sha" ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
	CONSTRAINT "review_publication_generations_target_sha_check" CHECK ("review_publication_generations"."target_sha" ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
	CONSTRAINT "review_publication_generations_pull_request_snapshot_check" CHECK (length(btrim("review_publication_generations"."target_branch")) BETWEEN 1 AND 255 AND length(btrim("review_publication_generations"."pull_request_title")) BETWEEN 1 AND 512 AND length("review_publication_generations"."pull_request_body") <= 65536),
	CONSTRAINT "review_publication_generations_created_at_check" CHECK (isfinite("review_publication_generations"."expected_pull_request_updated_at") AND isfinite("review_publication_generations"."created_at"))
);
--> statement-breakpoint
CREATE TABLE "review_publication_operations" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "review_publication_operations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"repository_id" bigint NOT NULL,
	"pr_number" integer NOT NULL,
	"publication_generation" bigint NOT NULL,
	"review_id" bigint NOT NULL,
	"operation_key" text NOT NULL,
	"operation_ordinal" integer NOT NULL,
	"dependency_operation_key" text,
	"activation_condition" text NOT NULL,
	"kind" text NOT NULL,
	"desired_payload" jsonb NOT NULL,
	"desired_payload_bytes" "bytea" NOT NULL,
	"desired_payload_digest" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"claim_owner" text,
	"lease_id" uuid,
	"lease_expires_at" timestamp with time zone,
	"lease_generation" bigint DEFAULT 0 NOT NULL,
	"retry_after" timestamp with time zone,
	"deadline_at" timestamp with time zone,
	"last_error" text,
	"remote_identity" text,
	"remote_operation_id" text,
	"remote_observed_at" timestamp with time zone,
	"applied_at" timestamp with time zone,
	"result_payload" jsonb,
	"selected_variant" text,
	"reconciliation_payload" jsonb,
	"compensated_at" timestamp with time zone,
	"compensation_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_publication_operations_pr_number_check" CHECK ("review_publication_operations"."pr_number" > 0),
	CONSTRAINT "review_publication_operations_generation_check" CHECK ("review_publication_operations"."publication_generation" > 0),
	CONSTRAINT "review_publication_operations_key_check" CHECK ("review_publication_operations"."operation_key" ~ '^github-publication-v1:[a-z][a-z0-9-]{0,99}:sha256:[0-9a-f]{64}$'),
	CONSTRAINT "review_publication_operations_ordinal_check" CHECK ("review_publication_operations"."operation_ordinal" BETWEEN 0 AND 100000),
	CONSTRAINT "review_publication_operations_activation_check" CHECK (("review_publication_operations"."activation_condition" = 'immediate' AND "review_publication_operations"."dependency_operation_key" IS NULL) OR ("review_publication_operations"."activation_condition" IN ('after_dependency_applied', 'after_dependency_terminal', 'after_dependency_failed') AND "review_publication_operations"."dependency_operation_key" IS NOT NULL AND "review_publication_operations"."dependency_operation_key" <> "review_publication_operations"."operation_key")),
	CONSTRAINT "review_publication_operations_kind_check" CHECK ("review_publication_operations"."kind" ~ '^[a-z][a-z0-9_]{0,99}$'),
	CONSTRAINT "review_publication_operations_payload_check" CHECK (jsonb_typeof("review_publication_operations"."desired_payload") = 'object' AND octet_length("review_publication_operations"."desired_payload_bytes") BETWEEN 2 AND 1048576 AND convert_from("review_publication_operations"."desired_payload_bytes", 'UTF8')::jsonb = "review_publication_operations"."desired_payload"),
	CONSTRAINT "review_publication_operations_payload_digest_check" CHECK ("review_publication_operations"."desired_payload_digest" ~ '^[0-9a-f]{64}$' AND "review_publication_operations"."desired_payload_digest" = encode(sha256("review_publication_operations"."desired_payload_bytes"), 'hex')),
	CONSTRAINT "review_publication_operations_state_check" CHECK ("review_publication_operations"."state" IN ('pending', 'applying', 'unknown', 'applied', 'skipped', 'superseded', 'compensating', 'failed')),
	CONSTRAINT "review_publication_operations_attempt_count_check" CHECK ("review_publication_operations"."attempt_count" BETWEEN 0 AND 1000000),
	CONSTRAINT "review_publication_operations_lease_generation_check" CHECK ("review_publication_operations"."lease_generation" >= 0),
	CONSTRAINT "review_publication_operations_deadline_check" CHECK ("review_publication_operations"."deadline_at" IS NULL OR "review_publication_operations"."deadline_at" >= "review_publication_operations"."created_at"),
	CONSTRAINT "review_publication_operations_error_check" CHECK ("review_publication_operations"."last_error" IS NULL OR length(btrim("review_publication_operations"."last_error")) BETWEEN 1 AND 4000),
	CONSTRAINT "review_publication_operations_remote_identity_check" CHECK ("review_publication_operations"."remote_identity" IS NULL OR length(btrim("review_publication_operations"."remote_identity")) BETWEEN 1 AND 500),
	CONSTRAINT "review_publication_operations_remote_operation_id_check" CHECK ("review_publication_operations"."remote_operation_id" IS NULL OR length(btrim("review_publication_operations"."remote_operation_id")) BETWEEN 1 AND 500),
	CONSTRAINT "review_publication_operations_claim_owner_check" CHECK ("review_publication_operations"."claim_owner" IS NULL OR length(btrim("review_publication_operations"."claim_owner")) BETWEEN 1 AND 200),
	CONSTRAINT "review_publication_operations_evidence_payloads_check" CHECK (("review_publication_operations"."result_payload" IS NULL OR (jsonb_typeof("review_publication_operations"."result_payload") = 'object' AND "review_publication_operations"."result_payload" <> '{}'::jsonb AND pg_column_size("review_publication_operations"."result_payload") <= 1048576)) AND ("review_publication_operations"."reconciliation_payload" IS NULL OR (jsonb_typeof("review_publication_operations"."reconciliation_payload") = 'object' AND "review_publication_operations"."reconciliation_payload" <> '{}'::jsonb AND pg_column_size("review_publication_operations"."reconciliation_payload") <= 1048576)) AND ("review_publication_operations"."compensation_payload" IS NULL OR (jsonb_typeof("review_publication_operations"."compensation_payload") = 'object' AND "review_publication_operations"."compensation_payload" <> '{}'::jsonb AND pg_column_size("review_publication_operations"."compensation_payload") <= 1048576)) AND ("review_publication_operations"."selected_variant" IS NULL OR length(btrim("review_publication_operations"."selected_variant")) BETWEEN 1 AND 200)),
	CONSTRAINT "review_publication_operations_timestamps_check" CHECK (isfinite("review_publication_operations"."created_at") AND isfinite("review_publication_operations"."updated_at") AND ("review_publication_operations"."retry_after" IS NULL OR isfinite("review_publication_operations"."retry_after")) AND ("review_publication_operations"."deadline_at" IS NULL OR isfinite("review_publication_operations"."deadline_at")) AND ("review_publication_operations"."remote_observed_at" IS NULL OR isfinite("review_publication_operations"."remote_observed_at")) AND ("review_publication_operations"."applied_at" IS NULL OR isfinite("review_publication_operations"."applied_at")) AND ("review_publication_operations"."compensated_at" IS NULL OR isfinite("review_publication_operations"."compensated_at")) AND ("review_publication_operations"."lease_expires_at" IS NULL OR isfinite("review_publication_operations"."lease_expires_at"))),
	CONSTRAINT "review_publication_operations_lease_check" CHECK (("review_publication_operations"."state" IN ('applying', 'compensating') AND "review_publication_operations"."claim_owner" IS NOT NULL AND "review_publication_operations"."lease_id" IS NOT NULL AND "review_publication_operations"."lease_expires_at" IS NOT NULL AND "review_publication_operations"."lease_expires_at" > "review_publication_operations"."updated_at" AND "review_publication_operations"."lease_generation" > 0) OR ("review_publication_operations"."state" NOT IN ('applying', 'compensating') AND "review_publication_operations"."claim_owner" IS NULL AND "review_publication_operations"."lease_id" IS NULL AND "review_publication_operations"."lease_expires_at" IS NULL)),
	CONSTRAINT "review_publication_operations_state_evidence_check" CHECK (("review_publication_operations"."state" NOT IN ('applying', 'compensating') OR ("review_publication_operations"."selected_variant" IS NOT NULL AND "review_publication_operations"."attempt_count" > 0)) AND ("review_publication_operations"."state" <> 'unknown' OR ("review_publication_operations"."selected_variant" IS NOT NULL AND "review_publication_operations"."last_error" IS NOT NULL AND "review_publication_operations"."attempt_count" > 0 AND "review_publication_operations"."lease_generation" > 0)) AND ("review_publication_operations"."state" <> 'applied' OR ("review_publication_operations"."applied_at" IS NOT NULL AND "review_publication_operations"."result_payload" IS NOT NULL AND "review_publication_operations"."selected_variant" IS NOT NULL AND "review_publication_operations"."remote_identity" IS NOT NULL AND "review_publication_operations"."remote_operation_id" IS NOT NULL AND "review_publication_operations"."remote_observed_at" IS NOT NULL AND "review_publication_operations"."last_error" IS NULL)) AND ("review_publication_operations"."applied_at" IS NULL OR ("review_publication_operations"."state" IN ('applied', 'unknown', 'superseded', 'compensating', 'failed') AND "review_publication_operations"."result_payload" IS NOT NULL AND "review_publication_operations"."selected_variant" IS NOT NULL AND "review_publication_operations"."remote_identity" IS NOT NULL AND "review_publication_operations"."remote_operation_id" IS NOT NULL AND "review_publication_operations"."remote_observed_at" IS NOT NULL)) AND ("review_publication_operations"."state" <> 'skipped' OR ("review_publication_operations"."result_payload" IS NOT NULL AND "review_publication_operations"."applied_at" IS NULL AND "review_publication_operations"."compensated_at" IS NULL)) AND ("review_publication_operations"."state" <> 'failed' OR "review_publication_operations"."last_error" IS NOT NULL) AND ("review_publication_operations"."compensated_at" IS NULL OR ("review_publication_operations"."state" = 'superseded' AND "review_publication_operations"."compensation_payload" IS NOT NULL)) AND ("review_publication_operations"."compensation_payload" IS NULL OR "review_publication_operations"."state" = 'superseded') AND ("review_publication_operations"."state" <> 'superseded' OR "review_publication_operations"."applied_at" IS NULL OR ("review_publication_operations"."compensated_at" IS NOT NULL AND "review_publication_operations"."compensation_payload" IS NOT NULL)))
);
--> statement-breakpoint
ALTER TABLE "pull_request_publication_high_waters" ADD CONSTRAINT "pull_request_publication_high_waters_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_publication_generations" ADD CONSTRAINT "review_publication_generations_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_publication_generations" ADD CONSTRAINT "review_publication_generations_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pull_request_publication_high_waters_pr_idx" ON "pull_request_publication_high_waters" USING btree ("repository_id","pr_number");--> statement-breakpoint
CREATE UNIQUE INDEX "review_publication_generations_pr_generation_idx" ON "review_publication_generations" USING btree ("repository_id","pr_number","publication_generation");--> statement-breakpoint
CREATE UNIQUE INDEX "review_publication_generations_operation_identity_idx" ON "review_publication_generations" USING btree ("repository_id","pr_number","publication_generation","review_id");--> statement-breakpoint
CREATE UNIQUE INDEX "review_publication_generations_identity_idx" ON "review_publication_generations" USING btree ("repository_id","pr_number","publication_generation","review_id","accepted_input_digest","head_sha");--> statement-breakpoint
CREATE UNIQUE INDEX "review_publication_operations_identity_idx" ON "review_publication_operations" USING btree ("repository_id","pr_number","publication_generation","operation_key");--> statement-breakpoint
CREATE UNIQUE INDEX "review_publication_operations_ordinal_idx" ON "review_publication_operations" USING btree ("repository_id","pr_number","publication_generation","operation_ordinal");--> statement-breakpoint
CREATE INDEX "review_publication_operations_recovery_idx" ON "review_publication_operations" USING btree ("state","retry_after","deadline_at");--> statement-breakpoint
ALTER TABLE "pull_request_publication_high_waters" ADD CONSTRAINT "pull_request_publication_high_waters_generation_fk" FOREIGN KEY ("repository_id","pr_number","publication_generation","accepted_review_id","accepted_input_digest","accepted_head_sha") REFERENCES "public"."review_publication_generations"("repository_id","pr_number","publication_generation","review_id","accepted_input_digest","head_sha") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_publication_operations" ADD CONSTRAINT "review_publication_operations_generation_fk" FOREIGN KEY ("repository_id","pr_number","publication_generation","review_id") REFERENCES "public"."review_publication_generations"("repository_id","pr_number","publication_generation","review_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_publication_operations" ADD CONSTRAINT "review_publication_operations_dependency_fk" FOREIGN KEY ("repository_id","pr_number","publication_generation","dependency_operation_key") REFERENCES "public"."review_publication_operations"("repository_id","pr_number","publication_generation","operation_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE FUNCTION "postil_guard_review_publication_generation"()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() = 1 THEN
      RAISE EXCEPTION 'review publication generations can only be deleted by parent teardown';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'review publication generation is immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "public"."reviews"
    WHERE "id" = NEW."review_id"
      AND "repository_id" = NEW."repository_id"
      AND "pr_number" = NEW."pr_number"
      AND "head_sha" = NEW."head_sha"
      AND "base_sha" = NEW."base_sha"
  ) THEN
    RAISE EXCEPTION 'review publication generation does not match its review identity'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "review_publication_generations_guard_identity"
BEFORE INSERT OR UPDATE OR DELETE ON "review_publication_generations"
FOR EACH ROW EXECUTE FUNCTION "postil_guard_review_publication_generation"();--> statement-breakpoint
CREATE FUNCTION "postil_guard_pull_request_publication_high_water"()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  retained_generation bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() = 1 THEN
      RAISE EXCEPTION 'pull request publication high-water rows can only be deleted by parent teardown';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."pr_number" <= 0
       OR NEW."publication_generation" <= 0
       OR NEW."accepted_input_digest" !~ '^[0-9a-f]{64}$'
       OR NEW."accepted_head_sha" !~ '^[0-9a-f]{40}([0-9a-f]{24})?$'
       OR NOT isfinite(NEW."created_at") OR NOT isfinite(NEW."updated_at") THEN
      RETURN NEW;
    END IF;
    SELECT max("publication_generation") INTO retained_generation
    FROM "public"."review_publication_generations"
    WHERE "repository_id" = NEW."repository_id" AND "pr_number" = NEW."pr_number";
    IF retained_generation IS NULL OR NEW."publication_generation" <> retained_generation THEN
      RAISE EXCEPTION 'pull request publication high-water must use the latest retained generation';
    END IF;
    RETURN NEW;
  END IF;
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
  IF NEW."publication_generation" > OLD."publication_generation" THEN
    SELECT max("publication_generation") INTO retained_generation
    FROM "public"."review_publication_generations"
    WHERE "repository_id" = NEW."repository_id" AND "pr_number" = NEW."pr_number";
    IF retained_generation IS NULL OR NEW."publication_generation" <> retained_generation THEN
      RAISE EXCEPTION 'pull request publication high-water must use the latest retained generation';
    END IF;
  END IF;
  IF NEW IS DISTINCT FROM OLD AND NEW."updated_at" <= OLD."updated_at" THEN
    RAISE EXCEPTION 'pull request publication high-water updates must advance updated_at';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "pull_request_publication_high_waters_guard_generation"
BEFORE INSERT OR UPDATE OR DELETE ON "pull_request_publication_high_waters"
FOR EACH ROW EXECUTE FUNCTION "postil_guard_pull_request_publication_high_water"();--> statement-breakpoint
CREATE FUNCTION "postil_guard_review_publication_operation"()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() = 1 THEN
      RAISE EXCEPTION 'review publication operations can only be deleted by parent teardown';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."dependency_operation_key" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "public"."review_publication_operations"
      WHERE "repository_id" = NEW."repository_id"
        AND "pr_number" = NEW."pr_number"
        AND "publication_generation" = NEW."publication_generation"
        AND "operation_key" = NEW."dependency_operation_key"
        AND "operation_ordinal" < NEW."operation_ordinal"
    ) THEN
      RAISE EXCEPTION 'review publication operation dependency must be an earlier operation in the same generation'
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."repository_id" IS DISTINCT FROM OLD."repository_id"
    OR NEW."pr_number" IS DISTINCT FROM OLD."pr_number"
    OR NEW."publication_generation" IS DISTINCT FROM OLD."publication_generation"
    OR NEW."review_id" IS DISTINCT FROM OLD."review_id"
    OR NEW."operation_key" IS DISTINCT FROM OLD."operation_key"
    OR NEW."operation_ordinal" IS DISTINCT FROM OLD."operation_ordinal"
    OR NEW."dependency_operation_key" IS DISTINCT FROM OLD."dependency_operation_key"
    OR NEW."activation_condition" IS DISTINCT FROM OLD."activation_condition"
    OR NEW."kind" IS DISTINCT FROM OLD."kind"
    OR NEW."desired_payload" IS DISTINCT FROM OLD."desired_payload"
    OR NEW."desired_payload_bytes" IS DISTINCT FROM OLD."desired_payload_bytes"
    OR NEW."desired_payload_digest" IS DISTINCT FROM OLD."desired_payload_digest"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'review publication operation intent is immutable';
  END IF;
  IF NEW."attempt_count" < OLD."attempt_count" THEN
    RAISE EXCEPTION 'review publication operation attempts cannot decrease';
  END IF;
  IF NEW."lease_generation" < OLD."lease_generation" THEN
    RAISE EXCEPTION 'review publication operation lease generation cannot decrease';
  END IF;
  IF NEW."state" IN ('applying', 'compensating')
     AND OLD."state" NOT IN ('applying', 'compensating')
     AND NEW."lease_generation" <= OLD."lease_generation" THEN
    RAISE EXCEPTION 'review publication operation claims must advance lease generation';
  END IF;
  IF NEW."state" IN ('applying', 'compensating')
     AND OLD."state" NOT IN ('applying', 'compensating')
     AND NEW."attempt_count" <= OLD."attempt_count" THEN
    RAISE EXCEPTION 'review publication operation claims must advance attempt count';
  END IF;
  IF NEW."lease_generation" = OLD."lease_generation"
     AND NEW."lease_id" IS NOT NULL
     AND (NEW."lease_id" IS DISTINCT FROM OLD."lease_id"
          OR NEW."claim_owner" IS DISTINCT FROM OLD."claim_owner") THEN
    RAISE EXCEPTION 'review publication operation lease identity requires a higher generation';
  END IF;
  IF NEW."state" IS DISTINCT FROM OLD."state" AND NOT (
    (OLD."state" = 'pending' AND NEW."state" IN ('applying', 'skipped', 'superseded', 'failed'))
    OR (OLD."state" = 'applying' AND NEW."state" IN ('unknown', 'applied', 'superseded', 'failed'))
    OR (OLD."state" = 'unknown' AND NEW."state" IN ('applying', 'applied', 'superseded', 'compensating', 'failed'))
    OR (OLD."state" = 'applied' AND NEW."state" = 'compensating')
    OR (OLD."state" = 'compensating' AND NEW."state" IN ('applied', 'unknown', 'superseded', 'failed'))
  ) THEN
    RAISE EXCEPTION 'invalid review publication operation state transition';
  END IF;
  IF OLD."state" = 'unknown'
     AND NEW."state" IN ('applied', 'superseded', 'compensating', 'failed')
     AND NEW."reconciliation_payload" IS NULL THEN
    RAISE EXCEPTION 'review publication reconciliation requires an observation payload';
  END IF;
  IF OLD."result_payload" IS NOT NULL AND (
    NEW."result_payload" IS DISTINCT FROM OLD."result_payload"
    OR NEW."selected_variant" IS DISTINCT FROM OLD."selected_variant"
    OR NEW."remote_identity" IS DISTINCT FROM OLD."remote_identity"
    OR NEW."remote_operation_id" IS DISTINCT FROM OLD."remote_operation_id"
    OR NEW."remote_observed_at" IS DISTINCT FROM OLD."remote_observed_at"
  ) THEN
    RAISE EXCEPTION 'review publication operation result evidence is immutable';
  END IF;
  IF OLD."selected_variant" IS NOT NULL
     AND NEW."selected_variant" IS DISTINCT FROM OLD."selected_variant" THEN
    RAISE EXCEPTION 'review publication operation result evidence is immutable';
  END IF;
  IF OLD."reconciliation_payload" IS NOT NULL
     AND NEW."reconciliation_payload" IS DISTINCT FROM OLD."reconciliation_payload" THEN
    RAISE EXCEPTION 'review publication operation reconciliation evidence is immutable';
  END IF;
  IF OLD."applied_at" IS NOT NULL AND NEW."applied_at" IS DISTINCT FROM OLD."applied_at" THEN
    RAISE EXCEPTION 'review publication operation completion evidence is immutable';
  END IF;
  IF (OLD."compensated_at" IS NOT NULL OR OLD."compensation_payload" IS NOT NULL) AND (
    NEW."compensated_at" IS DISTINCT FROM OLD."compensated_at"
    OR NEW."compensation_payload" IS DISTINCT FROM OLD."compensation_payload"
  ) THEN
    RAISE EXCEPTION 'review publication operation compensation evidence is immutable';
  END IF;
  IF OLD."state" = 'compensating' AND NEW."state" = 'superseded'
     AND (NEW."compensated_at" IS NULL OR NEW."compensation_payload" IS NULL) THEN
    RAISE EXCEPTION 'successful review publication compensation requires observation evidence';
  END IF;
  IF NEW IS DISTINCT FROM OLD AND NEW."updated_at" <= OLD."updated_at" THEN
    RAISE EXCEPTION 'review publication operation updates must advance updated_at';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "review_publication_operations_guard_state"
BEFORE INSERT OR UPDATE OR DELETE ON "review_publication_operations"
FOR EACH ROW EXECUTE FUNCTION "postil_guard_review_publication_operation"();
