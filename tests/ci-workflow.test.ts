import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { parse } from "yaml";

const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));

describe("required CI check", () => {
  test("waits for independent suites and production dashboard verification", () => {
    const { suites, build, test: required } = workflow.jobs;
    expect(suites.needs).toBeUndefined();
    expect(build.needs).toBeUndefined();
    expect(required.needs).toEqual(["suites", "build"]);
    expect(required.if).toBe("${{ always() }}");
    expect(build.steps.slice(-2).map((step: { run: string }) => step.run))
      .toEqual(["bun run build", "bun run verify:dashboard"]);
    expect(build.steps.at(-1).env.POSTIL_DASHBOARD_SERVER).toBe("start");
    expect(required.steps[0].env).toEqual({
      SUITES_RESULT: "${{ needs.suites.result }}",
      BUILD_RESULT: "${{ needs.build.result }}",
    });
  });

  for (const suites of ["success", "failure", "cancelled", "skipped"]) {
    for (const build of ["success", "failure", "cancelled", "skipped"]) {
      test(`suites=${suites}, build=${build}`, () => {
        const result = Bun.spawnSync([
          "bash", "--noprofile", "--norc", "-e", "-o", "pipefail", "-c",
          workflow.jobs.test.steps[0].run,
        ], { env: { SUITES_RESULT: suites, BUILD_RESULT: build } });
        expect(result.exitCode === 0).toBe(suites === "success" && build === "success");
      });
    }
  }
});
