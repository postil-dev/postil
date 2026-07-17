CREATE TABLE "release_steps" (
	"name" text PRIMARY KEY NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	"details" jsonb NOT NULL
);
