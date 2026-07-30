import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { createEphemeralDatabase, type EphemeralDatabase } from "./ephemeral-database";
import { closeDb, getDb, schema } from "@/lib/db";
import { findAccessibleInstallationOrgSlug } from "@/lib/github/installation-sync";

const TEST_URL = process.env.POSTIL_TEST_DATABASE_URL;
const describeDb = TEST_URL ? describe : describe.skip;

describeDb("GitHub setup destination", () => {
  let ephemeralDb: EphemeralDatabase;
  let db: ReturnType<typeof getDb>;

  beforeAll(async () => {
    ephemeralDb = await createEphemeralDatabase("github_setup_destination");
    // findAccessibleInstallationOrgSlug reaches the database through the
    // getDb() singleton, keyed off DATABASE_URL.
    process.env.DATABASE_URL = ephemeralDb.url;
    db = getDb();
  }, 30_000);

  beforeEach(async () => {
    await db.execute(
      "TRUNCATE installations, org_members, organizations, users RESTART IDENTITY CASCADE" as never,
    );
  });

  afterAll(async () => {
    // Release the getDb() singleton's connection before dropping the
    // database it points at, or the drop fails with "database is being
    // accessed by other users".
    await closeDb();
    await ephemeralDb?.drop();
  }, 30_000);

  test("resolves only installations accessible to the authenticated user", async () => {
    const [user, otherUser] = await db
      .insert(schema.users)
      .values([
        { githubId: 1001, login: "octocat" },
        { githubId: 1002, login: "other" },
      ])
      .returning({ id: schema.users.id });
    const [personal, inaccessible] = await db
      .insert(schema.organizations)
      .values([
        { githubOrgId: 1001, slug: "octocat", name: "octocat" },
        { githubOrgId: 2001, slug: "private-org", name: "Private org" },
      ])
      .returning({ id: schema.organizations.id });
    await db.insert(schema.installations).values([
      {
        githubInstallationId: 146332124,
        orgId: personal!.id,
        accountLogin: "octocat",
        accountType: "User",
      },
      {
        githubInstallationId: 146332125,
        orgId: inaccessible!.id,
        accountLogin: "private-org",
        accountType: "Organization",
      },
    ]);
    await db.insert(schema.orgMembers).values([
      { userId: user!.id, orgId: personal!.id, role: "admin" },
      { userId: otherUser!.id, orgId: inaccessible!.id, role: "admin" },
    ]);

    expect(
      await findAccessibleInstallationOrgSlug(user!.id, "146332124"),
    ).toBe("octocat");
    expect(
      await findAccessibleInstallationOrgSlug(user!.id, "146332125"),
    ).toBeUndefined();
    expect(
      await findAccessibleInstallationOrgSlug(user!.id, "9007199254740992"),
    ).toBeUndefined();
  });
});
