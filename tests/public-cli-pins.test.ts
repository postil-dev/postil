import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

import {
  PUBLIC_POSTIL_ACTION_SHA,
  PUBLIC_POSTIL_CLI_RELEASE,
  PUBLIC_POSTIL_CLI_SHA,
  PUBLIC_SELF_HOSTED_CLI_RELEASE,
} from "@/lib/public-cli-example";

const publicExampleFiles = [
  "src/app/docs/page.tsx",
  "src/app/docs/quickstart/page.tsx",
  "src/components/forge-install-tabs.tsx",
];

describe("public CLI pins", () => {
  test("uses immutable Action and CLI identities", () => {
    expect(PUBLIC_POSTIL_ACTION_SHA).toMatch(/^[0-9a-f]{40}$/);
    expect(PUBLIC_POSTIL_CLI_SHA).toMatch(/^[0-9a-f]{40}$/);
    expect(PUBLIC_POSTIL_CLI_RELEASE).toMatch(/^v\d+\.\d+\.\d+$/);
  });

  test("keeps obsolete example pins out of public documentation", () => {
    for (const path of publicExampleFiles) {
      const source = readFileSync(path, "utf8");
      expect(source).not.toContain("v0.2.1");
      expect(source).not.toContain("3f3c48b85019e9a0d7fbcde9cb0d63c186ca8401");
      expect(source).not.toContain("7451c6380dba0da92758f7ddcdf383d1501e57b2");
    }
  });

  test("keeps the self-hosted image label on the supported release", () => {
    const compose = readFileSync("docker-compose.yml", "utf8");
    const defaults = compose.match(/POSTIL_CLI_REV: \$\{POSTIL_CLI_REV:-([^}]+)\}/g) ?? [];

    expect(defaults).toHaveLength(2);
    for (const entry of defaults) {
      expect(entry).toContain(PUBLIC_SELF_HOSTED_CLI_RELEASE);
    }

    const vendorReadme = readFileSync("vendor/README.md", "utf8");
    expect(vendorReadme).toContain("required `POSTIL_CLI_TAG`");
    expect(vendorReadme).not.toContain("default `v0.2.0`");
  });
});
