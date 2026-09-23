SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "review_feedback_control" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"mode" text DEFAULT 'disabled' NOT NULL,
	CONSTRAINT "review_feedback_control_singleton" CHECK ("review_feedback_control"."id" = 1),
	CONSTRAINT "review_feedback_control_mode" CHECK ("review_feedback_control"."mode" IN ('inherit', 'enabled', 'disabled'))
);--> statement-breakpoint
INSERT INTO "review_feedback_control" ("id", "mode") VALUES (1, 'disabled');
