import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("escalation email verification migration", () => {
  test("moves every legacy active address to normalized pending state", async () => {
    const migration = await readFile(
      join(import.meta.dir, "..", "drizzle", "0016_verify_escalation_email.sql"),
      "utf8",
    );
    expect(migration).toContain(
      '"escalation_email_pending" = lower(btrim("escalation_email"))',
    );
    expect(migration).toContain('"escalation_email" = NULL');
    expect(migration).toContain('"escalation_email_verified_at" = NULL');
    expect(migration).toContain(
      '"escalation_email_verification_token_ciphertext" bytea',
    );
    expect(migration).toContain(
      '"escalation_email_verification_sent_at" timestamp with time zone',
    );
    expect(migration).toContain('AND "escalation_email_pending" IS NULL');
  });
});
