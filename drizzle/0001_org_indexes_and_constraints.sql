CREATE INDEX "installations_org_idx" ON "installations" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "org_members_user_idx" ON "org_members" USING btree ("user_id");--> statement-breakpoint
-- Deduplicate organizations by github_org_id before adding the unique index
-- below: the pre-fix check-then-insert race in findOrCreateOrg could already
-- have created more than one organization row for the same GitHub org, which
-- would make CREATE UNIQUE INDEX fail outright. Keep the oldest row (lowest
-- id) per github_org_id, repoint dependents to it so no installation or
-- membership is lost, then remove the duplicate rows.
DO $$
DECLARE
  dup RECORD;
BEGIN
  FOR dup IN
    SELECT github_org_id, MIN(id) AS keep_id
    FROM organizations
    WHERE github_org_id IS NOT NULL
    GROUP BY github_org_id
    HAVING COUNT(*) > 1
  LOOP
    UPDATE installations SET org_id = dup.keep_id
      WHERE org_id IN (
        SELECT id FROM organizations
        WHERE github_org_id = dup.github_org_id AND id <> dup.keep_id
      );
    -- org_members has a unique (org_id, user_id) index: move memberships that
    -- would not collide with one the kept org already has, then drop the rest
    -- (the kept org's row for that user already covers them).
    UPDATE org_members SET org_id = dup.keep_id
      WHERE org_id IN (
        SELECT id FROM organizations
        WHERE github_org_id = dup.github_org_id AND id <> dup.keep_id
      )
      AND user_id NOT IN (
        SELECT user_id FROM org_members WHERE org_id = dup.keep_id
      );
    DELETE FROM org_members
      WHERE org_id IN (
        SELECT id FROM organizations
        WHERE github_org_id = dup.github_org_id AND id <> dup.keep_id
      );
    DELETE FROM organizations
      WHERE github_org_id = dup.github_org_id AND id <> dup.keep_id;
  END LOOP;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_github_org_id_idx" ON "organizations" USING btree ("github_org_id");
