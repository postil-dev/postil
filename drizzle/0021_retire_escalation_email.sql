SET LOCAL lock_timeout = '5s';

-- Quiesce delivery before the old fleet is replaced. New jobs and retries
-- from an old process remain durable for audit but cannot become runnable.
CREATE FUNCTION "stage_retired_escalation_email_job"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."kind" IN ('escalation-notification', 'escalation-email-verification')
     AND NEW."status" = 'queued' THEN
    NEW."run_after" := 'infinity'::timestamptz;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "jobs_stage_retired_escalation_email_trigger"
  BEFORE INSERT OR UPDATE OF "kind", "status", "run_after" ON "jobs"
  FOR EACH ROW EXECUTE FUNCTION "stage_retired_escalation_email_job"();

UPDATE "jobs"
SET "run_after" = 'infinity'::timestamptz
WHERE "kind" IN ('escalation-notification', 'escalation-email-verification')
  AND "status" = 'queued';
