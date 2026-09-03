import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

const root = join(import.meta.dir, "..");

describe("deployment workflow trust boundaries", () => {
  test("authorizes only successful push CI on main or manual deploys from main", () => {
    const workflow = parse(
      readFileSync(join(root, ".github/workflows/deploy.yml"), "utf8"),
    ) as {
      permissions: Record<string, never>;
      jobs: {
        authorize: {
          if: string;
          permissions: Record<string, never>;
        };
        deploy: {
          if: string;
          name: string;
          needs: string;
          permissions: Record<string, string>;
        };
      };
    };

    expect(workflow.permissions).toEqual({});
    expect(workflow.jobs.authorize.permissions).toEqual({});
    expect(workflow.jobs.authorize.if).toBe(
      "${{ (github.event_name == 'workflow_run' && github.event.workflow_run.event == 'push' && github.event.workflow_run.head_branch == 'main' && github.event.workflow_run.conclusion == 'success') || (github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main') }}",
    );
    expect(workflow.jobs.deploy).toMatchObject({
      name: "Deploy production",
      needs: "authorize",
      if: "${{ needs.authorize.result == 'success' && vars.FLY_DEPLOY_ENABLED == 'true' }}",
      permissions: { contents: "read", "id-token": "write" },
    });

    const authorized = ({
      eventName,
      ref = "",
      upstreamBranch = "",
      upstreamConclusion = "",
      upstreamEvent = "",
    }: {
      eventName: string;
      ref?: string;
      upstreamBranch?: string;
      upstreamConclusion?: string;
      upstreamEvent?: string;
    }) =>
      (eventName === "workflow_run" &&
        upstreamEvent === "push" &&
        upstreamBranch === "main" &&
        upstreamConclusion === "success") ||
      (eventName === "workflow_dispatch" && ref === "refs/heads/main");

    expect(authorized({
      eventName: "workflow_run",
      upstreamBranch: "main",
      upstreamConclusion: "success",
      upstreamEvent: "push",
    })).toBe(true);
    expect(authorized({
      eventName: "workflow_run",
      upstreamBranch: "main",
      upstreamConclusion: "success",
      upstreamEvent: "pull_request",
    })).toBe(false);
    expect(authorized({
      eventName: "workflow_run",
      upstreamBranch: "feature",
      upstreamConclusion: "success",
      upstreamEvent: "push",
    })).toBe(false);
    expect(authorized({
      eventName: "workflow_run",
      upstreamBranch: "main",
      upstreamConclusion: "failure",
      upstreamEvent: "push",
    })).toBe(false);
    expect(authorized({
      eventName: "workflow_dispatch",
      ref: "refs/heads/main",
    })).toBe(true);
    expect(authorized({
      eventName: "workflow_dispatch",
      ref: "refs/heads/feature",
    })).toBe(false);
  });

  test("derives downstream trust from the triggering deploy attempt's jobs", () => {
    const workflow = parse(
      readFileSync(join(root, ".github/workflows/production-monitor.yml"), "utf8"),
    ) as {
      permissions: Record<string, never>;
      jobs: {
        "deployment-trust": {
          permissions: Record<string, string>;
          "timeout-minutes": number;
          steps: Array<{
            id?: string;
            env?: Record<string, string>;
            run?: string;
            "timeout-minutes"?: number;
          }>;
        };
      };
    };
    const deployWorkflow = parse(
      readFileSync(join(root, ".github/workflows/deploy.yml"), "utf8"),
    ) as { jobs: { authorize: { name: string }; deploy: { name: string } } };
    const trustJob = workflow.jobs["deployment-trust"];
    const evidenceStep = trustJob.steps.find((step) => step.id === "evidence");
    const run = evidenceStep?.run;
    expect(workflow.permissions).toEqual({});
    expect(trustJob.permissions).toEqual({ actions: "read" });
    expect(trustJob["timeout-minutes"]).toBe(4);
    expect(evidenceStep?.["timeout-minutes"]).toBe(3);
    expect(JSON.stringify(trustJob)).not.toContain("secrets.");
    expect(JSON.stringify(trustJob)).not.toContain("id-token");
    expect(run).toBeDefined();
    expect(deployWorkflow.jobs.authorize.name).toBe("Authorize deployment source");
    expect(deployWorkflow.jobs.deploy.name).toBe("Deploy production");
    expect(run).toContain(`.name == "${deployWorkflow.jobs.authorize.name}"`);
    expect(run).toContain(`.name == "${deployWorkflow.jobs.deploy.name}"`);
    expect(run).toContain("timeout --signal=TERM --kill-after=5s 30s gh api");

    const temporaryDirectory = mkdtempSync(join(tmpdir(), "postil-workflow-trust-"));
    const ghPath = join(temporaryDirectory, "gh");
    const outputPath = join(temporaryDirectory, "output");
    const callsPath = join(temporaryDirectory, "calls");
    writeFileSync(
      ghPath,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${callsPath}"
path="\${!#}"
if [[ ! "\${path}" =~ /attempts/([0-9]+)/jobs\\?per_page=100$ ]]; then
  exit 2
fi
jq -cer --arg attempt "\${BASH_REMATCH[1]}" '.[$attempt] // error("missing mock attempt")' <<<"\${MOCK_ATTEMPTS_JSON}"
`,
    );
    chmodSync(ghPath, 0o755);

    const evaluate = ({
      attempts,
      deployEvent = "workflow_run",
      eventName = "workflow_run",
      eventRef = "refs/heads/main",
      runAttempt = 1,
    }: {
      attempts?: Record<string, { total_count: number; jobs: Array<{ name: string; conclusion: string }> }>;
      deployEvent?: string;
      eventName?: string;
      eventRef?: string;
      runAttempt?: number;
    }) => {
      writeFileSync(outputPath, "");
      writeFileSync(callsPath, "");
      const attemptEvidence = attempts ?? {
        "1": {
          total_count: 2,
          jobs: [
            { name: "Authorize deployment source", conclusion: "success" },
            { name: "Deploy production", conclusion: "success" },
          ],
        },
      };
      const result = spawnSync("bash", ["-c", run!], {
        encoding: "utf8",
        env: {
          DEPLOY_EVENT: deployEvent,
          DEPLOY_RUN_ATTEMPT: String(runAttempt),
          DEPLOY_RUN_ID: "123",
          EVENT_NAME: eventName,
          EVENT_REF: eventRef,
          GH_TOKEN: "test-token",
          GITHUB_OUTPUT: outputPath,
          GITHUB_REPOSITORY: "postil-dev/postil",
          MOCK_ATTEMPTS_JSON: JSON.stringify(attemptEvidence),
          NODE_ENV: "test",
          PATH: `${temporaryDirectory}:${process.env.PATH}`,
        } as NodeJS.ProcessEnv,
      });
      const outputs = Object.fromEntries(
        readFileSync(outputPath, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => line.split("=", 2) as [string, string]),
      );
      const calls = readFileSync(callsPath, "utf8").trim().split("\n").filter(Boolean);
      return { calls, outputs, status: result.status, stderr: result.stderr };
    };
    const evidence = (
      authorizationConclusion: string,
      deployConclusion: string,
    ) => ({
      "1": {
        total_count: 2,
        jobs: [
          { name: "Authorize deployment source", conclusion: authorizationConclusion },
          { name: "Deploy production", conclusion: deployConclusion },
        ],
      },
    });

    try {
      for (const conclusion of ["success", "failure", "cancelled", "timed_out"]) {
        expect(evaluate({ attempts: evidence("success", conclusion) })).toMatchObject({
          status: 0,
          outputs: { conclusion, trusted: "true" },
        });
      }
      expect(evaluate({ attempts: evidence("skipped", "skipped") })).toMatchObject({
        status: 0,
        outputs: { conclusion: "skipped", trusted: "false" },
      });
      expect(evaluate({ attempts: evidence("success", "skipped") })).toMatchObject({
        status: 0,
        outputs: { conclusion: "skipped", trusted: "false" },
      });
      expect(evaluate({ attempts: evidence("skipped", "failure") })).toMatchObject({
        status: 0,
        outputs: { conclusion: "failure", trusted: "false" },
      });

      const partialRerun = evaluate({
        runAttempt: 2,
        attempts: {
          "1": {
            total_count: 2,
            jobs: [
              { name: "Authorize deployment source", conclusion: "success" },
              { name: "Deploy production", conclusion: "failure" },
            ],
          },
          "2": {
            total_count: 1,
            jobs: [{ name: "Deploy production", conclusion: "cancelled" }],
          },
        },
      });
      expect(partialRerun).toMatchObject({
        status: 0,
        outputs: { conclusion: "cancelled", trusted: "true" },
      });
      expect(partialRerun.calls).toEqual([
        "api --method GET repos/postil-dev/postil/actions/runs/123/attempts/1/jobs?per_page=100",
        "api --method GET repos/postil-dev/postil/actions/runs/123/attempts/2/jobs?per_page=100",
      ]);

      const duplicate = evaluate({
        attempts: {
          "1": {
            total_count: 3,
            jobs: [
              { name: "Authorize deployment source", conclusion: "success" },
              { name: "Deploy production", conclusion: "success" },
              { name: "Deploy production", conclusion: "failure" },
            ],
          },
        },
      });
      expect(duplicate.status).not.toBe(0);
      expect(duplicate.outputs.trusted).toBe("false");

      const missingAuthorization = evaluate({
        attempts: {
          "1": {
            total_count: 1,
            jobs: [{ name: "Deploy production", conclusion: "success" }],
          },
        },
      });
      expect(missingAuthorization.status).not.toBe(0);
      expect(missingAuthorization.outputs.trusted).toBe("false");

      const missingCurrentDeployment = evaluate({
        attempts: {
          "1": {
            total_count: 1,
            jobs: [{ name: "Authorize deployment source", conclusion: "success" }],
          },
        },
      });
      expect(missingCurrentDeployment.status).not.toBe(0);
      expect(missingCurrentDeployment.outputs.trusted).toBe("false");

      const truncated = evaluate({
        attempts: {
          "1": {
            total_count: 3,
            jobs: [
              { name: "Authorize deployment source", conclusion: "success" },
              { name: "Deploy production", conclusion: "success" },
            ],
          },
        },
      });
      expect(truncated.status).not.toBe(0);
      expect(truncated.outputs.trusted).toBe("false");

      expect(evaluate({ deployEvent: "pull_request" })).toMatchObject({
        calls: [],
        status: 0,
        outputs: { conclusion: "", trusted: "false" },
      });
      expect(evaluate({
        eventName: "workflow_dispatch",
        eventRef: "refs/heads/main",
      })).toMatchObject({ calls: [], status: 0, outputs: { conclusion: "", trusted: "true" } });
      expect(evaluate({
        eventName: "workflow_dispatch",
        eventRef: "refs/heads/feature",
      })).toMatchObject({ calls: [], status: 0, outputs: { conclusion: "", trusted: "false" } });
      expect(evaluate({ eventName: "schedule" })).toMatchObject({
        calls: [],
        status: 0,
        outputs: { conclusion: "", trusted: "true" },
      });
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test("gates every production credential path on deployment evidence", () => {
    const source = readFileSync(
      join(root, ".github/workflows/production-monitor.yml"),
      "utf8",
    );
    const workflow = parse(source) as {
      jobs: Record<string, {
        if?: string;
        needs?: string | string[];
        steps?: Array<{ uses?: string }>;
      }>;
    };
    const protectedJobs = Object.entries(workflow.jobs).filter(([, job]) =>
      JSON.stringify(job).includes("secrets.") ||
      job.steps?.some((step) =>
        step.uses?.startsWith("Infisical/secrets-action@") ||
        step.uses === "./.github/actions/ilert-event"
      )
    );

    expect(protectedJobs.map(([name]) => name).sort()).toEqual([
      "alert-stream",
      "alert-stream-finalize",
      "canary-orphan-sweep",
      "notify",
      "release-recovery",
      "resolve",
      "resolve-release-recovery",
      "smoke",
    ]);
    for (const [, job] of protectedJobs) {
      const needs = Array.isArray(job.needs) ? job.needs : [job.needs];
      expect(needs).toContain("deployment-trust");
      expect(job.if).toContain("needs.deployment-trust.outputs.trusted == 'true'");
    }
    expect(source).not.toContain("github.event.workflow_run.conclusion");
  });
});
