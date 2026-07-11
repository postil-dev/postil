import { afterEach, describe, expect, test } from "bun:test";

import { POST } from "@/app/api/auth/logout/route";

const ORIGINAL_PUBLIC_URL = process.env.POSTIL_PUBLIC_URL;
const ORIGINAL_SESSION_SECRET = process.env.POSTIL_SESSION_SECRET;

afterEach(() => {
  if (ORIGINAL_PUBLIC_URL === undefined) delete process.env.POSTIL_PUBLIC_URL;
  else process.env.POSTIL_PUBLIC_URL = ORIGINAL_PUBLIC_URL;

  if (ORIGINAL_SESSION_SECRET === undefined) delete process.env.POSTIL_SESSION_SECRET;
  else process.env.POSTIL_SESSION_SECRET = ORIGINAL_SESSION_SECRET;
});

describe("POST /api/auth/logout", () => {
  test("rejects cross-origin form posts", async () => {
    process.env.POSTIL_PUBLIC_URL = "https://postil.dev";

    const response = await POST(
      new Request("https://postil.dev/api/auth/logout", {
        method: "POST",
        headers: { origin: "https://evil.test" },
      }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
  });

  test("rejects form posts with missing origin header", async () => {
    process.env.POSTIL_PUBLIC_URL = "https://postil.dev";

    const response = await POST(
      new Request("https://postil.dev/api/auth/logout", {
        method: "POST",
        headers: {},
      }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
  });

  test("allows same-origin form posts and clears the session cookie", async () => {
    process.env.POSTIL_PUBLIC_URL = "https://postil.dev";
    process.env.POSTIL_SESSION_SECRET = "session-secret-for-logout-tests";

    const response = await POST(
      new Request("https://postil.dev/api/auth/logout", {
        method: "POST",
        headers: { origin: "https://postil.dev" },
      }),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://postil.dev/");
    expect(response.headers.get("set-cookie")).toContain("postil_session=");
  });
});
