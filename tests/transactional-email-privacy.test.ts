import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("transactional email privacy disclosure", () => {
  test("documents Brevo processing, tracking, retention, and the application boundary", () => {
    const privacy = readFileSync("src/app/privacy/page.tsx", "utf8");
    const architecture = readFileSync("ARCHITECTURE.md", "utf8");
    const guidance = readFileSync("docs/brand-guidelines.md", "utf8");

    expect(privacy).toContain("can measure opens and link clicks");
    expect(privacy).toContain("anonymous tracking setting");
    expect(privacy).toContain("indefinitely by default");
    expect(privacy).toContain("billing, and service-monitor messages");
    expect(architecture).toContain("no per-message tracking");
    expect(architecture).toContain("Brevo's transactional email API");
    expect(guidance).toContain("Do not add images, web fonts");
    expect(guidance).toContain("Configure anonymous");
  });
});
