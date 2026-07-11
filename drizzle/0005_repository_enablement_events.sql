CREATE TABLE "repository_enablement_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "repository_enablement_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"org_id" bigint NOT NULL,
	"repository_id" bigint,
	"github_repo_id" bigint NOT NULL,
	"repository_full_name" text NOT NULL,
	"repository_private" boolean NOT NULL,
	"action" text NOT NULL,
	"actor_user_id" bigint,
	"source" text DEFAULT 'dashboard' NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "repository_enablement_events" ADD CONSTRAINT "repository_enablement_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_enablement_events" ADD CONSTRAINT "repository_enablement_events_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_enablement_events" ADD CONSTRAINT "repository_enablement_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
INSERT INTO "repository_enablement_events" (
	"org_id",
	"repository_id",
	"github_repo_id",
	"repository_full_name",
	"repository_private",
	"action",
	"source",
	"occurred_at"
)
SELECT
	"installations"."org_id",
	"repositories"."id",
	"repositories"."github_repo_id",
	"repositories"."full_name",
	"repositories"."private",
	CASE WHEN "repositories"."enabled" THEN 'enable' ELSE 'disable' END,
	'migration_baseline',
	CASE WHEN "repositories"."enabled" THEN "repositories"."created_at" ELSE now() END
FROM "repositories"
INNER JOIN "installations" ON "installations"."id" = "repositories"."installation_id"
WHERE "installations"."org_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "repository_enablement_events_org_time_idx" ON "repository_enablement_events" USING btree ("org_id","occurred_at","id");--> statement-breakpoint
CREATE INDEX "repository_enablement_events_repo_time_idx" ON "repository_enablement_events" USING btree ("repository_id","occurred_at","id");
