import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "@/lib/db/schema";
import { reconcileOrgMemberships } from "@/lib/org-sync";

/**
 * Login org-membership reconciliation against a real Postgres. The login flow
 * is the only writer of org_members, and it must both grant new memberships
 * and revoke ones the user has lost on GitHub. Set POSTIL_TEST_DATABASE_URL to
 * run; the suite is skipped otherwise.
 */

const TEST_URL = process.env.POSTIL_TEST_DATABASE_URL;
const describeDb = TEST_URL ? describe : describe.skip;

describeDb("org membership reconciliation", () => {
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_URL, max: 4 });
    db = drizzle(pool, { schema });
    const dir = join(import.meta.dir, "..", "drizzle");
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      const sqlText = await readFile(join(dir, file), "utf8");
      for (const statement of sqlText.split("--> statement-breakpoint")) {
        const trimmed = statement.trim();
        if (!trimmed) continue;
        try {
          await pool.query(trimmed);
        } catch (err) {
          const code = (err as { code?: string }).code;
          // 42P07 duplicate table, 42710 duplicate object (enum/index).
          if (code !== "42P07" && code !== "42710") throw err;
        }
      }
    }
  });

  beforeEach(async () => {
    await pool.query(
      "TRUNCATE org_members, org_settings, organizations, users RESTART IDENTITY CASCADE",
    );
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function makeUser(githubId: number, login: string): Promise<number> {
    const [row] = await db
      .insert(schema.users)
      .values({ githubId, login })
      .returning({ id: schema.users.id });
    return row!.id;
  }

  async function makeOrg(slug: string, githubOrgId: number): Promise<number> {
    const [row] = await db
      .insert(schema.organizations)
      .values({ slug, name: slug, githubOrgId })
      .returning({ id: schema.organizations.id });
    return row!.id;
  }

  async function memberOrgIds(userId: number): Promise<number[]> {
    const rows = await db
      .select({ orgId: schema.orgMembers.orgId })
      .from(schema.orgMembers)
      .where(eq(schema.orgMembers.userId, userId));
    return rows.map((r) => r.orgId).sort((a, b) => a - b);
  }

  test("revokes a stale membership and keeps a current one", async () => {
    const userId = await makeUser(1001, "alice");
    const acmeId = await makeOrg("acme", 9001); // still a member
    const leftId = await makeOrg("left-co", 9002); // user has left this one

    // Seed both memberships as if from a prior login.
    await db.insert(schema.orgMembers).values([
      { orgId: acmeId, userId, role: "member" },
      { orgId: leftId, userId, role: "member" },
    ]);

    // Current GitHub orgs no longer include left-co.
    await reconcileOrgMemberships(db, userId, [{ githubOrgId: 9001, role: "member" }]);

    expect(await memberOrgIds(userId)).toEqual([acmeId]);
  });

  test("does not touch other users' memberships", async () => {
    const alice = await makeUser(1001, "alice");
    const bob = await makeUser(1002, "bob");
    const acmeId = await makeOrg("acme", 9001);
    const otherId = await makeOrg("other", 9003);

    // Bob is a member of `other`; alice was too but has now left it.
    await db.insert(schema.orgMembers).values([
      { orgId: acmeId, userId: alice, role: "member" },
      { orgId: otherId, userId: alice, role: "member" },
      { orgId: otherId, userId: bob, role: "member" },
    ]);

    // Alice reconciles: she only belongs to acme now.
    await reconcileOrgMemberships(db, alice, [{ githubOrgId: 9001, role: "member" }]);

    expect(await memberOrgIds(alice)).toEqual([acmeId]);
    // Bob's membership in `other` is untouched.
    expect(await memberOrgIds(bob)).toEqual([otherId]);
  });

  test("grants a new membership and is idempotent on repeat", async () => {
    const userId = await makeUser(1001, "alice");
    const acmeId = await makeOrg("acme", 9001);

    // First login: no prior rows. Reconcile should insert the membership.
    await reconcileOrgMemberships(db, userId, [{ githubOrgId: 9001, role: "admin" }]);
    expect(await memberOrgIds(userId)).toEqual([acmeId]);

    const [first] = await db
      .select({ id: schema.orgMembers.id, role: schema.orgMembers.role })
      .from(schema.orgMembers)
      .where(and(eq(schema.orgMembers.userId, userId), eq(schema.orgMembers.orgId, acmeId)));

    // Second login with the same set: no duplicate row, no churn.
    await reconcileOrgMemberships(db, userId, [{ githubOrgId: 9001, role: "admin" }]);
    const rows = await db
      .select({ id: schema.orgMembers.id })
      .from(schema.orgMembers)
      .where(eq(schema.orgMembers.userId, userId));
    expect(rows.length).toBe(1);
    expect(rows[0]!.id).toBe(first!.id);
  });

  test("revokes all memberships when the user belongs to no known orgs", async () => {
    const userId = await makeUser(1001, "alice");
    const acmeId = await makeOrg("acme", 9001);
    await db.insert(schema.orgMembers).values({ orgId: acmeId, userId, role: "member" });

    // GitHub returns only orgs we don't know about (no organizations row).
    await reconcileOrgMemberships(db, userId, [{ githubOrgId: 8888, role: "member" }]);

    expect(await memberOrgIds(userId)).toEqual([]);
  });
});
