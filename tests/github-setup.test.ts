import { afterEach, describe, expect, test } from "bun:test";

const ORIGINAL_PUBLIC_URL = process.env.POSTIL_PUBLIC_URL;

const { GET } = await import("@/app/api/github/setup/route");

afterEach(() => {
  if (ORIGINAL_PUBLIC_URL === undefined) delete process.env.POSTIL_PUBLIC_URL;
  else process.env.POSTIL_PUBLIC_URL = ORIGINAL_PUBLIC_URL;
});

describe("GET /api/github/setup", () => {
  test("starts the protected login flow without trusting installation parameters", () => {
    process.env.POSTIL_PUBLIC_URL = "https://postil.dev";
    const request = new Request(
      "http://localhost:3000/api/github/setup?installation_id=999&setup_action=install&state=untrusted",
      {
        headers: {
          forwarded: "host=evil.example;proto=http",
          "x-forwarded-host": "evil.example",
          "x-forwarded-proto": "http",
        },
      },
    );

    const response = GET(request);

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://postil.dev/api/auth/login");
  });
});
