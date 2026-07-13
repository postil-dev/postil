import { afterEach, describe, expect, test } from "bun:test";

const ORIGINAL_PUBLIC_URL = process.env.POSTIL_PUBLIC_URL;
const { GET } = await import("@/app/api/github/setup/route");

afterEach(() => {
  if (ORIGINAL_PUBLIC_URL === undefined) delete process.env.POSTIL_PUBLIC_URL;
  else process.env.POSTIL_PUBLIC_URL = ORIGINAL_PUBLIC_URL;
});

describe("GET /api/github/setup", () => {
  test("starts user authorization without trusting the installation id", async () => {
    process.env.POSTIL_PUBLIC_URL = "https://postil.dev";

    for (const [installationId, setupAction] of [
      ["146332124", "install"],
      ["spoofed-by-a-caller", "update"],
    ]) {
      const response = await GET(
        new Request(
          `https://internal:3000/api/github/setup?installation_id=${installationId}&setup_action=${setupAction}`,
        ),
      );

      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("https://postil.dev/api/auth/login");
    }
  });

  test("returns incomplete callbacks to the install page", async () => {
    process.env.POSTIL_PUBLIC_URL = "https://postil.dev";

    const response = await GET(new Request("https://postil.dev/api/github/setup"));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://postil.dev/install?error=github_setup",
    );
  });
});
