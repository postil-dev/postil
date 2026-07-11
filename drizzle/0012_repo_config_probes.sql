CREATE TABLE "repo_config_probes" (
	"repository_id" bigint PRIMARY KEY NOT NULL,
	"probed_at" timestamp with time zone NOT NULL,
	"ok" boolean NOT NULL,
	"files" text[] NOT NULL,
	CONSTRAINT "repo_config_probes_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "org_config_probe_refreshes" (
	"org_id" bigint PRIMARY KEY NOT NULL,
	"refreshed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "org_config_probe_refreshes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action
);
