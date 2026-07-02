import { afterEach, describe, expect, test } from "bun:test";

/**
 * A malformed DATABASE_URL must never leak the connection string (credentials
 * included) into the thrown error or platform logs. pg defers parsing the URL
 * to first connect, so getDb() parses it eagerly and routes any construction
 * error through the redaction helper. This test proves the URL and its
 * embedded password do not survive into the thrown message.
 */

const OLD_ENV = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in OLD_ENV)) delete process.env[key];
  }
  Object.assign(process.env, OLD_ENV);
});

describe("getDb with a malformed DATABASE_URL", () => {
  test("throws without leaking the connection string or its credentials", async () => {
    const secret = "SUPERSECRETpassword123456";
    // Percent-triples the parser cannot decode: pg-connection-string throws and
    // echoes the offending URL (with the password) verbatim in its message.
    const malformed = `http://user:${secret}@%%%host/db`;
    process.env.DATABASE_URL = malformed;

    // Fresh module instance so the lazy singleton reconstructs against this env.
    const { getDb } = await import(`@/lib/db?malformed-${Date.now()}`);

    let thrown: unknown;
    try {
      getDb();
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    // The security property: neither the password nor the URL survive.
    expect(message).not.toContain(secret);
    expect(message).not.toContain(malformed);
    expect(message).not.toContain("%%%host");
    // Our wrapper is the one that produced the (redacted) message.
    expect(message).toContain("failed to construct database pool from DATABASE_URL");
  });

  test("redacts a connection string that a parser error echoes verbatim", () => {
    // Guard against a pg-connection-string version that does NOT self-sanitize:
    // simulate its historical behavior of echoing the raw URL, and prove our
    // redaction (connectionString passed as an extra value) strips it.
    const secret = "SUPERSECRETpassword123456";
    const malformed = `http://user:${secret}@%%%host/db`;
    const parserError = new Error(`"${malformed}" cannot be parsed as a URL.`);
    const { redactSecrets } = require("@/lib/redact");
    const redacted = redactSecrets(parserError, [malformed]);
    expect(redacted).not.toContain(secret);
    expect(redacted).not.toContain(malformed);
    expect(redacted).toContain("[redacted]");
  });
});
