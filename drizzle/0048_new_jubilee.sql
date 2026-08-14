SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "membership_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "membership_refresh_generation" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "membership_refresh_lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "membership_refresh_retry_after" timestamp with time zone;--> statement-breakpoint
CREATE FUNCTION "postil_guard_org_member_generation"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  "affected_user_ids" bigint[];
  "affected_user_id" bigint;
  "committed_generation" bigint;
BEGIN
  IF current_setting('postil.membership_writer', true) = 'generation-fenced' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    "affected_user_ids" := ARRAY[NEW."user_id"];
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW."user_id" IS NOT DISTINCT FROM OLD."user_id" THEN
      "affected_user_ids" := ARRAY[OLD."user_id"];
    ELSE
      "affected_user_ids" := ARRAY[
        LEAST(OLD."user_id", NEW."user_id"),
        GREATEST(OLD."user_id", NEW."user_id")
      ];
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    "affected_user_ids" := ARRAY[OLD."user_id"];
  ELSE
    RAISE EXCEPTION 'unsupported org_members trigger operation: %', TG_OP;
  END IF;

  -- Generation claims update the same users rows. Holding these share locks
  -- through commit makes the generation check authoritative for the complete
  -- legacy write. Multiple rows are always locked in ascending user-id order.
  FOR "affected_user_id", "committed_generation" IN
    SELECT "id", "membership_refresh_generation"
      FROM "users"
     WHERE "id" = ANY("affected_user_ids")
     ORDER BY "id"
       FOR SHARE
  LOOP
    IF COALESCE("committed_generation", 0) > 0 THEN
      RAISE EXCEPTION 'legacy membership write rejected for generation-fenced user'
        USING ERRCODE = '55000';
    END IF;
  END LOOP;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "org_members_guard_membership_generation"
BEFORE INSERT OR UPDATE OR DELETE ON "org_members"
FOR EACH ROW EXECUTE FUNCTION "postil_guard_org_member_generation"();
--> statement-breakpoint
CREATE FUNCTION "postil_guard_legacy_session_membership_freshness"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  "committed_generation" bigint;
BEGIN
  IF NEW."membership_checked_at" IS NULL
     OR current_setting('postil.membership_writer', true) = 'generation-fenced' THEN
    RETURN NEW;
  END IF;

  SELECT "membership_refresh_generation"
    INTO "committed_generation"
    FROM "users"
   WHERE "id" = NEW."user_id"
     FOR SHARE;
  IF COALESCE("committed_generation", 0) > 0 THEN
    NEW."membership_checked_at" := NULL;
    NEW."membership_check_available_at" := NULL;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "sessions_guard_legacy_membership_freshness"
BEFORE INSERT OR UPDATE ON "sessions"
FOR EACH ROW EXECUTE FUNCTION "postil_guard_legacy_session_membership_freshness"();
