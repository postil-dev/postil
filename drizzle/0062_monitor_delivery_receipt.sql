ALTER TABLE "private_monitor_incidents" ADD COLUMN "last_notification_key" text;--> statement-breakpoint
ALTER TABLE "private_monitor_incidents" ADD COLUMN "last_delivery_receipt" jsonb;
--> statement-breakpoint
ALTER TABLE "private_monitor_incidents" ADD CONSTRAINT "private_monitor_delivery_receipt_bound" CHECK (("last_delivery_receipt" IS NULL AND "last_notification_key" IS NULL) OR ("last_delivery_receipt" IS NOT NULL AND "last_notification_key" IS NOT NULL AND length("last_notification_key") BETWEEN 1 AND 512 AND jsonb_typeof("last_delivery_receipt") = 'object' AND octet_length("last_delivery_receipt"::text) <= 2048));
--> statement-breakpoint
CREATE FUNCTION clear_private_monitor_delivery_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.last_notified_at IS DISTINCT FROM OLD.last_notified_at
     OR (OLD.pending_notification_key IS NOT NULL AND NEW.pending_notification_key IS NULL) THEN
    NEW.last_notification_key := NULL;
    NEW.last_delivery_receipt := NULL;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER clear_private_monitor_delivery_receipt
BEFORE UPDATE OF last_notified_at, pending_notification_key ON private_monitor_incidents
FOR EACH ROW EXECUTE FUNCTION clear_private_monitor_delivery_receipt();
