import { describe, expect, test } from "bun:test";

import { signSessionToken, verifySessionToken } from "@/lib/session-token";

const SECRET = "session-secret-for-tests";

describe("session token", () => {
  test("round-trips a session id", async () => {
    const token = await signSessionToken("session-abc-123", SECRET);
    expect(await verifySessionToken(token, SECRET)).toBe("session-abc-123");
  });

  test("rejects a tampered session id", async () => {
    const token = await signSessionToken("session-abc-123", SECRET);
    const dot = token.lastIndexOf(".");
    const forged = `session-xyz-999${token.slice(dot)}`;
    expect(await verifySessionToken(forged, SECRET)).toBeNull();
  });

  test("rejects the wrong secret, missing token, and garbage", async () => {
    const token = await signSessionToken("session-abc-123", SECRET);
    expect(await verifySessionToken(token, "other-secret")).toBeNull();
    expect(await verifySessionToken(undefined, SECRET)).toBeNull();
    expect(await verifySessionToken("no-dot-here", SECRET)).toBeNull();
    expect(await verifySessionToken(".only-mac", SECRET)).toBeNull();
    expect(await verifySessionToken("id.!!!not-base64!!!", SECRET)).toBeNull();
  });
});
