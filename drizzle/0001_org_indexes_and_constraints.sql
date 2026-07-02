CREATE INDEX "installations_org_idx" ON "installations" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "org_members_user_idx" ON "org_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_github_org_id_idx" ON "organizations" USING btree ("github_org_id");