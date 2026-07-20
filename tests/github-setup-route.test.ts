import { afterEach, describe, expect, test } from "bun:test";

const ORIGINAL_PUBLIC_URL = process.env.POSTIL_PUBLIC_URL;
const { GET } = await import("@/app/api/github/setup/route");

afterEach(() => {
  if (ORIGINAL_PUBLIC_URL === undefined) delete process.env.POSTIL_PUBLIC_URL;
  else process.env.POSTIL_PUBLIC_URL = ORIGINAL_PUBLIC_URL;
});

describe("GET /api/github/setup", () => {
  test("starts user authorization and carries a bounded setup target", async () => {
    process.env.POSTIL_PUBLIC_URL = "https://postil.dev";

    const response = await GET(
      new Request(
        "https://internal:3000/api/github/setup?installation_id=146332124&setup_action=install",
      ),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://postil.dev/api/auth/login");
    expect(response.headers.get("set-cookie")).toContain(
      "postil_setup_installation=146332124",
    );
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("SameSite=lax");
  });

  test("reconciles installation updates through the same user authorization flow", async () => {
    process.env.POSTIL_PUBLIC_URL = "https://postil.dev";

    const response = await GET(
      new Request(
        "https://internal:3000/api/github/setup?installation_id=146332124&setup_action=update",
      ),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://postil.dev/api/auth/login");
  });

  test("returns incomplete callbacks to the install page", async () => {
    process.env.POSTIL_PUBLIC_URL = "https://postil.dev";

    const response = await GET(new Request("https://postil.dev/api/github/setup"));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://postil.dev/install?error=github_setup",
    );
  });

  test("rejects malformed and out-of-range installation ids", async () => {
    process.env.POSTIL_PUBLIC_URL = "https://postil.dev";

    for (const installationId of ["spoofed", "0", "9007199254740992"]) {
      const response = await GET(
        new Request(
          `https://postil.dev/api/github/setup?installation_id=${installationId}`,
        ),
      );
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(
        "https://postil.dev/install?error=github_setup",
      );
      expect(response.headers.get("set-cookie")).toBeNull();
    }
  });
});
