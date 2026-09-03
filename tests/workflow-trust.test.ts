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
          steps: Array<{
            id?: string;
            env?: Record<string, string>;
            run?: string;
          }>;
        };
      };
    };
    const trustJob = workflow.jobs["deployment-trust"];
    const run = trustJob.steps.find((step) => step.id === "evidence")?.run;
    expect(workflow.permissions).toEqual({});
    expect(trustJob.permissions).toEqual({ actions: "read" });
    expect(JSON.stringify(trustJob)).not.toContain("secrets.");
    expect(JSON.stringify(trustJob)).not.toContain("id-token");
    expect(run).toBeDefined();

    const temporaryDirectory = mkdtempSync(join(tmpdir(), "postil-workflow-trust-"));
    const ghPath = join(temporaryDirectory, "gh");
    const outputPath = join(temporaryDirectory, "output");
    writeFileSync(ghPath, "#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\n' \"${MOCK_JOBS_JSON}\"\n");
    chmodSync(ghPath, 0o755);

    const evaluate = ({
      authorizationConclusion = "success",
      deployConclusion = "success",
      deployEvent = "workflow_run",
      eventName = "workflow_run",
      eventRef = "refs/heads/main",
    }: {
      authorizationConclusion?: string;
      deployConclusion?: string;
      deployEvent?: string;
      eventName?: string;
      eventRef?: string;
    }) => {
      writeFileSync(outputPath, "");
      const jobs = {
        jobs: [
          { name: "Authorize deployment source", conclusion: authorizationConclusion },
          { name: "Deploy production", conclusion: deployConclusion },
        ],
      };
      const result = spawnSync("bash", ["-c", run!], {
        encoding: "utf8",
        env: {
          DEPLOY_EVENT: deployEvent,
          DEPLOY_RUN_ATTEMPT: "1",
          DEPLOY_RUN_ID: "123",
          EVENT_NAME: eventName,
          EVENT_REF: eventRef,
          GH_TOKEN: "test-token",
          GITHUB_OUTPUT: outputPath,
          GITHUB_REPOSITORY: "postil-dev/postil",
          MOCK_JOBS_JSON: JSON.stringify(jobs),
          NODE_ENV: "test",
          PATH: `${temporaryDirectory}:${process.env.PATH}`,
        } as NodeJS.ProcessEnv,
      });
      expect(result.status).toBe(0);
      const outputs = Object.fromEntries(
        readFileSync(outputPath, "utf8")
          .trim()
          .split("\n")
          .map((line) => line.split("=", 2) as [string, string]),
      );
      return outputs;
    };

    try {
      expect(evaluate({ deployConclusion: "success" })).toEqual({
        conclusion: "success",
        trusted: "true",
      });
      expect(evaluate({ deployConclusion: "failure" })).toEqual({
        conclusion: "failure",
        trusted: "true",
      });
      expect(evaluate({ deployConclusion: "cancelled" })).toEqual({
        conclusion: "cancelled",
        trusted: "true",
      });
      expect(evaluate({ deployConclusion: "timed_out" })).toEqual({
        conclusion: "timed_out",
        trusted: "true",
      });
      expect(evaluate({
        authorizationConclusion: "skipped",
        deployConclusion: "skipped",
      })).toEqual({ conclusion: "skipped", trusted: "false" });
      expect(evaluate({ deployConclusion: "skipped" })).toEqual({
        conclusion: "skipped",
        trusted: "false",
      });
      expect(evaluate({
        authorizationConclusion: "skipped",
        deployConclusion: "failure",
      })).toEqual({ conclusion: "failure", trusted: "false" });
      expect(evaluate({ deployEvent: "pull_request" })).toEqual({
        conclusion: "",
        trusted: "false",
      });
      expect(evaluate({
        eventName: "workflow_dispatch",
        eventRef: "refs/heads/main",
      })).toEqual({ conclusion: "", trusted: "true" });
      expect(evaluate({
        eventName: "workflow_dispatch",
        eventRef: "refs/heads/feature",
      })).toEqual({ conclusion: "", trusted: "false" });
      expect(evaluate({ eventName: "schedule" })).toEqual({
        conclusion: "",
        trusted: "true",
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
