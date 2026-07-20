import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("organization notification preferences migration", () => {
  test("adds optional defaults without changing mandatory delivery", () => {
    const migration = readFileSync(
      new URL(
        "../drizzle/0039_organization_notification_preferences.sql",
        import.meta.url,
      ),
      "utf8",
    );

    expect(migration).toContain(
      'CREATE TABLE "organization_notification_preferences"',
    );
    expect(migration).toContain(
      '"billing_summary_email" boolean DEFAULT true NOT NULL',
    );
    expect(migration).toContain(
      '"service_summary_email" boolean DEFAULT true NOT NULL',
    );
    expect(migration).not.toMatch(/security|verification|payment_failure|trial_expiry|service_incident/);
    expect(migration).not.toMatch(/CREATE (?:UNIQUE )?INDEX/);
  });
});
