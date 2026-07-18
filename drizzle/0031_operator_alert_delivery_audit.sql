CREATE TABLE "operator_alert_deliveries" (
	"event_key" text PRIMARY KEY NOT NULL,
	"event" text NOT NULL,
	"org_id" bigint,
	"github_installation_id" bigint,
	"status" text DEFAULT 'queued' NOT NULL,
	"message_id" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_alert_deliveries_event_check" CHECK ("operator_alert_deliveries"."event" IN ('trial_started', 'trial_expired', 'installation_removed')),
	CONSTRAINT "operator_alert_deliveries_status_check" CHECK ("operator_alert_deliveries"."status" IN ('queued', 'retrying', 'delivered', 'failed')),
	CONSTRAINT "operator_alert_deliveries_event_key_nonempty" CHECK (length(btrim("operator_alert_deliveries"."event_key")) > 0)
);
--> statement-breakpoint
ALTER TABLE "operator_alert_deliveries" ADD CONSTRAINT "operator_alert_deliveries_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "operator_alert_deliveries_status_created_idx" ON "operator_alert_deliveries" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "operator_alert_deliveries_org_created_idx" ON "operator_alert_deliveries" USING btree ("org_id","created_at");--> statement-breakpoint
UPDATE jobs
SET payload = payload || jsonb_build_object(
  'eventKey', 'trial-started:' || (payload ->> 'githubOwnerId')
)
WHERE kind = 'operator-alert'
  AND payload ->> 'event' = 'trial_started'
  AND NULLIF(payload ->> 'eventKey', '') IS NULL
  AND payload ->> 'githubOwnerId' ~ '^[1-9][0-9]*$';--> statement-breakpoint
INSERT INTO operator_alert_deliveries
  (event_key, event, org_id, github_installation_id, status, last_error,
   created_at, last_attempt_at, delivered_at, updated_at)
SELECT
  jobs.payload ->> 'eventKey',
  jobs.payload ->> 'event',
  organization.id,
  CASE WHEN jobs.payload ->> 'githubInstallationId' ~ '^[1-9][0-9]*$'
    THEN (jobs.payload ->> 'githubInstallationId')::bigint END,
  CASE jobs.status
    WHEN 'done' THEN 'delivered'
    WHEN 'failed' THEN 'failed'
    WHEN 'running' THEN 'retrying'
    ELSE 'queued'
  END,
  CASE WHEN jobs.status = 'failed' THEN jobs.last_error END,
  jobs.created_at,
  CASE WHEN jobs.status IN ('done', 'failed') THEN jobs.created_at END,
  CASE WHEN jobs.status = 'done' THEN jobs.created_at END,
  jobs.created_at
FROM jobs
LEFT JOIN organizations AS organization
  ON organization.id = CASE WHEN jobs.payload ->> 'orgId' ~ '^[1-9][0-9]*$'
    THEN (jobs.payload ->> 'orgId')::bigint END
WHERE kind = 'operator-alert'
  AND jobs.payload ->> 'event' IN ('trial_started', 'trial_expired', 'installation_removed')
  AND NULLIF(jobs.payload ->> 'eventKey', '') IS NOT NULL
ON CONFLICT (event_key) DO NOTHING;
