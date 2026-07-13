import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("escalation email retirement migration", () => {
  test("quiesces old and newly inserted jobs without breaking old settings code", () => {
    const migration = readFileSync(
      join(import.meta.dir, "..", "drizzle", "0021_retire_escalation_email.sql"),
      "utf8",
    );

    expect(migration).toContain("SET LOCAL lock_timeout = '5s'");
    expect(migration).toContain('CREATE FUNCTION "stage_retired_escalation_email_job"');
    expect(migration).toContain('CREATE TRIGGER "jobs_stage_retired_escalation_email_trigger"');
    expect(migration).toContain('BEFORE INSERT OR UPDATE OF "kind", "status", "run_after"');
    expect(migration).toContain('AND NEW."status" = \'queued\'');
    expect(migration).toContain("'escalation-notification'");
    expect(migration).toContain("'escalation-email-verification'");
    expect(migration).toContain("'infinity'::timestamptz");
    expect(migration).not.toContain('UPDATE "org_settings"');
  });
});
