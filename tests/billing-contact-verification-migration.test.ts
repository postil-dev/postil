import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("billing contact verification migration", () => {
  test("moves only unverified active contacts into the pending verification state", () => {
    const migration = readFileSync(
      new URL("../drizzle/0018_verify_billing_contact.sql", import.meta.url),
      "utf8",
    );
    expect(migration).toContain('SET\n  "billing_contact_pending" = lower(btrim("billing_contact_email"))');
    expect(migration).toContain('"billing_contact_email" = NULL');
    expect(migration).toContain('AND "billing_contact_verified_at" IS NULL');
    expect(migration).toContain('AND "billing_contact_pending" IS NULL');
    expect(migration).not.toContain('WHERE "billing_contact_verified_at" IS NOT NULL');
  });
});
