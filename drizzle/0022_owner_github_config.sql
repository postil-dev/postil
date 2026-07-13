ALTER TABLE "org_settings"
  ADD COLUMN "shared_config_enabled" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "reviews"
  ADD COLUMN "config_provenance" jsonb;
--> statement-breakpoint
CREATE TABLE "org_config_snapshots" (
  "org_id" bigint PRIMARY KEY NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "source_repository_id" bigint REFERENCES "repositories"("id") ON DELETE set null,
  "source_github_repo_id" bigint NOT NULL,
  "source_full_name" text NOT NULL,
  "visibility" text NOT NULL,
  "default_branch" text NOT NULL,
  "commit_sha" text NOT NULL,
  "config_yaml" text,
  "guardrails_md" text,
  "content_policy_md" text,
  "files" text[] NOT NULL,
  "loaded_files" text[] DEFAULT '{}' NOT NULL,
  "stale" boolean DEFAULT false NOT NULL,
  "last_error" text,
  "fetched_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
