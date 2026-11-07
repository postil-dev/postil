CREATE SEQUENCE job_attempt_receipt_ids AS bigint START 1 INCREMENT 1 CACHE 1 NO CYCLE;
--> statement-breakpoint
CREATE TABLE "job_attempt_receipts" (
	"receipt_id" bigint PRIMARY KEY NOT NULL,
	"predecessor_id" bigint,
	"source_epoch" uuid,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"claim_receipt_id" bigint,
	"claim_kind" text DEFAULT 'claim' NOT NULL,
	"binding_receipt_id" bigint,
	"binding_kind" text DEFAULT 'review_bound' NOT NULL,
	"job_id" bigint,
	"ordinal" integer,
	"job_kind" text,
	"review_id" bigint,
	"review_public_id" uuid,
	"event_kind" text NOT NULL,
	"outcome" text,
	"phase" text,
	"category" text,
	"recovered" boolean,
	"recovery" text,
	"occurred_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "job_attempt_receipts_predecessor_id_unique" UNIQUE("predecessor_id"),
	CONSTRAINT "job_attempt_receipts_receipt_id_job_id_ordinal_job_kind_event_kind_unique" UNIQUE("receipt_id","job_id","ordinal","job_kind","event_kind"),
	CONSTRAINT "job_attempt_receipts_receipt_id_claim_receipt_id_job_id_review_id_review_public_id_event_kind_unique" UNIQUE("receipt_id","claim_receipt_id","job_id","review_id","review_public_id","event_kind"),
	CONSTRAINT "job_attempt_receipt_check_1" CHECK (schema_version = 1),
	CONSTRAINT "job_attempt_receipt_check_2" CHECK (claim_kind = 'claim'),
	CONSTRAINT "job_attempt_receipt_check_3" CHECK (binding_kind = 'review_bound'),
	CONSTRAINT "job_attempt_receipt_check_4" CHECK (job_kind IN ('review','review-feedback')),
	CONSTRAINT "job_attempt_receipt_check_5" CHECK (event_kind IN ('genesis','claim','review_bound','review_observed','incident','queue_closed')),
	CONSTRAINT "job_attempt_receipt_check_6" CHECK (phase IN ('planner','review','scorer','respond')),
	CONSTRAINT "job_attempt_receipt_check_7" CHECK (category IN ('providerError','invalidOutput','timeout','deadline')),
	CONSTRAINT "job_attempt_receipt_check_8" CHECK (recovery IN ('repair','fallback')),
	CONSTRAINT "job_attempt_receipt_check_9" CHECK (isfinite(occurred_at)),
	CONSTRAINT "job_attempt_receipt_check_10" CHECK (
    (event_kind = 'genesis' AND receipt_id = 0 AND source_epoch IS NOT NULL
      AND predecessor_id IS NULL AND claim_receipt_id IS NULL AND binding_receipt_id IS NULL
      AND job_id IS NULL AND ordinal IS NULL AND job_kind IS NULL AND review_id IS NULL
      AND review_public_id IS NULL AND outcome IS NULL AND phase IS NULL AND category IS NULL
      AND recovered IS NULL AND recovery IS NULL)
    OR
    (event_kind <> 'genesis' AND receipt_id > 0 AND source_epoch IS NULL
      AND predecessor_id IS NOT NULL AND predecessor_id < receipt_id
      AND claim_receipt_id IS NOT NULL AND claim_receipt_id <= receipt_id
      AND job_id IS NOT NULL AND job_id > 0 AND ordinal IS NOT NULL AND ordinal > 0
      AND job_kind IS NOT NULL AND outcome IS NOT NULL)
  ),
	CONSTRAINT "job_attempt_receipt_check_11" CHECK ((review_id IS NULL) = (review_public_id IS NULL)),
	CONSTRAINT "job_attempt_receipt_check_12" CHECK (review_id IS NULL OR review_id > 0),
	CONSTRAINT "job_attempt_receipt_check_13" CHECK (
    (event_kind = 'genesis') OR
    (event_kind = 'claim' AND claim_receipt_id = receipt_id AND review_id IS NULL AND outcome = 'started') OR
    (event_kind = 'review_bound' AND review_id IS NOT NULL AND outcome = 'bound') OR
    (event_kind = 'review_observed' AND review_id IS NOT NULL AND outcome IN ('staged','completed','failed','interrupted','cancelled')) OR
    (event_kind = 'incident' AND review_id IS NOT NULL AND outcome = 'observed') OR
    (event_kind = 'queue_closed' AND review_id IS NULL AND outcome IN ('succeeded','retry','failed','continued','interrupted','cancelled','coalesced','deferred'))
  ),
	CONSTRAINT "job_attempt_receipt_check_14" CHECK ((binding_receipt_id IS NOT NULL) = (event_kind IN ('review_observed','incident'))),
	CONSTRAINT "job_attempt_receipt_check_15" CHECK (
    (event_kind = 'incident' AND phase IS NOT NULL AND category IS NOT NULL AND recovered IS NOT NULL
      AND recovered = (recovery IS NOT NULL))
    OR (event_kind <> 'incident' AND phase IS NULL AND category IS NULL AND recovered IS NULL AND recovery IS NULL)
  )
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "active_claim_receipt_id" bigint;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "staged_review_id" bigint;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "origin_claim_receipt_id" bigint;--> statement-breakpoint
ALTER TABLE "job_attempt_receipts" ADD CONSTRAINT "job_attempt_receipts_predecessor_id_job_attempt_receipts_receipt_id_fk" FOREIGN KEY ("predecessor_id") REFERENCES "public"."job_attempt_receipts"("receipt_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_attempt_receipts" ADD CONSTRAINT "job_attempt_receipts_claim_receipt_id_job_id_ordinal_job_kind_claim_kind_job_attempt_receipts_receipt_id_job_id_ordinal_job_kind_event_kind_fk" FOREIGN KEY ("claim_receipt_id","job_id","ordinal","job_kind","claim_kind") REFERENCES "public"."job_attempt_receipts"("receipt_id","job_id","ordinal","job_kind","event_kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_attempt_receipts" ADD CONSTRAINT "job_attempt_receipts_binding_receipt_id_claim_receipt_id_job_id_review_id_review_public_id_binding_kind_job_attempt_receipts_receipt_id_claim_receipt_id_job_id_review_id_review_public_id_event_kind_fk" FOREIGN KEY ("binding_receipt_id","claim_receipt_id","job_id","review_id","review_public_id","binding_kind") REFERENCES "public"."job_attempt_receipts"("receipt_id","claim_receipt_id","job_id","review_id","review_public_id","event_kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "job_attempt_one_closure" ON "job_attempt_receipts" USING btree ("claim_receipt_id") WHERE "job_attempt_receipts"."event_kind" = 'queue_closed';--> statement-breakpoint
CREATE UNIQUE INDEX "job_attempt_one_binding" ON "job_attempt_receipts" USING btree ("claim_receipt_id","review_id") WHERE "job_attempt_receipts"."event_kind" = 'review_bound';--> statement-breakpoint
CREATE UNIQUE INDEX "job_attempt_one_observation" ON "job_attempt_receipts" USING btree ("claim_receipt_id","review_id","outcome") WHERE "job_attempt_receipts"."event_kind" = 'review_observed';--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_active_claim_receipt_id_job_attempt_receipts_receipt_id_fk" FOREIGN KEY ("active_claim_receipt_id") REFERENCES "public"."job_attempt_receipts"("receipt_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_origin_claim_receipt_id_job_attempt_receipts_receipt_id_fk" FOREIGN KEY ("origin_claim_receipt_id") REFERENCES "public"."job_attempt_receipts"("receipt_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
INSERT INTO job_attempt_receipts(receipt_id,source_epoch,event_kind) VALUES (0,gen_random_uuid(),'genesis');

CREATE FUNCTION reject_receipt_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'immutable receipt'; END $$;
CREATE TRIGGER job_attempt_receipts_immutable BEFORE UPDATE OR DELETE ON job_attempt_receipts
FOR EACH ROW EXECUTE FUNCTION reject_receipt_mutation();
CREATE TRIGGER job_attempt_receipts_no_truncate BEFORE TRUNCATE ON job_attempt_receipts
FOR EACH STATEMENT EXECUTE FUNCTION reject_receipt_mutation();

CREATE FUNCTION validate_receipt_append() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_head bigint; origin_job bigint;
BEGIN
  IF NEW.event_kind = 'genesis' OR current_setting('transaction_isolation') <> 'read committed'
    OR NOT EXISTS (SELECT 1 FROM pg_locks WHERE pid = pg_backend_pid() AND locktype = 'advisory'
      AND classid = 17491 AND objid = 1 AND objsubid = 2 AND granted)
    OR NOT EXISTS (SELECT 1 FROM pg_sequence WHERE seqrelid = 'job_attempt_receipt_ids'::regclass
      AND seqcache = 1 AND NOT seqcycle AND seqincrement = 1)
  THEN RAISE EXCEPTION 'invalid receipt append'; END IF;
  SELECT receipt_id INTO current_head FROM job_attempt_receipts ORDER BY receipt_id DESC LIMIT 1;
  IF NEW.predecessor_id IS DISTINCT FROM current_head THEN RAISE EXCEPTION 'invalid receipt predecessor'; END IF;
  IF NEW.event_kind = 'claim' AND NOT EXISTS (
    SELECT 1 FROM jobs WHERE id = NEW.job_id AND kind = NEW.job_kind
      AND status = 'running' AND attempts = NEW.ordinal AND active_claim_receipt_id IS NULL
  ) THEN RAISE EXCEPTION 'invalid receipt claim'; END IF;
  IF NEW.event_kind = 'review_bound' THEN
    SELECT c.job_id INTO origin_job FROM reviews r JOIN job_attempt_receipts c
      ON c.receipt_id = r.origin_claim_receipt_id AND c.event_kind = 'claim'
      WHERE r.id = NEW.review_id AND r.public_id = NEW.review_public_id;
    IF origin_job IS DISTINCT FROM NEW.job_id OR NOT EXISTS (
      SELECT 1 FROM reviews r JOIN jobs j ON j.id = NEW.job_id
      WHERE r.id = NEW.review_id AND r.public_id = NEW.review_public_id
        AND (r.origin_claim_receipt_id = NEW.claim_receipt_id OR j.staged_review_id = r.id)
    ) THEN RAISE EXCEPTION 'invalid review binding'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER job_attempt_receipts_append BEFORE INSERT ON job_attempt_receipts
FOR EACH ROW EXECUTE FUNCTION validate_receipt_append();

CREATE FUNCTION validate_job_receipt_pointers() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.active_claim_receipt_id IS NOT NULL AND NEW.active_claim_receipt_id IS DISTINCT FROM OLD.active_claim_receipt_id AND NOT EXISTS (
    SELECT 1 FROM job_attempt_receipts c WHERE c.receipt_id = NEW.active_claim_receipt_id
      AND c.event_kind = 'claim' AND c.job_id = NEW.id AND c.job_kind = NEW.kind
      AND c.ordinal = NEW.attempts AND NEW.status = 'running'
  ) THEN RAISE EXCEPTION 'invalid active claim'; END IF;
  IF NEW.staged_review_id IS NOT NULL AND NEW.staged_review_id IS DISTINCT FROM OLD.staged_review_id AND NOT EXISTS (
    SELECT 1 FROM reviews r JOIN job_attempt_receipts b ON b.review_id = r.id
      AND b.review_public_id = r.public_id AND b.event_kind = 'review_bound'
    WHERE r.id = NEW.staged_review_id AND b.job_id = NEW.id AND b.claim_receipt_id = NEW.active_claim_receipt_id
  ) THEN RAISE EXCEPTION 'invalid staged review'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jobs_receipt_pointers BEFORE UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION validate_job_receipt_pointers();

CREATE FUNCTION validate_review_origin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.origin_claim_receipt_id IS DISTINCT FROM OLD.origin_claim_receipt_id THEN
    RAISE EXCEPTION 'immutable review origin';
  END IF;
  IF NEW.origin_claim_receipt_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM job_attempt_receipts c WHERE c.receipt_id = NEW.origin_claim_receipt_id AND c.event_kind = 'claim'
  ) THEN RAISE EXCEPTION 'invalid review origin'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reviews_receipt_origin BEFORE INSERT OR UPDATE ON reviews
FOR EACH ROW EXECUTE FUNCTION validate_review_origin();
--> statement-breakpoint
