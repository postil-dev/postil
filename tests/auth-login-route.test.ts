import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const ORIGINAL_CLIENT_ID = process.env.GITHUB_OAUTH_CLIENT_ID;

const { GET } = await import("@/app/api/auth/login/route");

beforeEach(() => {
  process.env.GITHUB_OAUTH_CLIENT_ID = "github-client-id";
});

afterEach(() => {
  if (ORIGINAL_CLIENT_ID === undefined) delete process.env.GITHUB_OAUTH_CLIENT_ID;
  else process.env.GITHUB_OAUTH_CLIENT_ID = ORIGINAL_CLIENT_ID;
});

describe("GET /api/auth/login", () => {
  test("binds a safe return target to the OAuth attempt", async () => {
    const response = await GET(
      new Request(
        "http://localhost:3000/api/auth/login?next=%2Forgs%2Fexample-org%2Fruns%2F11111111-2222-4333-8444-555555555555%3Ftab%3Dfindings",
      ),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toStartWith(
      "https://github.com/login/oauth/authorize?",
    );
    expect(response.headers.get("set-cookie")).toContain(
      "postil_oauth_return_to=%2Forgs%2Fexample-org%2Fruns%2F11111111-2222-4333-8444-555555555555%3Ftab%3Dfindings",
    );
  });

  test("clears a prior return target when the requested target is unsafe", async () => {
    const response = await GET(
      new Request(
        "http://localhost:3000/api/auth/login?next=https%3A%2F%2Fevil.example%2Faccount",
      ),
    );

    expect(response.headers.get("set-cookie")).toContain(
      "postil_oauth_return_to=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    );
  });
});
