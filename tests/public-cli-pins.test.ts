import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

import release from "@/data/public-cli-release.json";
import {
  PUBLIC_POSTIL_ACTION_SHA,
  PUBLIC_POSTIL_CLI_RELEASE,
  PUBLIC_POSTIL_CLI_SHA,
  PUBLIC_SELF_HOSTED_CLI_RELEASE,
} from "@/lib/public-cli-example";
import {
  assertPublicCliPins,
  parseReleaseChecksum,
  parsePublicCliPins,
} from "../scripts/verify-public-cli-version";

const publicExampleFiles = [
  "src/app/docs/page.tsx",
  "src/app/docs/quickstart/page.tsx",
  "src/components/forge-install-tabs.tsx",
];

describe("public CLI pins", () => {
  test("derives public constants from the release authority", () => {
    expect(PUBLIC_POSTIL_ACTION_SHA).toMatch(/^[0-9a-f]{40}$/);
    expect(PUBLIC_POSTIL_CLI_SHA).toMatch(/^[0-9a-f]{40}$/);
    expect(PUBLIC_POSTIL_CLI_RELEASE).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(PUBLIC_POSTIL_ACTION_SHA).toBe(release.actionCommit);
    expect(PUBLIC_POSTIL_CLI_SHA).toBe(release.cliCommit);
    expect(PUBLIC_POSTIL_CLI_RELEASE).toBe(release.cliRelease);
    expect(PUBLIC_SELF_HOSTED_CLI_RELEASE).toBe(release.hostedCliRelease);
  });

  test("parses and validates a complete consumer pin set", () => {
    const fixture = `
- uses: postil-dev/postil-action@${release.actionCommit}
  with:
    cli-ref: ${release.cliCommit}
    cli-release: ${release.cliRelease}
`;

    const pins = parsePublicCliPins(fixture, "fixture");
    expect(pins).toEqual({
      actionCommit: release.actionCommit,
      cliCommit: release.cliCommit,
      cliRelease: release.cliRelease,
    });
    expect(() => assertPublicCliPins(pins, "fixture")).not.toThrow();
    expect(() =>
      assertPublicCliPins(
        { ...pins, actionCommit: "f".repeat(40) },
        "consumer fixture",
        { requireCanonicalAction: false },
      ),
    ).not.toThrow();
    expect(() =>
      assertPublicCliPins({ ...pins, cliRelease: "v99.0.0" }, "fixture"),
    ).toThrow(`expected ${release.cliRelease}`);
    expect(() =>
      parsePublicCliPins("uses: postil-dev/postil-action@main", "fixture"),
    ).toThrow("exactly one complete Postil pin set");
    expect(() =>
      parsePublicCliPins(`${fixture}\n${fixture}`, "fixture"),
    ).toThrow("exactly one complete Postil pin set");
  });

  test("pins the deployed Linux artifact digest", () => {
    expect(release.hostedCliCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(release.hostedCliRelease).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(release.hostedCliLinuxX86_64Sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(
      parseReleaseChecksum(
        `${release.hostedCliLinuxX86_64Sha256}  postil-x86_64-unknown-linux-gnu.tar.gz\n`,
        "fixture",
      ),
    ).toBe(release.hostedCliLinuxX86_64Sha256);
    expect(() =>
      parseReleaseChecksum(
        `${release.hostedCliLinuxX86_64Sha256}  another-file.tar.gz\n`,
        "fixture",
      ),
    ).toThrow("invalid release checksum");
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
    const defaults =
      compose.match(/POSTIL_CLI_REV: \$\{POSTIL_CLI_REV:-([^}]+)\}/g) ?? [];

    expect(defaults).toHaveLength(2);
    for (const entry of defaults) {
      expect(entry).toContain(PUBLIC_SELF_HOSTED_CLI_RELEASE);
    }

    const vendorReadme = readFileSync("vendor/README.md", "utf8");
    expect(vendorReadme).toContain("required `POSTIL_CLI_TAG`");
    expect(vendorReadme).not.toContain("default `v0.2.0`");
  });

  test("makes deployment reject a release variable that differs from the authority", () => {
    const deploy = readFileSync(".github/workflows/deploy.yml", "utf8");
    expect(deploy).toContain(
      'require("./src/data/public-cli-release.json").hostedCliRelease',
    );
    expect(deploy).toContain(
      'require("./src/data/public-cli-release.json").hostedCliCommit',
    );
    expect(deploy).toContain(
      'require("./src/data/public-cli-release.json").hostedCliLinuxX86_64Sha256',
    );
    expect(deploy).toContain('[[ "${TAG}" != "${expected_tag}" ]]');
    expect(deploy).toContain(
      '--certificate-github-workflow-sha "${expected_commit}"',
    );
    expect(deploy).toContain(
      '--certificate-identity "https://github.com/postil-dev/postil-cli/.github/workflows/release.yml@refs/tags/${TAG}"',
    );
    expect(deploy).toContain(
      "bun run scripts/verify-postil-cli-contract.ts --binary vendor/postil",
    );
    expect(deploy).toContain("FLYCTL_VERSION: 0.4.71");
    expect(deploy).toContain(
      "FLYCTL_LINUX_X86_64_SHA256: a782dceed173d215c000ab94e2b08623c22267edff6d90ebe3010b3f9b671dc2",
    );
    expect(deploy).toContain("--retry 5 --retry-all-errors --retry-delay 2");
    expect(deploy).not.toContain("superfly/flyctl-actions/setup-flyctl");
    expect(deploy).not.toContain("version: latest");
  });

  test("keeps the changelog head aligned with the current CLI release", () => {
    const changelog = readFileSync("src/app/changelog/page.tsx", "utf8");
    const headVersion = changelog.match(/version: "([^"]+)"/)?.[1];
    expect(headVersion).toBeDefined();
    expect(headVersion?.split(/[–-]/).at(-1)).toBe(
      release.hostedCliRelease.slice(1),
    );
  });

  test("runs the release authority check in CI with authenticated GitHub access", () => {
    const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(workflow).toContain("bun run scripts/verify-public-cli-version.ts");
    expect(workflow).toContain("GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}");
  });
});
