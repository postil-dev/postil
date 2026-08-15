SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE FUNCTION "postil_canonical_json"(value jsonb)
RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = pg_catalog, public AS $$
DECLARE
  rendered text;
BEGIN
  CASE pg_catalog.jsonb_typeof(value)
    WHEN 'object' THEN
      SELECT '{' || COALESCE(
        pg_catalog.string_agg(
          pg_catalog.to_jsonb(key)::text || ':' || public.postil_canonical_json(entry),
          ',' ORDER BY key
        ),
        ''
      ) || '}'
      INTO rendered
      FROM pg_catalog.jsonb_each(value) AS object_entry(key, entry);
    WHEN 'array' THEN
      SELECT '[' || COALESCE(
        pg_catalog.string_agg(
          public.postil_canonical_json(entry),
          ',' ORDER BY ordinal
        ),
        ''
      ) || ']'
      INTO rendered
      FROM pg_catalog.jsonb_array_elements(value) WITH ORDINALITY
        AS array_entry(entry, ordinal);
    ELSE
      rendered := value::text;
  END CASE;
  RETURN rendered;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "postil_has_exact_json_keys"(value jsonb, expected text[])
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog, public AS $$
  SELECT pg_catalog.jsonb_typeof(value) = 'object'
    AND value ?& expected
    AND value - expected = '{}'::jsonb;
$$;
--> statement-breakpoint
CREATE FUNCTION "postil_nul_join_sha256"(prefix text, VARIADIC segments text[])
RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = pg_catalog, public AS $$
DECLARE
  rendered bytea := pg_catalog.convert_to(prefix, 'UTF8') || pg_catalog.decode('00', 'hex');
  value text;
BEGIN
  FOREACH value IN ARRAY segments LOOP
    rendered := rendered
      || pg_catalog.convert_to(value, 'UTF8')
      || pg_catalog.decode('00', 'hex');
  END LOOP;
  RETURN pg_catalog.encode(sha256(rendered), 'hex');
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "postil_activation_references_are_declared"(activation jsonb, dependencies jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = pg_catalog, public AS $$
DECLARE
  condition jsonb;
  referenced_key text;
BEGIN
  IF pg_catalog.jsonb_typeof(activation) <> 'object'
     OR NOT public.postil_has_exact_json_keys(activation, ARRAY['anyOf'])
     OR pg_catalog.jsonb_typeof(activation->'anyOf') <> 'array'
     OR pg_catalog.jsonb_array_length(activation->'anyOf') NOT BETWEEN 1 AND 8
     OR pg_catalog.jsonb_typeof(dependencies) <> 'array' THEN
    RETURN false;
  END IF;
  FOR condition IN SELECT value FROM pg_catalog.jsonb_array_elements(activation->'anyOf') LOOP
    CASE condition->>'condition'
      WHEN 'always', 'allDependenciesTerminal' THEN
        IF NOT public.postil_has_exact_json_keys(condition, ARRAY['condition']) THEN RETURN false; END IF;
      WHEN 'markerAbsent' THEN
        IF NOT public.postil_has_exact_json_keys(condition, ARRAY['condition', 'guard'])
           OR pg_catalog.jsonb_typeof(condition->'guard') <> 'object' THEN RETURN false; END IF;
      WHEN 'semanticPlacementRejected', 'partialReviewObserved' THEN
        referenced_key := condition->>'dependencyOperationKey';
        IF referenced_key IS NULL
           OR NOT (dependencies @> pg_catalog.jsonb_build_array(pg_catalog.to_jsonb(referenced_key))) THEN
          RETURN false;
        END IF;
      WHEN 'findingContentDiffers' THEN
        IF NOT public.postil_has_exact_json_keys(
          condition, ARRAY['condition', 'observedCommentId', 'expectedMarkers']
        ) THEN RETURN false; END IF;
      WHEN 'reviewSelectionTerminal' THEN
        IF pg_catalog.jsonb_typeof(condition->'selectedReviewOperationKeys') <> 'array'
           OR EXISTS (
             SELECT 1
             FROM pg_catalog.jsonb_array_elements_text(condition->'selectedReviewOperationKeys')
               AS selected_key(operation_key)
             WHERE NOT (dependencies @> pg_catalog.jsonb_build_array(pg_catalog.to_jsonb(selected_key.operation_key)))
           ) THEN RETURN false; END IF;
      ELSE RETURN false;
    END CASE;
  END LOOP;
  RETURN true;
END;
$$;
--> statement-breakpoint
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
	"operation_count" integer NOT NULL,
	"operation_manifest_digest" text NOT NULL,
	"controller_operation_count" integer NOT NULL,
	"controller_operation_manifest_digest" text NOT NULL,
	"controller_manifest" jsonb NOT NULL,
	"controller_manifest_bytes" "bytea" NOT NULL,
	"controller_manifest_digest" text NOT NULL,
	"sealed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_publication_generations_pr_number_check" CHECK ("review_publication_generations"."pr_number" > 0),
	CONSTRAINT "review_publication_generations_generation_check" CHECK ("review_publication_generations"."publication_generation" > 0),
	CONSTRAINT "review_publication_generations_input_digest_check" CHECK ("review_publication_generations"."accepted_input_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "review_publication_generations_plan_check" CHECK ("review_publication_generations"."plan_version" ~ '^github-publication-v[1-9][0-9]{0,8}$' AND jsonb_typeof("review_publication_generations"."accepted_plan") = 'object' AND octet_length("review_publication_generations"."accepted_plan_bytes") BETWEEN 3 AND 8388608 AND right(convert_from("review_publication_generations"."accepted_plan_bytes", 'UTF8'), 1) = E'\n' AND right(convert_from("review_publication_generations"."accepted_plan_bytes", 'UTF8'), 2) <> E'\n\n' AND convert_from("review_publication_generations"."accepted_plan_bytes", 'UTF8')::jsonb = "review_publication_generations"."accepted_plan" AND "review_publication_generations"."accepted_plan_digest" ~ '^[0-9a-f]{64}$' AND "review_publication_generations"."accepted_plan_digest" = encode(sha256("review_publication_generations"."accepted_plan_bytes"), 'hex')),
	CONSTRAINT "review_publication_generations_plan_semantic_digest_check" CHECK ("review_publication_generations"."plan_semantic_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "review_publication_generations_review_input_sequence_check" CHECK ("review_publication_generations"."review_input_sequence" > 0),
	CONSTRAINT "review_publication_generations_envelope_digest_check" CHECK ("review_publication_generations"."envelope_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "review_publication_generations_repository_snapshot_check" CHECK (length("review_publication_generations"."repository_full_name") BETWEEN 3 AND 200 AND "review_publication_generations"."repository_full_name" ~ '^[^/[:space:]]+/[^/[:space:]]+$'),
	CONSTRAINT "review_publication_generations_head_sha_check" CHECK ("review_publication_generations"."head_sha" ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
	CONSTRAINT "review_publication_generations_base_sha_check" CHECK ("review_publication_generations"."base_sha" ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
	CONSTRAINT "review_publication_generations_target_sha_check" CHECK ("review_publication_generations"."target_sha" ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
	CONSTRAINT "review_publication_generations_pull_request_snapshot_check" CHECK (length(btrim("review_publication_generations"."target_branch")) BETWEEN 1 AND 255 AND length(btrim("review_publication_generations"."pull_request_title")) BETWEEN 1 AND 512 AND length("review_publication_generations"."pull_request_body") <= 65536),
	CONSTRAINT "review_publication_generations_cli_operation_manifest_check" CHECK ("review_publication_generations"."operation_count" BETWEEN 0 AND 126 AND "review_publication_generations"."operation_manifest_digest" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "review_publication_generations_controller_manifest_check" CHECK ("review_publication_generations"."controller_operation_count" BETWEEN 2 AND 128 AND "review_publication_generations"."controller_operation_manifest_digest" ~ '^sha256:[0-9a-f]{64}$' AND jsonb_typeof("review_publication_generations"."controller_manifest") = 'object' AND octet_length("review_publication_generations"."controller_manifest_bytes") BETWEEN 2 AND 8388608 AND convert_from("review_publication_generations"."controller_manifest_bytes", 'UTF8') = postil_canonical_json("review_publication_generations"."controller_manifest") AND "review_publication_generations"."controller_manifest_digest" ~ '^sha256:[0-9a-f]{64}$' AND "review_publication_generations"."controller_manifest_digest" = 'sha256:' || encode(sha256("review_publication_generations"."controller_manifest_bytes"), 'hex') AND "review_publication_generations"."controller_manifest"->>'version' = 'github-publication-controller-v1' AND jsonb_typeof("review_publication_generations"."controller_manifest"->'operationCount') = 'number' AND "review_publication_generations"."controller_manifest"->>'operationCount' = "review_publication_generations"."controller_operation_count"::text AND "review_publication_generations"."controller_manifest"->>'operationManifestDigest' = "review_publication_generations"."controller_operation_manifest_digest" AND jsonb_typeof("review_publication_generations"."controller_manifest"->'operations') = 'array'),
	CONSTRAINT "review_publication_generations_created_at_check" CHECK (isfinite("review_publication_generations"."expected_pull_request_updated_at") AND isfinite("review_publication_generations"."created_at") AND ("review_publication_generations"."sealed_at" IS NULL OR isfinite("review_publication_generations"."sealed_at")))
);
--> statement-breakpoint
CREATE TABLE "review_publication_operation_attempts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "review_publication_operation_attempts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"repository_id" bigint NOT NULL,
	"pr_number" integer NOT NULL,
	"publication_generation" bigint NOT NULL,
	"operation_key" text NOT NULL,
	"attempt_number" integer NOT NULL,
	"lease_generation" bigint NOT NULL,
	"phase" text NOT NULL,
	"selected_variant" text NOT NULL,
	"evidence_payload" jsonb,
	"error_reason" text,
	"remote_identity" text,
	"remote_operation_id" text,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_publication_operation_attempts_pr_number_check" CHECK ("review_publication_operation_attempts"."pr_number" > 0),
	CONSTRAINT "review_publication_operation_attempts_generation_check" CHECK ("review_publication_operation_attempts"."publication_generation" > 0),
	CONSTRAINT "review_publication_operation_attempts_sequence_check" CHECK ("review_publication_operation_attempts"."attempt_number" BETWEEN 1 AND 1000000 AND "review_publication_operation_attempts"."lease_generation" > 0),
	CONSTRAINT "review_publication_operation_attempts_phase_check" CHECK ("review_publication_operation_attempts"."phase" IN ('claimed', 'dispatched', 'not_dispatched', 'ambiguous', 'applied', 'rejected')),
	CONSTRAINT "review_publication_operation_attempts_variant_check" CHECK (length(btrim("review_publication_operation_attempts"."selected_variant")) BETWEEN 1 AND 200),
	CONSTRAINT "review_publication_operation_attempts_payload_check" CHECK ("review_publication_operation_attempts"."evidence_payload" IS NULL OR (jsonb_typeof("review_publication_operation_attempts"."evidence_payload") = 'object' AND "review_publication_operation_attempts"."evidence_payload" <> '{}'::jsonb AND pg_column_size("review_publication_operation_attempts"."evidence_payload") <= 1048576)),
	CONSTRAINT "review_publication_operation_attempts_error_check" CHECK ("review_publication_operation_attempts"."error_reason" IS NULL OR length(btrim("review_publication_operation_attempts"."error_reason")) BETWEEN 1 AND 4000),
	CONSTRAINT "review_publication_operation_attempts_remote_identity_check" CHECK ("review_publication_operation_attempts"."remote_identity" IS NULL OR length(btrim("review_publication_operation_attempts"."remote_identity")) BETWEEN 1 AND 500),
	CONSTRAINT "review_publication_operation_attempts_remote_operation_id_check" CHECK ("review_publication_operation_attempts"."remote_operation_id" IS NULL OR length(btrim("review_publication_operation_attempts"."remote_operation_id")) BETWEEN 1 AND 500),
	CONSTRAINT "review_publication_operation_attempts_phase_evidence_check" CHECK (("review_publication_operation_attempts"."phase" = 'claimed' AND "review_publication_operation_attempts"."evidence_payload" IS NULL AND "review_publication_operation_attempts"."error_reason" IS NULL AND "review_publication_operation_attempts"."remote_identity" IS NULL AND "review_publication_operation_attempts"."remote_operation_id" IS NULL) OR ("review_publication_operation_attempts"."phase" IN ('dispatched', 'not_dispatched') AND "review_publication_operation_attempts"."evidence_payload" IS NOT NULL AND "review_publication_operation_attempts"."error_reason" IS NULL AND "review_publication_operation_attempts"."remote_identity" IS NULL AND "review_publication_operation_attempts"."remote_operation_id" IS NULL) OR ("review_publication_operation_attempts"."phase" IN ('ambiguous', 'rejected') AND "review_publication_operation_attempts"."evidence_payload" IS NOT NULL AND "review_publication_operation_attempts"."error_reason" IS NOT NULL AND "review_publication_operation_attempts"."remote_identity" IS NULL AND "review_publication_operation_attempts"."remote_operation_id" IS NULL) OR ("review_publication_operation_attempts"."phase" = 'applied' AND "review_publication_operation_attempts"."evidence_payload" IS NOT NULL AND "review_publication_operation_attempts"."error_reason" IS NULL AND "review_publication_operation_attempts"."remote_identity" IS NOT NULL AND "review_publication_operation_attempts"."remote_operation_id" IS NOT NULL)),
	CONSTRAINT "review_publication_operation_attempts_timestamps_check" CHECK (isfinite("review_publication_operation_attempts"."observed_at") AND isfinite("review_publication_operation_attempts"."created_at"))
);
--> statement-breakpoint
CREATE TABLE "review_publication_operation_dependencies" (
	"repository_id" bigint NOT NULL,
	"pr_number" integer NOT NULL,
	"publication_generation" bigint NOT NULL,
	"operation_key" text NOT NULL,
	"dependency_position" integer NOT NULL,
	"dependency_operation_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_publication_operation_dependencies_pr_number_check" CHECK ("review_publication_operation_dependencies"."pr_number" > 0),
	CONSTRAINT "review_publication_operation_dependencies_generation_check" CHECK ("review_publication_operation_dependencies"."publication_generation" > 0),
	CONSTRAINT "review_publication_operation_dependencies_position_check" CHECK ("review_publication_operation_dependencies"."dependency_position" BETWEEN 0 AND 127 AND "review_publication_operation_dependencies"."dependency_operation_key" <> "review_publication_operation_dependencies"."operation_key"),
	CONSTRAINT "review_publication_operation_dependencies_created_at_check" CHECK (isfinite("review_publication_operation_dependencies"."created_at"))
);
--> statement-breakpoint
CREATE TABLE "review_publication_operation_reconciliations" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "review_publication_operation_reconciliations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"repository_id" bigint NOT NULL,
	"pr_number" integer NOT NULL,
	"publication_generation" bigint NOT NULL,
	"operation_key" text NOT NULL,
	"attempt_number" integer NOT NULL,
	"lease_generation" bigint NOT NULL,
	"phase" text NOT NULL,
	"selected_variant" text NOT NULL,
	"outcome" text NOT NULL,
	"evidence_payload" jsonb NOT NULL,
	"remote_identity" text,
	"remote_operation_id" text,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_publication_operation_reconciliations_pr_number_check" CHECK ("review_publication_operation_reconciliations"."pr_number" > 0),
	CONSTRAINT "review_publication_operation_reconciliations_generation_check" CHECK ("review_publication_operation_reconciliations"."publication_generation" > 0),
	CONSTRAINT "review_publication_operation_reconciliations_sequence_check" CHECK ("review_publication_operation_reconciliations"."attempt_number" BETWEEN 1 AND 1000000 AND "review_publication_operation_reconciliations"."lease_generation" > 0),
	CONSTRAINT "review_publication_operation_reconciliations_phase_check" CHECK ("review_publication_operation_reconciliations"."phase" IN ('retry', 'terminal')),
	CONSTRAINT "review_publication_operation_reconciliations_variant_check" CHECK (length(btrim("review_publication_operation_reconciliations"."selected_variant")) BETWEEN 1 AND 200),
	CONSTRAINT "review_publication_operation_reconciliations_outcome_check" CHECK ("review_publication_operation_reconciliations"."outcome" IN ('exact_absence', 'applied') AND ("review_publication_operation_reconciliations"."phase" <> 'retry' OR "review_publication_operation_reconciliations"."outcome" = 'exact_absence')),
	CONSTRAINT "review_publication_operation_reconciliations_payload_check" CHECK (jsonb_typeof("review_publication_operation_reconciliations"."evidence_payload") = 'object' AND "review_publication_operation_reconciliations"."evidence_payload" <> '{}'::jsonb AND pg_column_size("review_publication_operation_reconciliations"."evidence_payload") <= 1048576),
	CONSTRAINT "review_publication_operation_reconciliations_remote_identity_check" CHECK ("review_publication_operation_reconciliations"."remote_identity" IS NULL OR length(btrim("review_publication_operation_reconciliations"."remote_identity")) BETWEEN 1 AND 500),
	CONSTRAINT "review_publication_operation_reconciliations_remote_operation_id_check" CHECK ("review_publication_operation_reconciliations"."remote_operation_id" IS NULL OR length(btrim("review_publication_operation_reconciliations"."remote_operation_id")) BETWEEN 1 AND 500),
	CONSTRAINT "review_publication_operation_reconciliations_evidence_check" CHECK (("review_publication_operation_reconciliations"."outcome" = 'exact_absence' AND "review_publication_operation_reconciliations"."remote_identity" IS NULL AND "review_publication_operation_reconciliations"."remote_operation_id" IS NULL) OR ("review_publication_operation_reconciliations"."outcome" = 'applied' AND "review_publication_operation_reconciliations"."remote_identity" IS NOT NULL AND "review_publication_operation_reconciliations"."remote_operation_id" IS NOT NULL)),
	CONSTRAINT "review_publication_operation_reconciliations_timestamps_check" CHECK (isfinite("review_publication_operation_reconciliations"."observed_at") AND isfinite("review_publication_operation_reconciliations"."created_at"))
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
	"operation_source" text NOT NULL,
	"controller_record" jsonb NOT NULL,
	"controller_record_bytes" "bytea" NOT NULL,
	"operation_record" jsonb NOT NULL,
	"operation_record_bytes" "bytea" NOT NULL,
	"activation" jsonb NOT NULL,
	"activation_bytes" "bytea" NOT NULL,
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
	"selected_variant" text,
	"retry_after" timestamp with time zone,
	"deadline_at" timestamp with time zone,
	"last_error" text,
	"terminal_evidence" jsonb,
	"evidence_generation" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_publication_operations_pr_number_check" CHECK ("review_publication_operations"."pr_number" > 0),
	CONSTRAINT "review_publication_operations_generation_check" CHECK ("review_publication_operations"."publication_generation" > 0),
	CONSTRAINT "review_publication_operations_source_key_check" CHECK (("review_publication_operations"."operation_source" = 'cli' AND "review_publication_operations"."operation_key" ~ '^github-publication-v1:[a-z][a-z0-9-]{0,99}:sha256:[0-9a-f]{64}$') OR ("review_publication_operations"."operation_source" = 'service' AND (("review_publication_operations"."kind" = 'gateCheckCreate' AND "review_publication_operations"."operation_key" ~ '^github-publication-controller-v1:gate-create:sha256:[0-9a-f]{64}$') OR ("review_publication_operations"."kind" = 'gateCheckComplete' AND "review_publication_operations"."operation_key" ~ '^github-publication-controller-v1:gate-complete:sha256:[0-9a-f]{64}$')))),
	CONSTRAINT "review_publication_operations_ordinal_check" CHECK ("review_publication_operations"."operation_ordinal" BETWEEN 1 AND 128),
	CONSTRAINT "review_publication_operations_controller_record_check" CHECK (jsonb_typeof("review_publication_operations"."controller_record") = 'object' AND octet_length("review_publication_operations"."controller_record_bytes") BETWEEN 2 AND 4194304 AND convert_from("review_publication_operations"."controller_record_bytes", 'UTF8') = postil_canonical_json("review_publication_operations"."controller_record") AND "review_publication_operations"."controller_record"->>'source' = "review_publication_operations"."operation_source" AND "review_publication_operations"."controller_record"->'operation' = "review_publication_operations"."operation_record" AND "review_publication_operations"."controller_record" - ARRAY['source', 'operation']::text[] = '{}'::jsonb),
	CONSTRAINT "review_publication_operations_record_check" CHECK (jsonb_typeof("review_publication_operations"."operation_record") = 'object' AND octet_length("review_publication_operations"."operation_record_bytes") BETWEEN 2 AND 2097152 AND convert_from("review_publication_operations"."operation_record_bytes", 'UTF8')::jsonb = "review_publication_operations"."operation_record" AND jsonb_typeof("review_publication_operations"."operation_record"->'ordinal') = 'number' AND "review_publication_operations"."operation_record"->>'ordinal' = "review_publication_operations"."operation_ordinal"::text AND "review_publication_operations"."operation_record"->>'operationKey' = "review_publication_operations"."operation_key" AND jsonb_typeof("review_publication_operations"."operation_record"->'dependencies') = 'array' AND jsonb_array_length("review_publication_operations"."operation_record"->'dependencies') <= 127 AND "review_publication_operations"."operation_record"->'activation' = "review_publication_operations"."activation" AND jsonb_typeof("review_publication_operations"."operation_record"->'reconciliation') = 'object' AND "review_publication_operations"."operation_record"->>'desiredDigest' = "review_publication_operations"."desired_payload_digest" AND "review_publication_operations"."operation_record"->>'kind' = "review_publication_operations"."kind" AND "review_publication_operations"."operation_record" - ARRAY['ordinal', 'operationKey', 'dependencies', 'activation', 'reconciliation', 'desiredDigest']::text[] = "review_publication_operations"."desired_payload"),
	CONSTRAINT "review_publication_operations_activation_check" CHECK (jsonb_typeof("review_publication_operations"."activation") = 'object' AND octet_length("review_publication_operations"."activation_bytes") BETWEEN 2 AND 1048576 AND convert_from("review_publication_operations"."activation_bytes", 'UTF8')::jsonb = "review_publication_operations"."activation" AND jsonb_typeof("review_publication_operations"."activation"->'anyOf') = 'array' AND jsonb_array_length("review_publication_operations"."activation"->'anyOf') BETWEEN 1 AND 128),
	CONSTRAINT "review_publication_operations_kind_check" CHECK ("review_publication_operations"."kind" ~ '^[a-z][A-Za-z0-9]{0,99}$'),
	CONSTRAINT "review_publication_operations_payload_check" CHECK (jsonb_typeof("review_publication_operations"."desired_payload") = 'object' AND octet_length("review_publication_operations"."desired_payload_bytes") BETWEEN 2 AND 1048576 AND convert_from("review_publication_operations"."desired_payload_bytes", 'UTF8')::jsonb = "review_publication_operations"."desired_payload"),
	CONSTRAINT "review_publication_operations_payload_digest_check" CHECK ("review_publication_operations"."desired_payload_digest" ~ '^sha256:[0-9a-f]{64}$' AND "review_publication_operations"."desired_payload_digest" = 'sha256:' || encode(sha256("review_publication_operations"."desired_payload_bytes"), 'hex')),
	CONSTRAINT "review_publication_operations_state_check" CHECK ("review_publication_operations"."state" IN ('pending', 'applying', 'unknown', 'applied', 'skipped', 'superseded', 'failed')),
	CONSTRAINT "review_publication_operations_attempt_count_check" CHECK ("review_publication_operations"."attempt_count" BETWEEN 0 AND 1000000),
	CONSTRAINT "review_publication_operations_lease_generation_check" CHECK ("review_publication_operations"."lease_generation" >= 0),
	CONSTRAINT "review_publication_operations_evidence_generation_check" CHECK ("review_publication_operations"."evidence_generation" >= 0),
	CONSTRAINT "review_publication_operations_deadline_check" CHECK ("review_publication_operations"."deadline_at" IS NULL OR "review_publication_operations"."deadline_at" >= "review_publication_operations"."created_at"),
	CONSTRAINT "review_publication_operations_error_check" CHECK ("review_publication_operations"."last_error" IS NULL OR length(btrim("review_publication_operations"."last_error")) BETWEEN 1 AND 4000),
	CONSTRAINT "review_publication_operations_claim_owner_check" CHECK ("review_publication_operations"."claim_owner" IS NULL OR length(btrim("review_publication_operations"."claim_owner")) BETWEEN 1 AND 200),
	CONSTRAINT "review_publication_operations_selected_variant_check" CHECK ("review_publication_operations"."selected_variant" IS NULL OR length(btrim("review_publication_operations"."selected_variant")) BETWEEN 1 AND 200),
	CONSTRAINT "review_publication_operations_terminal_evidence_check" CHECK ("review_publication_operations"."terminal_evidence" IS NULL OR (jsonb_typeof("review_publication_operations"."terminal_evidence") = 'object' AND "review_publication_operations"."terminal_evidence" <> '{}'::jsonb AND pg_column_size("review_publication_operations"."terminal_evidence") <= 1048576)),
	CONSTRAINT "review_publication_operations_timestamps_check" CHECK (isfinite("review_publication_operations"."created_at") AND isfinite("review_publication_operations"."updated_at") AND ("review_publication_operations"."retry_after" IS NULL OR isfinite("review_publication_operations"."retry_after")) AND ("review_publication_operations"."deadline_at" IS NULL OR isfinite("review_publication_operations"."deadline_at")) AND ("review_publication_operations"."lease_expires_at" IS NULL OR isfinite("review_publication_operations"."lease_expires_at"))),
	CONSTRAINT "review_publication_operations_lease_check" CHECK (("review_publication_operations"."state" = 'applying' AND "review_publication_operations"."claim_owner" IS NOT NULL AND "review_publication_operations"."lease_id" IS NOT NULL AND "review_publication_operations"."lease_expires_at" IS NOT NULL AND "review_publication_operations"."lease_expires_at" > "review_publication_operations"."updated_at" AND "review_publication_operations"."lease_generation" > 0 AND "review_publication_operations"."attempt_count" > 0 AND "review_publication_operations"."selected_variant" IS NOT NULL) OR ("review_publication_operations"."state" <> 'applying' AND "review_publication_operations"."claim_owner" IS NULL AND "review_publication_operations"."lease_id" IS NULL AND "review_publication_operations"."lease_expires_at" IS NULL)),
	CONSTRAINT "review_publication_operations_state_evidence_check" CHECK (("review_publication_operations"."state" <> 'pending' OR "review_publication_operations"."selected_variant" IS NULL) AND ("review_publication_operations"."state" <> 'unknown' OR ("review_publication_operations"."last_error" IS NOT NULL AND "review_publication_operations"."attempt_count" > 0 AND "review_publication_operations"."lease_generation" > 0 AND "review_publication_operations"."selected_variant" IS NOT NULL)) AND ("review_publication_operations"."state" <> 'applied' OR ("review_publication_operations"."last_error" IS NULL AND "review_publication_operations"."attempt_count" > 0 AND "review_publication_operations"."lease_generation" > 0 AND "review_publication_operations"."selected_variant" IS NOT NULL)) AND ("review_publication_operations"."state" NOT IN ('skipped', 'superseded', 'failed') OR "review_publication_operations"."terminal_evidence" IS NOT NULL) AND ("review_publication_operations"."state" <> 'failed' OR "review_publication_operations"."last_error" IS NOT NULL) AND ("review_publication_operations"."terminal_evidence" IS NULL OR "review_publication_operations"."state" IN ('skipped', 'superseded', 'failed')))
);
--> statement-breakpoint
ALTER TABLE "pull_request_publication_high_waters" ADD CONSTRAINT "pull_request_publication_high_waters_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_publication_generations" ADD CONSTRAINT "review_publication_generations_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pull_request_publication_high_waters_pr_idx" ON "pull_request_publication_high_waters" USING btree ("repository_id","pr_number");--> statement-breakpoint
CREATE UNIQUE INDEX "review_publication_generations_pr_generation_idx" ON "review_publication_generations" USING btree ("repository_id","pr_number","publication_generation");--> statement-breakpoint
CREATE UNIQUE INDEX "review_publication_generations_operation_identity_idx" ON "review_publication_generations" USING btree ("repository_id","pr_number","publication_generation","review_id");--> statement-breakpoint
CREATE UNIQUE INDEX "review_publication_generations_identity_idx" ON "review_publication_generations" USING btree ("repository_id","pr_number","publication_generation","review_id","accepted_input_digest","head_sha");--> statement-breakpoint
CREATE UNIQUE INDEX "review_publication_operation_attempts_identity_idx" ON "review_publication_operation_attempts" USING btree ("repository_id","pr_number","publication_generation","operation_key","attempt_number","lease_generation","phase");--> statement-breakpoint
CREATE INDEX "review_publication_operation_attempts_operation_idx" ON "review_publication_operation_attempts" USING btree ("repository_id","pr_number","publication_generation","operation_key","attempt_number");--> statement-breakpoint
CREATE UNIQUE INDEX "review_publication_operation_dependencies_position_idx" ON "review_publication_operation_dependencies" USING btree ("repository_id","pr_number","publication_generation","operation_key","dependency_position");--> statement-breakpoint
CREATE UNIQUE INDEX "review_publication_operation_dependencies_edge_idx" ON "review_publication_operation_dependencies" USING btree ("repository_id","pr_number","publication_generation","operation_key","dependency_operation_key");--> statement-breakpoint
CREATE UNIQUE INDEX "review_publication_operation_reconciliations_identity_idx" ON "review_publication_operation_reconciliations" USING btree ("repository_id","pr_number","publication_generation","operation_key","attempt_number","lease_generation");--> statement-breakpoint
CREATE UNIQUE INDEX "review_publication_operations_identity_idx" ON "review_publication_operations" USING btree ("repository_id","pr_number","publication_generation","operation_key");--> statement-breakpoint
CREATE UNIQUE INDEX "review_publication_operations_ordinal_idx" ON "review_publication_operations" USING btree ("repository_id","pr_number","publication_generation","operation_ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "review_publication_operations_single_active_idx" ON "review_publication_operations" USING btree ("repository_id","pr_number","publication_generation") WHERE "review_publication_operations"."state" IN ('applying', 'unknown');--> statement-breakpoint
CREATE INDEX "review_publication_operations_recovery_idx" ON "review_publication_operations" USING btree ("state","retry_after","deadline_at");--> statement-breakpoint
ALTER TABLE "pull_request_publication_high_waters" ADD CONSTRAINT "pull_request_publication_high_waters_generation_fk" FOREIGN KEY ("repository_id","pr_number","publication_generation","accepted_review_id","accepted_input_digest","accepted_head_sha") REFERENCES "public"."review_publication_generations"("repository_id","pr_number","publication_generation","review_id","accepted_input_digest","head_sha") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_publication_operations" ADD CONSTRAINT "review_publication_operations_generation_fk" FOREIGN KEY ("repository_id","pr_number","publication_generation","review_id") REFERENCES "public"."review_publication_generations"("repository_id","pr_number","publication_generation","review_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_publication_operation_dependencies" ADD CONSTRAINT "review_publication_operation_dependencies_operation_fk" FOREIGN KEY ("repository_id","pr_number","publication_generation","operation_key") REFERENCES "public"."review_publication_operations"("repository_id","pr_number","publication_generation","operation_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_publication_operation_dependencies" ADD CONSTRAINT "review_publication_operation_dependencies_dependency_fk" FOREIGN KEY ("repository_id","pr_number","publication_generation","dependency_operation_key") REFERENCES "public"."review_publication_operations"("repository_id","pr_number","publication_generation","operation_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_publication_operation_attempts" ADD CONSTRAINT "review_publication_operation_attempts_operation_fk" FOREIGN KEY ("repository_id","pr_number","publication_generation","operation_key") REFERENCES "public"."review_publication_operations"("repository_id","pr_number","publication_generation","operation_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_publication_operation_reconciliations" ADD CONSTRAINT "review_publication_operation_reconciliations_operation_fk" FOREIGN KEY ("repository_id","pr_number","publication_generation","operation_key") REFERENCES "public"."review_publication_operations"("repository_id","pr_number","publication_generation","operation_key") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION "postil_review_publication_operation_manifest_digest"(
  repository_identity bigint,
  pull_request_number integer,
  generation_number bigint
)
RETURNS text LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT 'sha256:' || encode(
    sha256(
      decode(
        '5b' || COALESCE(
          string_agg(encode(controller_record_bytes, 'hex'), '2c' ORDER BY operation_ordinal),
          ''
        ) || '5d',
        'hex'
      )
    ),
    'hex'
  )
  FROM public.review_publication_operations
  WHERE repository_id = repository_identity
    AND pr_number = pull_request_number
    AND publication_generation = generation_number;
$$;
--> statement-breakpoint
CREATE FUNCTION "postil_review_publication_cli_manifest_digest"(
  repository_identity bigint,
  pull_request_number integer,
  generation_number bigint
)
RETURNS text LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT 'sha256:' || encode(
    sha256(
      decode(
        '5b' || COALESCE(
          string_agg(encode(operation_record_bytes, 'hex'), '2c' ORDER BY operation_ordinal),
          ''
        ) || '5d',
        'hex'
      )
    ),
    'hex'
  )
  FROM public.review_publication_operations
  WHERE repository_id = repository_identity
    AND pr_number = pull_request_number
    AND publication_generation = generation_number
    AND operation_source = 'cli';
$$;
--> statement-breakpoint
CREATE FUNCTION "postil_guard_review_publication_generation"()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  repository_row public.repositories%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.repositories WHERE id = OLD.repository_id) THEN
      RAISE EXCEPTION 'review publication generations can only be deleted by repository teardown';
    END IF;
    RETURN OLD;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(NEW.repository_id::text || ':' || NEW.pr_number::text, 0)
  );

  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF OLD.sealed_at IS NULL
       AND NEW.sealed_at IS NOT NULL
       AND isfinite(NEW.sealed_at)
       AND (to_jsonb(NEW) - 'sealed_at') = (to_jsonb(OLD) - 'sealed_at')
       AND EXISTS (
         SELECT 1
         FROM public.pull_request_publication_high_waters high_water
         WHERE high_water.repository_id = NEW.repository_id
           AND high_water.pr_number = NEW.pr_number
           AND high_water.publication_generation = NEW.publication_generation
           AND high_water.accepted_review_id = NEW.review_id
           AND high_water.accepted_input_digest = NEW.accepted_input_digest
           AND high_water.accepted_head_sha = NEW.head_sha
       ) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'review publication generation is immutable';
  END IF;

  IF NEW.sealed_at IS NOT NULL THEN
    RAISE EXCEPTION 'review publication generations must be inserted unsealed';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.reviews
    WHERE id = NEW.review_id
      AND repository_id = NEW.repository_id
      AND pr_number = NEW.pr_number
      AND head_sha = NEW.head_sha
      AND base_sha = NEW.target_sha
  ) THEN
    RAISE EXCEPTION 'review publication generation does not match its review identity'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  SELECT * INTO repository_row
  FROM public.repositories
  WHERE id = NEW.repository_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'review publication generation does not match its repository identity'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF (
    public.postil_has_exact_json_keys(
      NEW.accepted_plan,
      ARRAY['version', 'forge', 'controllerGeneration', 'inputIdentity', 'reviewOutputDigest',
            'repository', 'pullRequestNumber', 'reviewedSnapshot', 'lifecycleReceipt',
            'operationCount', 'operationManifestDigest', 'operations', 'gateAnalysis', 'intentDigest']
    )
    AND public.postil_has_exact_json_keys(
      NEW.accepted_plan->'repository', ARRAY['id', 'fullName']
    )
    AND public.postil_has_exact_json_keys(
      NEW.accepted_plan->'reviewedSnapshot',
      ARRAY['headSha', 'mergeBaseSha', 'targetSha', 'pullRequestTitleSha256', 'pullRequestBodySha256']
    )
    AND (
      public.postil_has_exact_json_keys(
        NEW.accepted_plan->'gateAnalysis',
        ARRAY['ownership', 'authoritative', 'organizationGateModeRequired', 'name', 'headSha',
              'analyzedConclusion', 'title', 'summary']
      )
      OR public.postil_has_exact_json_keys(
        NEW.accepted_plan->'gateAnalysis',
        ARRAY['ownership', 'authoritative', 'organizationGateModeRequired', 'name', 'headSha',
              'analyzedConclusion', 'title', 'summary', 'detailsUrl']
      )
    )
    AND jsonb_typeof(NEW.accepted_plan->'version') = 'number'
    AND NEW.accepted_plan->>'version' ~ '^[1-9][0-9]{0,8}$'
    AND NEW.plan_version = 'github-publication-v' || (NEW.accepted_plan->>'version')
    AND NEW.accepted_plan->>'forge' = 'github'
    AND NEW.accepted_plan->>'controllerGeneration' = NEW.publication_generation::text
    AND NEW.accepted_plan->>'inputIdentity' = 'sha256:' || NEW.accepted_input_digest
    AND NEW.accepted_plan->>'reviewOutputDigest' ~ '^sha256:[0-9a-f]{64}$'
    AND jsonb_typeof(NEW.accepted_plan->'repository') = 'object'
    AND NEW.accepted_plan->'repository'->>'id' = repository_row.github_repo_id::text
    AND NEW.accepted_plan->'repository'->>'fullName' = repository_row.full_name
    AND NEW.repository_full_name = repository_row.full_name
    AND NEW.accepted_plan->>'pullRequestNumber' = NEW.pr_number::text
    AND jsonb_typeof(NEW.accepted_plan->'reviewedSnapshot') = 'object'
    AND NEW.accepted_plan->'reviewedSnapshot'->>'headSha' = NEW.head_sha
    AND NEW.accepted_plan->'reviewedSnapshot'->>'mergeBaseSha' = NEW.base_sha
    AND NEW.accepted_plan->'reviewedSnapshot'->>'targetSha' = NEW.target_sha
    AND NEW.accepted_plan->'reviewedSnapshot'->>'pullRequestTitleSha256' =
      'sha256:' || encode(sha256(convert_to(NEW.pull_request_title, 'UTF8')), 'hex')
    AND NEW.accepted_plan->'reviewedSnapshot'->>'pullRequestBodySha256' =
      'sha256:' || encode(sha256(convert_to(NEW.pull_request_body, 'UTF8')), 'hex')
    AND jsonb_typeof(NEW.accepted_plan->'lifecycleReceipt') = 'object'
    AND NEW.accepted_plan->'lifecycleReceipt'->>'inputIdentity' = NEW.accepted_plan->>'inputIdentity'
    AND NEW.accepted_plan->'gateAnalysis'->>'ownership' = 'service'
    AND NEW.accepted_plan->'gateAnalysis'->>'authoritative' = 'false'
    AND NEW.accepted_plan->'gateAnalysis'->>'organizationGateModeRequired' = 'true'
    AND NEW.accepted_plan->'gateAnalysis'->>'name' = 'postil/gate'
    AND NEW.accepted_plan->'gateAnalysis'->>'headSha' = NEW.head_sha
    AND jsonb_typeof(NEW.accepted_plan->'operationCount') = 'number'
    AND NEW.accepted_plan->>'operationCount' = NEW.operation_count::text
    AND NEW.accepted_plan->>'operationManifestDigest' = NEW.operation_manifest_digest
    AND jsonb_typeof(NEW.accepted_plan->'operations') = 'array'
    AND NEW.accepted_plan->>'intentDigest' = 'sha256:' || NEW.plan_semantic_digest
  ) IS NOT TRUE THEN
    RAISE EXCEPTION 'accepted publication plan does not match its immutable generation envelope';
  END IF;
  IF (
    public.postil_has_exact_json_keys(
      NEW.controller_manifest,
      ARRAY['version', 'forge', 'controllerGeneration', 'inputIdentity', 'reviewOutputDigest',
            'repository', 'pullRequestNumber', 'headSha', 'acceptedPlanIntentDigest',
            'acceptedPlanOperationManifestDigest', 'acceptedPlanBytesDigest',
            'acceptedCliOperationCount', 'operationCount', 'operationManifestDigest', 'operations']
    )
    AND public.postil_has_exact_json_keys(NEW.controller_manifest->'repository', ARRAY['id', 'fullName'])
    AND NEW.controller_manifest->>'version' = 'github-publication-controller-v1'
    AND NEW.controller_manifest->>'forge' = 'github'
    AND NEW.controller_manifest->>'controllerGeneration' = NEW.publication_generation::text
    AND NEW.controller_manifest->>'inputIdentity' = 'sha256:' || NEW.accepted_input_digest
    AND NEW.controller_manifest->>'reviewOutputDigest' = NEW.accepted_plan->>'reviewOutputDigest'
    AND NEW.controller_manifest->'repository'->>'id' = repository_row.github_repo_id::text
    AND NEW.controller_manifest->'repository'->>'fullName' = repository_row.full_name
    AND NEW.controller_manifest->>'pullRequestNumber' = NEW.pr_number::text
    AND NEW.controller_manifest->>'headSha' = NEW.head_sha
    AND NEW.controller_manifest->>'acceptedPlanIntentDigest' = 'sha256:' || NEW.plan_semantic_digest
    AND NEW.controller_manifest->>'acceptedPlanOperationManifestDigest' = NEW.operation_manifest_digest
    AND NEW.controller_manifest->>'acceptedPlanBytesDigest' = 'sha256:' || NEW.accepted_plan_digest
    AND NEW.controller_manifest->>'acceptedCliOperationCount' = NEW.operation_count::text
    AND NEW.controller_manifest->>'operationCount' = NEW.controller_operation_count::text
    AND NEW.controller_manifest->>'operationManifestDigest' = NEW.controller_operation_manifest_digest
  ) IS NOT TRUE THEN
    RAISE EXCEPTION 'controller manifest does not bind the accepted publication plan';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "review_publication_generations_guard_identity"
BEFORE INSERT OR UPDATE OR DELETE ON "review_publication_generations"
FOR EACH ROW EXECUTE FUNCTION "postil_guard_review_publication_generation"();
--> statement-breakpoint
CREATE FUNCTION "postil_guard_review_publication_operation_dependency"()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  source_ordinal integer;
  dependency_ordinal integer;
  next_position integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.repositories WHERE id = OLD.repository_id) THEN
      RAISE EXCEPTION 'review publication operation dependencies are immutable';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'review publication operation dependencies are immutable';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(NEW.repository_id::text || ':' || NEW.pr_number::text, 0)
  );
  IF EXISTS (
    SELECT 1
    FROM public.review_publication_generations
    WHERE repository_id = NEW.repository_id
      AND pr_number = NEW.pr_number
      AND publication_generation = NEW.publication_generation
      AND sealed_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'sealed publication generations cannot accept dependency edges';
  END IF;

  SELECT operation_ordinal INTO source_ordinal
  FROM public.review_publication_operations
  WHERE repository_id = NEW.repository_id
    AND pr_number = NEW.pr_number
    AND publication_generation = NEW.publication_generation
    AND operation_key = NEW.operation_key
  FOR SHARE;
  SELECT operation_ordinal INTO dependency_ordinal
  FROM public.review_publication_operations
  WHERE repository_id = NEW.repository_id
    AND pr_number = NEW.pr_number
    AND publication_generation = NEW.publication_generation
    AND operation_key = NEW.dependency_operation_key
  FOR SHARE;
  IF source_ordinal IS NULL OR dependency_ordinal IS NULL THEN
    RETURN NEW;
  END IF;
  IF dependency_ordinal >= source_ordinal THEN
    RAISE EXCEPTION 'publication operation dependencies must reference an earlier ordinal';
  END IF;
  SELECT count(*)::integer INTO next_position
  FROM public.review_publication_operation_dependencies
  WHERE repository_id = NEW.repository_id
    AND pr_number = NEW.pr_number
    AND publication_generation = NEW.publication_generation
    AND operation_key = NEW.operation_key;
  IF (
    SELECT count(*)
    FROM public.review_publication_operation_dependencies
    WHERE repository_id = NEW.repository_id
      AND pr_number = NEW.pr_number
      AND publication_generation = NEW.publication_generation
  ) >= 1024 THEN
    RAISE EXCEPTION 'publication generation exceeds the 1024 dependency-edge limit';
  END IF;
  IF NEW.dependency_position <> next_position THEN
    RAISE EXCEPTION 'publication operation dependency positions must be contiguous and zero-based';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "review_publication_operation_dependencies_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "review_publication_operation_dependencies"
FOR EACH ROW EXECUTE FUNCTION "postil_guard_review_publication_operation_dependency"();
--> statement-breakpoint
CREATE FUNCTION "postil_guard_review_publication_operation"()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  database_now timestamp with time zone := pg_catalog.clock_timestamp();
  has_not_dispatched boolean;
  has_applied boolean;
  has_rejected boolean;
  has_ambiguous boolean;
  has_retry_absence boolean;
  has_terminal_absence boolean;
  has_terminal_applied boolean;
  dependencies_terminal boolean;
  activation_eligible boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.repositories WHERE id = OLD.repository_id) THEN
      RAISE EXCEPTION 'review publication operations can only be deleted by repository teardown';
    END IF;
    RETURN OLD;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(NEW.repository_id::text || ':' || NEW.pr_number::text, 0)
  );

  IF TG_OP = 'INSERT' THEN
    IF EXISTS (
      SELECT 1
      FROM public.review_publication_generations
      WHERE repository_id = NEW.repository_id
        AND pr_number = NEW.pr_number
        AND publication_generation = NEW.publication_generation
        AND sealed_at IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'sealed publication generations cannot accept operations';
    END IF;
    IF NEW.state <> 'pending'
       OR NEW.attempt_count <> 0
       OR NEW.lease_generation <> 0
       OR NEW.claim_owner IS NOT NULL
       OR NEW.lease_id IS NOT NULL
       OR NEW.lease_expires_at IS NOT NULL
       OR NEW.selected_variant IS NOT NULL
       OR NEW.retry_after IS NOT NULL
       OR NEW.last_error IS NOT NULL
       OR NEW.terminal_evidence IS NOT NULL
       OR NEW.evidence_generation <> 0
       OR NEW.created_at <> NEW.updated_at THEN
      RAISE EXCEPTION 'publication operations must be inserted in pristine pending state';
    END IF;
    IF (
      SELECT 2 + count(*) + COALESCE(sum(octet_length(controller_record_bytes)), 0)
      FROM public.review_publication_operations
      WHERE repository_id = NEW.repository_id
        AND pr_number = NEW.pr_number
        AND publication_generation = NEW.publication_generation
    ) + octet_length(NEW.controller_record_bytes) > 8388608 THEN
      RAISE EXCEPTION 'publication generation exceeds the 8 MiB canonical controller-record limit';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF NEW.updated_at < OLD.updated_at
     OR NEW.updated_at > database_now + interval '1 second' THEN
    RAISE EXCEPTION 'publication operation timestamps must not be backdated or future-dated';
  END IF;
  NEW.updated_at := database_now;
  IF NEW.repository_id IS DISTINCT FROM OLD.repository_id
     OR NEW.pr_number IS DISTINCT FROM OLD.pr_number
     OR NEW.publication_generation IS DISTINCT FROM OLD.publication_generation
     OR NEW.review_id IS DISTINCT FROM OLD.review_id
     OR NEW.operation_key IS DISTINCT FROM OLD.operation_key
     OR NEW.operation_ordinal IS DISTINCT FROM OLD.operation_ordinal
     OR NEW.operation_source IS DISTINCT FROM OLD.operation_source
     OR NEW.controller_record IS DISTINCT FROM OLD.controller_record
     OR NEW.controller_record_bytes IS DISTINCT FROM OLD.controller_record_bytes
     OR NEW.operation_record IS DISTINCT FROM OLD.operation_record
     OR NEW.operation_record_bytes IS DISTINCT FROM OLD.operation_record_bytes
     OR NEW.activation IS DISTINCT FROM OLD.activation
     OR NEW.activation_bytes IS DISTINCT FROM OLD.activation_bytes
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.desired_payload IS DISTINCT FROM OLD.desired_payload
     OR NEW.desired_payload_bytes IS DISTINCT FROM OLD.desired_payload_bytes
     OR NEW.desired_payload_digest IS DISTINCT FROM OLD.desired_payload_digest
     OR NEW.deadline_at IS DISTINCT FROM OLD.deadline_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'publication operation intent is immutable';
  END IF;
  IF NEW.attempt_count < OLD.attempt_count
     OR NEW.lease_generation < OLD.lease_generation THEN
    RAISE EXCEPTION 'publication operation attempt counters cannot decrease';
  END IF;
  IF OLD.terminal_evidence IS NOT NULL
     AND NEW.terminal_evidence IS DISTINCT FROM OLD.terminal_evidence THEN
    RAISE EXCEPTION 'publication operation terminal evidence is immutable';
  END IF;
  IF NEW.evidence_generation <> OLD.evidence_generation THEN
    IF NEW.evidence_generation = OLD.evidence_generation + 1
       AND (to_jsonb(NEW) - ARRAY['evidence_generation', 'updated_at'])
            = (to_jsonb(OLD) - ARRAY['evidence_generation', 'updated_at']) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'publication operation evidence generation is database-serialized';
  END IF;
  IF OLD.state IN ('applied', 'skipped', 'superseded', 'failed') THEN
    RAISE EXCEPTION 'terminal publication operations are immutable';
  END IF;

  SELECT
    EXISTS (
      SELECT 1 FROM public.review_publication_operation_attempts
      WHERE repository_id = OLD.repository_id
        AND pr_number = OLD.pr_number
        AND publication_generation = OLD.publication_generation
        AND operation_key = OLD.operation_key
        AND attempt_number = OLD.attempt_count
        AND lease_generation = OLD.lease_generation
        AND phase = 'not_dispatched'
    ),
    EXISTS (
      SELECT 1 FROM public.review_publication_operation_attempts
      WHERE repository_id = OLD.repository_id
        AND pr_number = OLD.pr_number
        AND publication_generation = OLD.publication_generation
        AND operation_key = OLD.operation_key
        AND attempt_number = OLD.attempt_count
        AND lease_generation = OLD.lease_generation
        AND phase = 'applied'
    ),
    EXISTS (
      SELECT 1 FROM public.review_publication_operation_attempts
      WHERE repository_id = OLD.repository_id
        AND pr_number = OLD.pr_number
        AND publication_generation = OLD.publication_generation
        AND operation_key = OLD.operation_key
        AND attempt_number = OLD.attempt_count
        AND lease_generation = OLD.lease_generation
        AND phase = 'rejected'
    ),
    EXISTS (
      SELECT 1 FROM public.review_publication_operation_attempts
      WHERE repository_id = OLD.repository_id
        AND pr_number = OLD.pr_number
        AND publication_generation = OLD.publication_generation
        AND operation_key = OLD.operation_key
        AND attempt_number = OLD.attempt_count
        AND lease_generation = OLD.lease_generation
        AND phase = 'ambiguous'
    ),
    EXISTS (
      SELECT 1 FROM public.review_publication_operation_reconciliations
      WHERE repository_id = OLD.repository_id
        AND pr_number = OLD.pr_number
        AND publication_generation = OLD.publication_generation
        AND operation_key = OLD.operation_key
        AND attempt_number = OLD.attempt_count
        AND lease_generation = OLD.lease_generation
        AND phase = 'retry' AND outcome = 'exact_absence'
        AND observed_at >= database_now - interval '5 minutes'
        AND observed_at <= database_now + interval '1 second'
    ),
    EXISTS (
      SELECT 1 FROM public.review_publication_operation_reconciliations
      WHERE repository_id = OLD.repository_id
        AND pr_number = OLD.pr_number
        AND publication_generation = OLD.publication_generation
        AND operation_key = OLD.operation_key
        AND attempt_number = OLD.attempt_count
        AND lease_generation = OLD.lease_generation
        AND phase = 'terminal' AND outcome = 'exact_absence'
    ),
    EXISTS (
      SELECT 1 FROM public.review_publication_operation_reconciliations
      WHERE repository_id = OLD.repository_id
        AND pr_number = OLD.pr_number
        AND publication_generation = OLD.publication_generation
        AND operation_key = OLD.operation_key
        AND attempt_number = OLD.attempt_count
        AND lease_generation = OLD.lease_generation
        AND phase = 'terminal' AND outcome = 'applied'
    )
  INTO has_not_dispatched, has_applied, has_rejected, has_ambiguous,
       has_retry_absence, has_terminal_absence, has_terminal_applied;

  IF NEW.state = OLD.state THEN
    IF OLD.state = 'pending' THEN
      IF (to_jsonb(NEW) - ARRAY['retry_after', 'last_error', 'updated_at'])
           <> (to_jsonb(OLD) - ARRAY['retry_after', 'last_error', 'updated_at']) THEN
        RAISE EXCEPTION 'pending publication updates may only change retry metadata';
      END IF;
      RETURN NEW;
    END IF;
    IF OLD.state = 'unknown' THEN
      IF (to_jsonb(NEW) - ARRAY['retry_after', 'updated_at'])
           <> (to_jsonb(OLD) - ARRAY['retry_after', 'updated_at']) THEN
        RAISE EXCEPTION 'unknown publication updates may only change retry scheduling';
      END IF;
      RETURN NEW;
    END IF;
    IF OLD.state = 'applying' THEN
      IF NEW.lease_id = OLD.lease_id
         AND NEW.claim_owner = OLD.claim_owner
         AND NEW.attempt_count = OLD.attempt_count
         AND NEW.lease_generation = OLD.lease_generation
         AND NEW.selected_variant = OLD.selected_variant THEN
        IF OLD.lease_expires_at <= database_now
           OR NEW.lease_expires_at <= OLD.lease_expires_at
           OR NEW.lease_expires_at <= database_now
           OR (to_jsonb(NEW) - ARRAY['lease_expires_at', 'updated_at'])
                <> (to_jsonb(OLD) - ARRAY['lease_expires_at', 'updated_at']) THEN
          RAISE EXCEPTION 'publication lease renewal may only extend the current lease';
        END IF;
        RETURN NEW;
      END IF;
      IF OLD.lease_expires_at > database_now
         OR NEW.lease_id IS NOT DISTINCT FROM OLD.lease_id
         OR NEW.attempt_count <> OLD.attempt_count + 1
         OR NEW.lease_generation <> OLD.lease_generation + 1
         OR NEW.last_error IS DISTINCT FROM OLD.last_error
         OR NEW.retry_after IS DISTINCT FROM OLD.retry_after
         OR NEW.terminal_evidence IS DISTINCT FROM OLD.terminal_evidence
         OR EXISTS (
           SELECT 1 FROM public.review_publication_operation_attempts
           WHERE repository_id = OLD.repository_id
             AND pr_number = OLD.pr_number
             AND publication_generation = OLD.publication_generation
             AND operation_key = OLD.operation_key
             AND attempt_number = OLD.attempt_count
             AND lease_generation = OLD.lease_generation
             AND phase = 'dispatched'
         ) THEN
        RAISE EXCEPTION 'publication lease replacement requires an expired undispatched attempt and new counters';
      END IF;
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'publication operation state is terminal';
  END IF;

  IF OLD.state = 'pending' AND NEW.state = 'applying' THEN
    IF NEW.attempt_count <> OLD.attempt_count + 1
       OR NEW.lease_generation <> OLD.lease_generation + 1
       OR NEW.lease_id IS NULL
       OR NEW.claim_owner IS NULL
       OR NEW.selected_variant IS NULL
       OR NEW.last_error IS DISTINCT FROM OLD.last_error
       OR NEW.terminal_evidence IS NOT NULL THEN
      RAISE EXCEPTION 'claiming a publication operation requires a fresh attempt and lease';
    END IF;
    IF NEW.lease_expires_at <= database_now THEN
      RAISE EXCEPTION 'publication claims require a lease that expires after the database clock';
    END IF;
    SELECT NOT EXISTS (
      SELECT 1
      FROM public.review_publication_operation_dependencies dependency
      JOIN public.review_publication_operations predecessor
        ON predecessor.repository_id = dependency.repository_id
       AND predecessor.pr_number = dependency.pr_number
       AND predecessor.publication_generation = dependency.publication_generation
       AND predecessor.operation_key = dependency.dependency_operation_key
      WHERE dependency.repository_id = OLD.repository_id
        AND dependency.pr_number = OLD.pr_number
        AND dependency.publication_generation = OLD.publication_generation
        AND dependency.operation_key = OLD.operation_key
        AND predecessor.state NOT IN ('applied', 'skipped', 'superseded', 'failed')
    ) INTO dependencies_terminal;
    IF NOT EXISTS (
      SELECT 1
      FROM public.pull_request_publication_high_waters high_water
      JOIN public.review_publication_generations generation
        ON generation.repository_id = high_water.repository_id
       AND generation.pr_number = high_water.pr_number
       AND generation.publication_generation = high_water.publication_generation
      WHERE high_water.repository_id = OLD.repository_id
        AND high_water.pr_number = OLD.pr_number
        AND high_water.publication_generation = OLD.publication_generation
        AND generation.sealed_at IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'only the current sealed publication generation can be claimed';
    END IF;
    SELECT COALESCE(bool_or(
      CASE condition->>'condition'
        WHEN 'always' THEN condition = jsonb_build_object('condition', 'always')
        WHEN 'markerAbsent' THEN public.postil_has_exact_json_keys(condition, ARRAY['condition', 'guard'])
        WHEN 'findingContentDiffers' THEN public.postil_has_exact_json_keys(
          condition, ARRAY['condition', 'observedCommentId', 'expectedMarkers']
        )
        WHEN 'allDependenciesTerminal' THEN condition = jsonb_build_object('condition', 'allDependenciesTerminal')
          AND dependencies_terminal
        WHEN 'semanticPlacementRejected' THEN EXISTS (
          SELECT 1
          FROM public.review_publication_operations predecessor
          WHERE predecessor.repository_id = OLD.repository_id
            AND predecessor.pr_number = OLD.pr_number
            AND predecessor.publication_generation = OLD.publication_generation
            AND predecessor.operation_key = condition->>'dependencyOperationKey'
            AND predecessor.state = 'failed'
            AND predecessor.terminal_evidence @> jsonb_build_object(
              'httpStatus', condition->'httpStatus',
              'classification', condition->'classification'
            )
        )
        WHEN 'partialReviewObserved' THEN EXISTS (
          SELECT 1
          FROM public.review_publication_operations predecessor
          JOIN public.review_publication_operation_attempts evidence
            ON evidence.repository_id = predecessor.repository_id
           AND evidence.pr_number = predecessor.pr_number
           AND evidence.publication_generation = predecessor.publication_generation
           AND evidence.operation_key = predecessor.operation_key
           AND evidence.attempt_number = predecessor.attempt_count
           AND evidence.lease_generation = predecessor.lease_generation
           AND evidence.phase = 'applied'
          WHERE predecessor.repository_id = OLD.repository_id
            AND predecessor.pr_number = OLD.pr_number
            AND predecessor.publication_generation = OLD.publication_generation
            AND predecessor.operation_key = condition->>'dependencyOperationKey'
            AND predecessor.state = 'applied'
            AND evidence.evidence_payload @> jsonb_build_object('reviewMarkers', condition->'reviewMarkers')
        )
        WHEN 'reviewSelectionTerminal' THEN NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(condition->'selectedReviewOperationKeys') selected(operation_key)
          LEFT JOIN public.review_publication_operations predecessor
            ON predecessor.repository_id = OLD.repository_id
           AND predecessor.pr_number = OLD.pr_number
           AND predecessor.publication_generation = OLD.publication_generation
           AND predecessor.operation_key = selected.operation_key
          WHERE predecessor.operation_key IS NULL
             OR predecessor.state NOT IN ('applied', 'skipped', 'superseded', 'failed')
        )
        ELSE false
      END
    ), false)
    INTO activation_eligible
    FROM jsonb_array_elements(OLD.activation->'anyOf') condition;
    IF NOT dependencies_terminal OR NOT activation_eligible THEN
      RAISE EXCEPTION 'publication claim requires terminal dependencies and immutable activation evidence';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.state = 'pending' AND NEW.state IN ('skipped', 'superseded', 'failed') THEN
    IF NEW.attempt_count <> OLD.attempt_count
       OR NEW.lease_generation <> OLD.lease_generation
       OR NEW.selected_variant IS NOT NULL THEN
      RAISE EXCEPTION 'unclaimed terminal publication operations cannot add attempt state';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.state = 'applying' AND NEW.state = 'pending' THEN
    IF NOT has_not_dispatched
       OR NEW.attempt_count <> OLD.attempt_count
       OR NEW.lease_generation <> OLD.lease_generation
       OR NEW.selected_variant IS NOT NULL
       OR NEW.terminal_evidence IS NOT NULL THEN
      RAISE EXCEPTION 'retrying an applying operation requires exact not-dispatched evidence';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.state = 'applying' AND NEW.state = 'unknown' THEN
    IF NOT has_ambiguous
       OR NEW.attempt_count <> OLD.attempt_count
       OR NEW.lease_generation <> OLD.lease_generation
       OR NEW.selected_variant IS DISTINCT FROM OLD.selected_variant
       OR NEW.last_error IS DISTINCT FROM (
         SELECT error_reason
         FROM public.review_publication_operation_attempts
         WHERE repository_id = OLD.repository_id
           AND pr_number = OLD.pr_number
           AND publication_generation = OLD.publication_generation
           AND operation_key = OLD.operation_key
           AND attempt_number = OLD.attempt_count
           AND lease_generation = OLD.lease_generation
           AND phase = 'ambiguous'
       ) THEN
      RAISE EXCEPTION 'unknown publication state requires matching ambiguous attempt evidence';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.state = 'applying' AND NEW.state = 'applied' THEN
    IF NOT has_applied
       OR NEW.attempt_count <> OLD.attempt_count
       OR NEW.lease_generation <> OLD.lease_generation
       OR NEW.selected_variant IS DISTINCT FROM OLD.selected_variant THEN
      RAISE EXCEPTION 'applied publication state requires exact applied attempt evidence';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.state = 'applying' AND NEW.state = 'superseded' THEN
    IF NOT has_not_dispatched
       OR NEW.attempt_count <> OLD.attempt_count
       OR NEW.lease_generation <> OLD.lease_generation
       OR NEW.selected_variant IS DISTINCT FROM OLD.selected_variant THEN
      RAISE EXCEPTION 'terminating an applying operation requires proof no mutation was dispatched';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.state = 'applying' AND NEW.state = 'failed' THEN
    IF has_rejected THEN
      IF NEW.attempt_count <> OLD.attempt_count
         OR NEW.lease_generation <> OLD.lease_generation
         OR NEW.selected_variant IS DISTINCT FROM OLD.selected_variant
         OR NEW.last_error IS DISTINCT FROM (
           SELECT error_reason
           FROM public.review_publication_operation_attempts
           WHERE repository_id = OLD.repository_id
             AND pr_number = OLD.pr_number
             AND publication_generation = OLD.publication_generation
             AND operation_key = OLD.operation_key
             AND attempt_number = OLD.attempt_count
             AND lease_generation = OLD.lease_generation
             AND phase = 'rejected'
         )
         OR NEW.terminal_evidence IS DISTINCT FROM (
           SELECT evidence_payload
           FROM public.review_publication_operation_attempts
           WHERE repository_id = OLD.repository_id
             AND pr_number = OLD.pr_number
             AND publication_generation = OLD.publication_generation
             AND operation_key = OLD.operation_key
             AND attempt_number = OLD.attempt_count
             AND lease_generation = OLD.lease_generation
             AND phase = 'rejected'
         ) THEN
        RAISE EXCEPTION 'rejected publication state requires exact rejection evidence';
      END IF;
      RETURN NEW;
    END IF;
    IF NOT has_not_dispatched
       OR NEW.attempt_count <> OLD.attempt_count
       OR NEW.lease_generation <> OLD.lease_generation
       OR NEW.selected_variant IS DISTINCT FROM OLD.selected_variant THEN
      RAISE EXCEPTION 'terminating an applying operation requires proof no mutation was dispatched';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.state = 'unknown' AND NEW.state = 'pending' THEN
    IF NOT has_retry_absence
       OR NEW.attempt_count <> OLD.attempt_count
       OR NEW.lease_generation <> OLD.lease_generation
       OR NEW.selected_variant IS NOT NULL THEN
      RAISE EXCEPTION 'retrying an ambiguous operation requires fresh exact-absence reconciliation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.state = 'unknown' AND NEW.state = 'applied' THEN
    IF NOT has_terminal_applied
       OR NEW.attempt_count <> OLD.attempt_count
       OR NEW.lease_generation <> OLD.lease_generation
       OR NEW.selected_variant IS DISTINCT FROM OLD.selected_variant THEN
      RAISE EXCEPTION 'applied reconciliation must match the ambiguous attempt';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.state = 'unknown' AND NEW.state IN ('superseded', 'failed') THEN
    IF NOT has_terminal_absence
       OR NEW.attempt_count <> OLD.attempt_count
       OR NEW.lease_generation <> OLD.lease_generation
       OR NEW.selected_variant IS DISTINCT FROM OLD.selected_variant THEN
      RAISE EXCEPTION 'terminal ambiguous operations require exact-absence reconciliation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid publication operation state transition from % to %', OLD.state, NEW.state;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "review_publication_operations_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "review_publication_operations"
FOR EACH ROW EXECUTE FUNCTION "postil_guard_review_publication_operation"();
--> statement-breakpoint
CREATE FUNCTION "postil_record_review_publication_claim"()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.state = 'applying'
     AND (OLD.state <> 'applying'
       OR NEW.attempt_count <> OLD.attempt_count
       OR NEW.lease_generation <> OLD.lease_generation) THEN
    INSERT INTO public.review_publication_operation_attempts (
      repository_id, pr_number, publication_generation, operation_key,
      attempt_number, lease_generation, phase, selected_variant,
      observed_at, created_at
    ) VALUES (
      NEW.repository_id, NEW.pr_number, NEW.publication_generation, NEW.operation_key,
      NEW.attempt_count, NEW.lease_generation, 'claimed', NEW.selected_variant,
      NEW.updated_at, NEW.updated_at
    );
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "review_publication_operations_record_claim"
AFTER UPDATE ON "review_publication_operations"
FOR EACH ROW EXECUTE FUNCTION "postil_record_review_publication_claim"();
--> statement-breakpoint
CREATE FUNCTION "postil_guard_review_publication_operation_attempt"()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  operation_row public.review_publication_operations%ROWTYPE;
  claimed_at timestamp with time zone;
  database_now timestamp with time zone := pg_catalog.clock_timestamp();
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.repositories WHERE id = OLD.repository_id) THEN
      RAISE EXCEPTION 'review publication operation attempts are append-only';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'review publication operation attempts are append-only';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(NEW.repository_id::text || ':' || NEW.pr_number::text, 0)
  );
  SELECT * INTO operation_row
  FROM public.review_publication_operations
  WHERE repository_id = NEW.repository_id
    AND pr_number = NEW.pr_number
    AND publication_generation = NEW.publication_generation
    AND operation_key = NEW.operation_key
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.review_publication_generations
    WHERE repository_id = NEW.repository_id
      AND pr_number = NEW.pr_number
      AND publication_generation = NEW.publication_generation
      AND sealed_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'publication attempt evidence requires a sealed generation';
  END IF;
  IF NEW.observed_at < database_now - interval '5 minutes'
     OR NEW.observed_at > database_now + interval '1 second'
     OR NEW.created_at < database_now - interval '5 minutes'
     OR NEW.created_at > database_now + interval '1 second' THEN
    RAISE EXCEPTION 'publication attempt evidence timestamps must be fresh database-time observations';
  END IF;

  IF NEW.phase = 'claimed' THEN
    IF operation_row.state <> 'applying'
       OR operation_row.attempt_count <> NEW.attempt_number
       OR operation_row.lease_generation <> NEW.lease_generation
       OR operation_row.selected_variant IS DISTINCT FROM NEW.selected_variant
       OR NEW.observed_at <> operation_row.updated_at
       OR NEW.created_at <> NEW.observed_at THEN
      RAISE EXCEPTION 'claimed attempt evidence is recorded atomically with its lease';
    END IF;
    UPDATE public.review_publication_operations
    SET evidence_generation = evidence_generation + 1
    WHERE id = operation_row.id;
    RETURN NEW;
  END IF;

  IF operation_row.state <> 'applying'
     OR operation_row.attempt_count <> NEW.attempt_number
     OR operation_row.lease_generation <> NEW.lease_generation
     OR operation_row.selected_variant IS DISTINCT FROM NEW.selected_variant THEN
    RAISE EXCEPTION 'attempt evidence must match the active publication lease';
  END IF;
  SELECT observed_at INTO claimed_at
  FROM public.review_publication_operation_attempts
  WHERE repository_id = NEW.repository_id
    AND pr_number = NEW.pr_number
    AND publication_generation = NEW.publication_generation
    AND operation_key = NEW.operation_key
    AND attempt_number = NEW.attempt_number
    AND lease_generation = NEW.lease_generation
    AND phase = 'claimed';
  IF claimed_at IS NULL OR NEW.observed_at < claimed_at THEN
    RAISE EXCEPTION 'attempt evidence requires its preceding claim';
  END IF;

  UPDATE public.review_publication_operations
  SET evidence_generation = evidence_generation + 1
  WHERE id = operation_row.id;

  IF NEW.phase = 'dispatched' THEN
    IF EXISTS (
      SELECT 1 FROM public.review_publication_operation_attempts
      WHERE repository_id = NEW.repository_id
        AND pr_number = NEW.pr_number
        AND publication_generation = NEW.publication_generation
        AND operation_key = NEW.operation_key
        AND attempt_number = NEW.attempt_number
        AND lease_generation = NEW.lease_generation
        AND phase = 'not_dispatched'
    ) THEN
      RAISE EXCEPTION 'a not-dispatched attempt cannot later be dispatched';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.phase = 'not_dispatched' THEN
    IF EXISTS (
      SELECT 1 FROM public.review_publication_operation_attempts
      WHERE repository_id = NEW.repository_id
        AND pr_number = NEW.pr_number
        AND publication_generation = NEW.publication_generation
        AND operation_key = NEW.operation_key
        AND attempt_number = NEW.attempt_number
        AND lease_generation = NEW.lease_generation
        AND phase IN ('dispatched', 'ambiguous', 'applied', 'rejected')
    ) THEN
      RAISE EXCEPTION 'dispatched attempts require remote outcome evidence';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.phase = 'ambiguous' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.review_publication_operation_attempts
      WHERE repository_id = NEW.repository_id
        AND pr_number = NEW.pr_number
        AND publication_generation = NEW.publication_generation
        AND operation_key = NEW.operation_key
        AND attempt_number = NEW.attempt_number
        AND lease_generation = NEW.lease_generation
        AND phase = 'dispatched' AND observed_at <= NEW.observed_at
    ) OR EXISTS (
      SELECT 1 FROM public.review_publication_operation_attempts
      WHERE repository_id = NEW.repository_id
        AND pr_number = NEW.pr_number
        AND publication_generation = NEW.publication_generation
        AND operation_key = NEW.operation_key
        AND attempt_number = NEW.attempt_number
        AND lease_generation = NEW.lease_generation
        AND phase IN ('applied', 'rejected')
    ) THEN
      RAISE EXCEPTION 'ambiguous evidence requires a dispatched attempt without terminal proof';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.phase = 'rejected' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.review_publication_operation_attempts
      WHERE repository_id = NEW.repository_id
        AND pr_number = NEW.pr_number
        AND publication_generation = NEW.publication_generation
        AND operation_key = NEW.operation_key
        AND attempt_number = NEW.attempt_number
        AND lease_generation = NEW.lease_generation
        AND phase = 'dispatched' AND observed_at <= NEW.observed_at
    ) OR EXISTS (
      SELECT 1 FROM public.review_publication_operation_attempts
      WHERE repository_id = NEW.repository_id
        AND pr_number = NEW.pr_number
        AND publication_generation = NEW.publication_generation
        AND operation_key = NEW.operation_key
        AND attempt_number = NEW.attempt_number
        AND lease_generation = NEW.lease_generation
        AND phase IN ('ambiguous', 'applied')
    ) THEN
      RAISE EXCEPTION 'rejected attempt evidence requires an unambiguous dispatch';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.phase = 'applied' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.review_publication_operation_attempts
      WHERE repository_id = NEW.repository_id
        AND pr_number = NEW.pr_number
        AND publication_generation = NEW.publication_generation
        AND operation_key = NEW.operation_key
        AND attempt_number = NEW.attempt_number
        AND lease_generation = NEW.lease_generation
        AND phase = 'dispatched' AND observed_at <= NEW.observed_at
    ) OR EXISTS (
      SELECT 1 FROM public.review_publication_operation_attempts
      WHERE repository_id = NEW.repository_id
        AND pr_number = NEW.pr_number
        AND publication_generation = NEW.publication_generation
        AND operation_key = NEW.operation_key
        AND attempt_number = NEW.attempt_number
        AND lease_generation = NEW.lease_generation
        AND phase IN ('ambiguous', 'rejected')
    ) THEN
      RAISE EXCEPTION 'applied attempt evidence requires an unambiguous dispatch';
    END IF;
    RETURN NEW;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "review_publication_operation_attempts_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "review_publication_operation_attempts"
FOR EACH ROW EXECUTE FUNCTION "postil_guard_review_publication_operation_attempt"();
--> statement-breakpoint
CREATE FUNCTION "postil_guard_review_publication_reconciliation"()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  operation_row public.review_publication_operations%ROWTYPE;
  ambiguity_observed_at timestamp with time zone;
  database_now timestamp with time zone := pg_catalog.clock_timestamp();
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.repositories WHERE id = OLD.repository_id) THEN
      RAISE EXCEPTION 'review publication reconciliations are append-only';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'review publication reconciliations are append-only';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(NEW.repository_id::text || ':' || NEW.pr_number::text, 0)
  );
  SELECT * INTO operation_row
  FROM public.review_publication_operations
  WHERE repository_id = NEW.repository_id
    AND pr_number = NEW.pr_number
    AND publication_generation = NEW.publication_generation
    AND operation_key = NEW.operation_key
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF operation_row.state <> 'unknown'
     OR operation_row.attempt_count <> NEW.attempt_number
     OR operation_row.lease_generation <> NEW.lease_generation
     OR operation_row.selected_variant IS DISTINCT FROM NEW.selected_variant THEN
    RAISE EXCEPTION 'reconciliation must match the current ambiguous attempt';
  END IF;
  IF NEW.observed_at < database_now - interval '5 minutes'
     OR NEW.observed_at > database_now + interval '1 second'
     OR NEW.created_at < database_now - interval '5 minutes'
     OR NEW.created_at > database_now + interval '1 second' THEN
    RAISE EXCEPTION 'reconciliation evidence timestamps must be fresh database-time observations';
  END IF;
  SELECT observed_at INTO ambiguity_observed_at
  FROM public.review_publication_operation_attempts
  WHERE repository_id = NEW.repository_id
    AND pr_number = NEW.pr_number
    AND publication_generation = NEW.publication_generation
    AND operation_key = NEW.operation_key
    AND attempt_number = NEW.attempt_number
    AND lease_generation = NEW.lease_generation
    AND phase = 'ambiguous';
  IF ambiguity_observed_at IS NULL OR NEW.observed_at < ambiguity_observed_at THEN
    RAISE EXCEPTION 'reconciliation requires preceding ambiguity evidence';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.review_publication_operation_reconciliations
    WHERE repository_id = NEW.repository_id
      AND pr_number = NEW.pr_number
      AND publication_generation = NEW.publication_generation
      AND operation_key = NEW.operation_key
      AND attempt_number = NEW.attempt_number
      AND lease_generation = NEW.lease_generation
  ) THEN
    RAISE EXCEPTION 'an ambiguous attempt can have only one reconciliation outcome';
  END IF;
  UPDATE public.review_publication_operations
  SET evidence_generation = evidence_generation + 1
  WHERE id = operation_row.id;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "review_publication_operation_reconciliations_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "review_publication_operation_reconciliations"
FOR EACH ROW EXECUTE FUNCTION "postil_guard_review_publication_reconciliation"();
--> statement-breakpoint
CREATE FUNCTION "postil_guard_pull_request_publication_high_water"()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  retained_generation bigint;
  generation_row public.review_publication_generations%ROWTYPE;
  actual_operation_count integer;
  actual_manifest_digest text;
  actual_cli_operation_count integer;
  actual_cli_manifest_digest text;
  actual_cli_operations jsonb;
  actual_controller_records jsonb;
  source_order_valid boolean;
  gate_create_count integer;
  gate_complete_count integer;
  gate_contract_valid boolean;
  gate_completion_covers_cli boolean;
  operations_pristine boolean;
  ordinals_contiguous boolean;
  dependencies_complete boolean;
  activation_contract_valid boolean;
  seal_generation boolean := false;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.repositories WHERE id = OLD.repository_id) THEN
      RAISE EXCEPTION 'pull request publication high-water rows can only be deleted by repository teardown';
    END IF;
    RETURN OLD;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(NEW.repository_id::text || ':' || NEW.pr_number::text, 0)
  );
  IF TG_OP = 'INSERT' THEN
    seal_generation := true;
  ELSE
    IF NEW.repository_id IS DISTINCT FROM OLD.repository_id
       OR NEW.pr_number IS DISTINCT FROM OLD.pr_number THEN
      RAISE EXCEPTION 'pull request publication high-water identity is immutable';
    END IF;
    IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'pull request publication high-water creation time is immutable';
    END IF;
    IF NEW.publication_generation < OLD.publication_generation THEN
      RAISE EXCEPTION 'pull request publication generation cannot decrease';
    END IF;
    IF NEW.publication_generation = OLD.publication_generation AND (
      NEW.accepted_review_id IS DISTINCT FROM OLD.accepted_review_id
      OR NEW.accepted_input_digest IS DISTINCT FROM OLD.accepted_input_digest
      OR NEW.accepted_head_sha IS DISTINCT FROM OLD.accepted_head_sha
    ) THEN
      RAISE EXCEPTION 'pull request publication identity requires a higher generation';
    END IF;
    seal_generation := NEW.publication_generation > OLD.publication_generation;
    IF NEW IS DISTINCT FROM OLD AND NEW.updated_at <= OLD.updated_at THEN
      RAISE EXCEPTION 'pull request publication high-water updates must advance updated_at';
    END IF;
  END IF;

  IF seal_generation THEN
    SELECT max(publication_generation) INTO retained_generation
    FROM public.review_publication_generations
    WHERE repository_id = NEW.repository_id AND pr_number = NEW.pr_number;
    IF retained_generation IS NULL OR NEW.publication_generation <> retained_generation THEN
      RAISE EXCEPTION 'pull request publication high-water must use the latest retained generation';
    END IF;
    SELECT * INTO generation_row
    FROM public.review_publication_generations
    WHERE repository_id = NEW.repository_id
      AND pr_number = NEW.pr_number
      AND publication_generation = NEW.publication_generation
      AND review_id = NEW.accepted_review_id
      AND accepted_input_digest = NEW.accepted_input_digest
      AND head_sha = NEW.accepted_head_sha
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'pull request publication high-water does not match its generation identity'
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF generation_row.sealed_at IS NOT NULL THEN
      RAISE EXCEPTION 'publication generation is already sealed';
    END IF;

    SELECT
      count(*)::integer,
      COALESCE(
        bool_and(
          state = 'pending'
          AND attempt_count = 0
          AND lease_generation = 0
          AND evidence_generation = 0
          AND claim_owner IS NULL
          AND lease_id IS NULL
          AND lease_expires_at IS NULL
          AND selected_variant IS NULL
          AND retry_after IS NULL
          AND last_error IS NULL
          AND terminal_evidence IS NULL
          AND created_at = updated_at
        ),
        true
      ),
      CASE
        WHEN count(*) = 0 THEN true
        ELSE min(operation_ordinal) = 1 AND max(operation_ordinal) = count(*)
      END,
      COALESCE(
        bool_and(
          operation_record->'dependencies' = COALESCE(
            (
              SELECT jsonb_agg(to_jsonb(dependency_operation_key) ORDER BY dependency_position)
              FROM public.review_publication_operation_dependencies dependency
              WHERE dependency.repository_id = operation.repository_id
                AND dependency.pr_number = operation.pr_number
                AND dependency.publication_generation = operation.publication_generation
                AND dependency.operation_key = operation.operation_key
            ),
            '[]'::jsonb
          )
        ),
        true
      ),
      COALESCE(
        bool_and(public.postil_activation_references_are_declared(
          activation, operation_record->'dependencies'
        )),
        true
      ),
      COALESCE(jsonb_agg(controller_record ORDER BY operation_ordinal), '[]'::jsonb),
      COALESCE(
        bool_and(
          (operation_source = 'cli' AND operation_ordinal <= generation_row.operation_count)
          OR (operation_source = 'service' AND kind = 'gateCheckCreate'
            AND operation_ordinal = generation_row.operation_count + 1)
          OR (operation_source = 'service' AND kind = 'gateCheckComplete'
            AND operation_ordinal = generation_row.operation_count + 2)
        ),
        true
      ),
      count(*) FILTER (
        WHERE operation_source = 'service' AND kind = 'gateCheckCreate'
      )::integer,
      count(*) FILTER (
        WHERE operation_source = 'service' AND kind = 'gateCheckComplete'
      )::integer
    INTO actual_operation_count, operations_pristine, ordinals_contiguous,
         dependencies_complete, activation_contract_valid, actual_controller_records, source_order_valid,
         gate_create_count, gate_complete_count
    FROM public.review_publication_operations operation
    WHERE repository_id = NEW.repository_id
      AND pr_number = NEW.pr_number
      AND publication_generation = NEW.publication_generation;
    actual_manifest_digest := postil_review_publication_operation_manifest_digest(
      NEW.repository_id,
      NEW.pr_number,
      NEW.publication_generation
    );
    SELECT
      count(*)::integer,
      COALESCE(jsonb_agg(operation_record ORDER BY operation_ordinal), '[]'::jsonb)
    INTO actual_cli_operation_count, actual_cli_operations
    FROM public.review_publication_operations
    WHERE repository_id = NEW.repository_id
      AND pr_number = NEW.pr_number
      AND publication_generation = NEW.publication_generation
      AND operation_source = 'cli';
    actual_cli_manifest_digest := postil_review_publication_cli_manifest_digest(
      NEW.repository_id,
      NEW.pr_number,
      NEW.publication_generation
    );
    SELECT EXISTS (
      SELECT 1
      FROM public.review_publication_operations gate_create
      JOIN public.review_publication_operations gate_complete
        ON gate_complete.repository_id = gate_create.repository_id
       AND gate_complete.pr_number = gate_create.pr_number
       AND gate_complete.publication_generation = gate_create.publication_generation
       AND gate_complete.operation_source = 'service'
       AND gate_complete.kind = 'gateCheckComplete'
      CROSS JOIN LATERAL (
        SELECT 'sha256:' || encode(sha256(convert_to(postil_canonical_json(jsonb_build_object(
          'conclusion', gate_complete.desired_payload->'payload'->'conclusion',
          'title', gate_complete.desired_payload->'payload'->'title',
          'summary', gate_complete.desired_payload->'payload'->'summary',
          'detailsUrl', gate_complete.desired_payload->'payload'->'detailsUrl'
        )), 'UTF8')), 'hex') AS gate_output_digest
      ) gate_output
      CROSS JOIN LATERAL (
        SELECT 'postil-gate-v1:' || postil_nul_join_sha256(
          'github-publication-controller-gate-external-id-v1',
          generation_row.accepted_plan->'repository'->>'id',
          generation_row.pr_number::text,
          generation_row.head_sha,
          generation_row.publication_generation::text,
          generation_row.accepted_plan->>'inputIdentity',
          generation_row.accepted_plan->>'reviewOutputDigest',
          gate_output.gate_output_digest
        ) AS external_id,
        'github-publication-controller-v1:gate-create:sha256:' || postil_nul_join_sha256(
          'github-publication-controller-gate-operation-v1',
          generation_row.accepted_plan->'repository'->>'id',
          generation_row.pr_number::text,
          generation_row.head_sha,
          generation_row.publication_generation::text,
          generation_row.accepted_plan->>'inputIdentity',
          generation_row.accepted_plan->>'reviewOutputDigest',
          'gate-create', gate_output.gate_output_digest
        ) AS create_key,
        'github-publication-controller-v1:gate-complete:sha256:' || postil_nul_join_sha256(
          'github-publication-controller-gate-operation-v1',
          generation_row.accepted_plan->'repository'->>'id',
          generation_row.pr_number::text,
          generation_row.head_sha,
          generation_row.publication_generation::text,
          generation_row.accepted_plan->>'inputIdentity',
          generation_row.accepted_plan->>'reviewOutputDigest',
          'gate-complete', gate_output.gate_output_digest
        ) AS complete_key
      ) expected
      WHERE gate_create.repository_id = NEW.repository_id
        AND gate_create.pr_number = NEW.pr_number
        AND gate_create.publication_generation = NEW.publication_generation
        AND gate_create.operation_source = 'service'
        AND gate_create.kind = 'gateCheckCreate'
        AND gate_create.operation_ordinal = generation_row.operation_count + 1
        AND gate_create.operation_key = expected.create_key
        AND gate_create.operation_record->'dependencies' = '[]'::jsonb
        AND gate_create.activation = '{"anyOf":[{"condition":"always"}]}'::jsonb
        AND gate_create.operation_record->'reconciliation' = jsonb_build_object(
          'logicalIdentity', expected.external_id, 'exclusive', true
        )
        AND gate_create.desired_payload = jsonb_build_object(
          'kind', 'gateCheckCreate',
          'payload', jsonb_build_object(
            'name', 'postil/gate', 'headSha', generation_row.head_sha,
            'status', 'in_progress', 'externalId', expected.external_id,
            'detailsUrl', gate_complete.desired_payload->'payload'->'detailsUrl'
          )
        )
        AND gate_complete.operation_ordinal = generation_row.operation_count + 2
        AND gate_complete.operation_key = expected.complete_key
        AND jsonb_array_length(gate_complete.operation_record->'dependencies') >= 1
        AND gate_complete.operation_record->'dependencies'->>0 = gate_create.operation_key
        AND gate_complete.activation = '{"anyOf":[{"condition":"allDependenciesTerminal"}]}'::jsonb
        AND gate_complete.operation_record->'reconciliation' = jsonb_build_object(
          'logicalIdentity', expected.external_id,
          'exclusive', true,
          'remoteId', jsonb_build_object('source', 'operation', 'operationKey', gate_create.operation_key)
        )
        AND gate_complete.desired_payload = jsonb_build_object(
          'kind', 'gateCheckComplete',
          'remoteId', jsonb_build_object('source', 'operation', 'operationKey', gate_create.operation_key),
          'payload', jsonb_build_object(
            'name', 'postil/gate', 'headSha', generation_row.head_sha,
            'status', 'completed',
            'conclusion', gate_complete.desired_payload->'payload'->'conclusion',
            'title', gate_complete.desired_payload->'payload'->'title',
            'summary', gate_complete.desired_payload->'payload'->'summary',
            'detailsUrl', gate_complete.desired_payload->'payload'->'detailsUrl'
          )
        )
    ) INTO gate_contract_valid;
    WITH RECURSIVE gate_roots(operation_key) AS (
      SELECT dependency.dependency_operation_key
      FROM public.review_publication_operation_dependencies dependency
      JOIN public.review_publication_operations gate_complete
        ON gate_complete.repository_id = dependency.repository_id
       AND gate_complete.pr_number = dependency.pr_number
       AND gate_complete.publication_generation = dependency.publication_generation
       AND gate_complete.operation_key = dependency.operation_key
      WHERE dependency.repository_id = NEW.repository_id
        AND dependency.pr_number = NEW.pr_number
        AND dependency.publication_generation = NEW.publication_generation
        AND gate_complete.kind = 'gateCheckComplete'
        AND dependency.dependency_position > 0
    ), reachable(operation_key) AS (
      SELECT operation_key FROM gate_roots
      UNION
      SELECT dependency.dependency_operation_key
      FROM public.review_publication_operation_dependencies dependency
      JOIN reachable ON reachable.operation_key = dependency.operation_key
      WHERE dependency.repository_id = NEW.repository_id
        AND dependency.pr_number = NEW.pr_number
        AND dependency.publication_generation = NEW.publication_generation
    )
    SELECT NOT EXISTS (
      SELECT 1
      FROM public.review_publication_operations cli_operation
      WHERE cli_operation.repository_id = NEW.repository_id
        AND cli_operation.pr_number = NEW.pr_number
        AND cli_operation.publication_generation = NEW.publication_generation
        AND cli_operation.operation_source = 'cli'
        AND NOT EXISTS (
          SELECT 1 FROM reachable WHERE reachable.operation_key = cli_operation.operation_key
        )
    ) INTO gate_completion_covers_cli;
    IF NOT operations_pristine THEN
      RAISE EXCEPTION 'pull request publication generation contains a non-pristine operation';
    END IF;
    IF NOT ordinals_contiguous THEN
      RAISE EXCEPTION 'pull request publication operation ordinals must be contiguous and one-based';
    END IF;
    IF NOT dependencies_complete THEN
      RAISE EXCEPTION 'pull request publication dependency edges do not match the accepted operations';
    END IF;
    IF NOT activation_contract_valid THEN
      RAISE EXCEPTION 'publication activation references must be declared dependency contracts';
    END IF;
    IF NOT source_order_valid OR gate_create_count <> 1 OR gate_complete_count <> 1
       OR NOT gate_contract_valid OR NOT gate_completion_covers_cli THEN
      RAISE EXCEPTION 'controller manifest requires ordered CLI operations and one gate create and complete operation';
    END IF;
    IF actual_cli_operations <> generation_row.accepted_plan->'operations'
       OR actual_cli_operation_count <> generation_row.operation_count
       OR actual_cli_manifest_digest <> generation_row.operation_manifest_digest THEN
      RAISE EXCEPTION 'stored CLI operations do not match the accepted CLI plan';
    END IF;
    IF actual_controller_records <> generation_row.controller_manifest->'operations'
       OR actual_operation_count <> generation_row.controller_operation_count
       OR actual_manifest_digest <> generation_row.controller_operation_manifest_digest THEN
      RAISE EXCEPTION 'stored publication operations do not match the controller manifest';
    END IF;
    UPDATE public.review_publication_generations
    SET sealed_at = clock_timestamp()
    WHERE id = generation_row.id;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "pull_request_publication_high_waters_guard_generation"
AFTER INSERT OR UPDATE OR DELETE ON "pull_request_publication_high_waters"
FOR EACH ROW EXECUTE FUNCTION "postil_guard_pull_request_publication_high_water"();
