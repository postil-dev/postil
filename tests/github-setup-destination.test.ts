import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { getDb, schema } from "@/lib/db";
import { findAccessibleInstallationOrgSlug } from "@/lib/github/installation-sync";

const TEST_URL = process.env.POSTIL_TEST_DATABASE_URL;
const describeDb = TEST_URL ? describe : describe.skip;
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

describeDb("GitHub setup destination", () => {
  let db: ReturnType<typeof getDb>;

  beforeAll(() => {
    process.env.DATABASE_URL = TEST_URL;
    db = getDb();
  });

  beforeEach(async () => {
    await db.execute(
      "TRUNCATE installations, org_members, organizations, users RESTART IDENTITY CASCADE" as never,
    );
  });

  afterAll(() => {
    if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  });

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
