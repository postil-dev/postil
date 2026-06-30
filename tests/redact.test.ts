import { afterEach, describe, expect, test } from "bun:test";

import { redactAndTruncate, redactSecrets } from "@/lib/redact";

const OLD_ENV = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in OLD_ENV)) delete process.env[key];
  }
  Object.assign(process.env, OLD_ENV);
});

describe("redactSecrets", () => {
  test("redacts explicit secret values before logs or persistence", () => {
    const token = "ghs_abcdefghijklmnopqrstuvwxyz123456";
    expect(redactSecrets(`cli failed with ${token}`, [token])).toBe(
      "cli failed with [redacted]",
    );
  });

  test("redacts secret-bearing environment values without printing them", () => {
    process.env.POSTIL_API_KEY = "sk-testabcdefghijklmnopqrstuvwxyz";
    expect(redactSecrets(`upstream rejected ${process.env.POSTIL_API_KEY}`)).toBe(
      "upstream rejected [redacted]",
    );
  });

  test("redacts common token and database-url shapes", () => {
    const message =
      "token github_pat_abcdefghijklmnopqrstuvwxyz_1234567890 db postgres://u:p@example.com/postil";
    expect(redactSecrets(message)).toBe(
      "token [redacted github token] db [redacted database url]",
    );
  });

  test("redacts before truncating so boundary-split secrets do not leak prefixes", () => {
    const secret = "sk-boundaryabcdefghijklmnopqrstuvwxyz1234567890";
    const message = `${"x".repeat(490)}${secret}`;
    const redacted = redactAndTruncate(message, 500, [secret]);
    expect(redacted).not.toContain("sk-boundary");
    expect(redacted).not.toContain(secret.slice(0, 10));
    expect(redacted).toContain("[redacted]");
  });
});
