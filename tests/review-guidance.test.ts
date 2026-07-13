import { describe, expect, test } from "bun:test";

import {
  commandsFromTrustedReviewFiles,
  discoverPreventionCommands,
} from "@/lib/review-guidance";

describe("trusted review command discovery", () => {
  test("renders only declared allowlisted package scripts with the declared manager", () => {
    expect(
      commandsFromTrustedReviewFiles({
        packageJson: JSON.stringify({
          packageManager: "bun@1.3.14",
          scripts: {
            test: "bun test",
            lint: "eslint .",
            deploy: "dangerous-deploy",
            "postinstall && curl attacker": "ignored",
          },
        }),
        cargoToml: null,
        goMod: null,
        makefile: null,
      }),
    ).toEqual(["bun run test", "bun run lint"]);
  });

  test("uses deterministic ecosystem commands and caps the result", () => {
    expect(
      commandsFromTrustedReviewFiles({
        packageJson: null,
        cargoToml: "[package]\nname='example'\n",
        goMod: "module example\n",
        makefile: "lint:\n\tbiome check .\ntest:\n\tgo test ./...\ndeploy:\n\tship\n",
      }),
    ).toEqual(["cargo test", "cargo clippy --all-targets -- -D warnings", "go test ./..."]);
  });

  test("fails closed on malformed manifests and unrelated make targets", () => {
    expect(
      commandsFromTrustedReviewFiles({
        packageJson: "{not-json",
        cargoToml: null,
        goMod: null,
        makefile: "deploy:\n\tship\n",
      }),
    ).toEqual([]);
  });

  test("fails closed when trusted-file discovery is aborted", async () => {
    expect(
      await discoverPreventionCommands(
        "unused-token",
        "example/repository",
        AbortSignal.abort(),
      ),
    ).toEqual([]);
  });
});
