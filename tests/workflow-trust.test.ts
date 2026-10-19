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
  test("admits only manual deployments and exposes one deploy job", () => {
    const workflow = parse(
      readFileSync(join(root, ".github/workflows/deploy.yml"), "utf8"),
    ) as {
      on: Record<string, unknown>;
      jobs: Record<string, { if?: string; name?: string }>;
    };

    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(Object.keys(workflow.jobs)).toEqual(["deploy"]);
    expect(workflow.jobs.deploy!.name).toBeUndefined();
    expect(workflow.jobs.deploy!.if).toBe(
      "vars.FLY_DEPLOY_ENABLED == 'true' && github.event_name == 'workflow_dispatch'",
    );
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
    ) as { jobs: Record<string, { name?: string }> };
    const trustJob = workflow.jobs["deployment-trust"];
    const evidenceStep = trustJob.steps.find((step) => step.id === "evidence");
    const run = evidenceStep?.run;
    expect(workflow.permissions).toEqual({});
    expect(trustJob.permissions).toEqual({ actions: "read" });
    expect(trustJob["timeout-minutes"]).toBe(5);
    expect(evidenceStep?.["timeout-minutes"]).toBe(3);
    expect(JSON.stringify(trustJob)).not.toContain("secrets.");
    expect(JSON.stringify(trustJob)).not.toContain("id-token");
    expect(run).toBeDefined();
    // GitHub reports a job without a display name under its job identifier.
    expect(Object.keys(deployWorkflow.jobs)).toEqual(["deploy"]);
    expect(deployWorkflow.jobs.deploy!.name).toBeUndefined();
    expect(run).toContain('.name == "deploy"');
    expect(evidenceStep?.env?.DEPLOY_HEAD_BRANCH).toBe(
      "${{ github.event.workflow_run.head_branch }}",
    );
    expect(run).toContain("timeout --signal=TERM --kill-after=5s 30s gh api");
    expect(run).toContain("for api_attempt in 1 2 3");
    expect(run).toContain("sleep 2");

    const temporaryDirectory = mkdtempSync(join(tmpdir(), "postil-workflow-trust-"));
    const ghPath = join(temporaryDirectory, "gh");
    const outputPath = join(temporaryDirectory, "output");
    const callsPath = join(temporaryDirectory, "calls");
    const callCountPath = join(temporaryDirectory, "call-count");
    const delaysPath = join(temporaryDirectory, "delays");
    const sleepPath = join(temporaryDirectory, "sleep");
    writeFileSync(
      ghPath,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${callsPath}"
call_count="$(<"${callCountPath}")"
call_count="$((call_count + 1))"
printf '%s\n' "\${call_count}" > "${callCountPath}"
if (( call_count <= MOCK_GH_FAILURES )); then
  exit 75
fi
path="\${!#}"
if [[ ! "\${path}" =~ /attempts/([0-9]+)/jobs\\?per_page=100$ ]]; then
  exit 2
fi
jq -cer --arg attempt "\${BASH_REMATCH[1]}" '.[$attempt] // error("missing mock attempt")' <<<"\${MOCK_ATTEMPTS_JSON}"
`,
    );
    chmodSync(ghPath, 0o755);
    writeFileSync(
      sleepPath,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${delaysPath}"
`,
    );
    chmodSync(sleepPath, 0o755);

    const evaluate = ({
      attempts,
      deployEvent = "workflow_dispatch",
      deployHeadBranch = "main",
      eventName = "workflow_run",
      eventRef = "refs/heads/main",
      ghFailures = 0,
      reconcileAlertStream = "",
      runAttempt = 1,
      testAlert = "",
    }: {
      attempts?: Record<string, { total_count: number; jobs: Array<{ name: string; conclusion: string }> }>;
      deployEvent?: string;
      deployHeadBranch?: string;
      eventName?: string;
      eventRef?: string;
      ghFailures?: number;
      reconcileAlertStream?: string;
      runAttempt?: number;
      testAlert?: string;
    }) => {
      writeFileSync(outputPath, "");
      writeFileSync(callsPath, "");
      writeFileSync(callCountPath, "0\n");
      writeFileSync(delaysPath, "");
      const attemptEvidence = attempts ?? {
        "1": {
          total_count: 1,
          jobs: [{ name: "deploy", conclusion: "success" }],
        },
      };
      const result = spawnSync("bash", ["-c", run!], {
        encoding: "utf8",
        env: {
          DEPLOY_EVENT: deployEvent,
          DEPLOY_HEAD_BRANCH: deployHeadBranch,
          DEPLOY_RUN_ATTEMPT: String(runAttempt),
          DEPLOY_RUN_ID: "123",
          EVENT_NAME: eventName,
          EVENT_REF: eventRef,
          GH_TOKEN: "test-token",
          GITHUB_OUTPUT: outputPath,
          GITHUB_REPOSITORY: "postil-dev/postil",
          MOCK_ATTEMPTS_JSON: JSON.stringify(attemptEvidence),
          MOCK_GH_FAILURES: String(ghFailures),
          NODE_ENV: "test",
          PATH: `${temporaryDirectory}:${process.env.PATH}`,
          RECONCILE_ALERT_STREAM: reconcileAlertStream,
          TEST_ALERT: testAlert,
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
      const delays = readFileSync(delaysPath, "utf8").trim().split("\n").filter(Boolean);
      return { calls, delays, outputs, status: result.status, stderr: result.stderr };
    };
    const evidence = (deployConclusion: string) => ({
      "1": {
        total_count: 1,
        jobs: [{ name: "deploy", conclusion: deployConclusion }],
      },
    });

    try {
      // The finalizer resolves the key the operator test alert uses, so one
      // dispatch may request either manual alert path but never both.
      expect(evidenceStep?.env).toMatchObject({
        RECONCILE_ALERT_STREAM: "${{ inputs.reconcile_alert_stream }}",
        TEST_ALERT: "${{ inputs.test_alert }}",
      });
      const conflictingInputs = evaluate({
        eventName: "workflow_dispatch",
        reconcileAlertStream: "true",
        testAlert: "true",
      });
      expect(conflictingInputs).toMatchObject({
        status: 1,
        outputs: { conclusion: "", trusted: "false" },
        calls: [],
      });
      expect(conflictingInputs.stderr).toContain(
        "test_alert and reconcile_alert_stream cannot be combined",
      );
      for (const [testAlert, reconcileAlertStream] of [
        ["true", "false"],
        ["false", "true"],
        ["false", "false"],
      ] as const) {
        expect(evaluate({
          eventName: "workflow_dispatch",
          reconcileAlertStream,
          testAlert,
        })).toMatchObject({ status: 0, outputs: { trusted: "true" } });
      }
      expect(evaluate({
        eventName: "workflow_dispatch",
        eventRef: "refs/heads/feature",
        reconcileAlertStream: "true",
        testAlert: "true",
      }).outputs.trusted).toBe("false");
      // Scheduled and deployment-triggered runs carry no inputs.
      expect(evaluate({ eventName: "schedule" })).toMatchObject({
        status: 0,
        outputs: { trusted: "true" },
      });

      for (const conclusion of ["success", "failure", "cancelled", "timed_out"]) {
        expect(evaluate({ attempts: evidence(conclusion) })).toMatchObject({
          status: 0,
          outputs: { conclusion, trusted: "true" },
        });
      }
      expect(evaluate({ attempts: evidence("skipped") })).toMatchObject({
        status: 0,
        outputs: { conclusion: "skipped", trusted: "false" },
      });

      const rerun = evaluate({
        runAttempt: 2,
        attempts: {
          "1": {
            total_count: 1,
            jobs: [{ name: "deploy", conclusion: "failure" }],
          },
          "2": {
            total_count: 1,
            jobs: [{ name: "deploy", conclusion: "cancelled" }],
          },
        },
      });
      expect(rerun).toMatchObject({
        status: 0,
        outputs: { conclusion: "cancelled", trusted: "true" },
      });
      expect(rerun.calls).toEqual([
        "api --method GET repos/postil-dev/postil/actions/runs/123/attempts/2/jobs?per_page=100",
      ]);

      const transientApiFailure = evaluate({ ghFailures: 2 });
      expect(transientApiFailure).toMatchObject({
        status: 0,
        outputs: { conclusion: "success", trusted: "true" },
        delays: ["2", "2"],
      });
      expect(transientApiFailure.calls).toHaveLength(3);

      const exhaustedApiFailure = evaluate({ ghFailures: 3 });
      expect(exhaustedApiFailure.status).not.toBe(0);
      expect(exhaustedApiFailure.outputs.trusted).toBe("false");
      expect(exhaustedApiFailure.calls).toHaveLength(3);
      expect(exhaustedApiFailure.delays).toEqual(["2", "2"]);
      expect(exhaustedApiFailure.stderr).toContain(
        "Deployment job evidence remained unavailable after bounded retries.",
      );

      const duplicate = evaluate({
        attempts: {
          "1": {
            total_count: 2,
            jobs: [
              { name: "deploy", conclusion: "success" },
              { name: "deploy", conclusion: "failure" },
            ],
          },
        },
      });
      expect(duplicate.status).not.toBe(0);
      expect(duplicate.outputs.trusted).toBe("false");

      const missingDeployment = evaluate({
        attempts: {
          "1": {
            total_count: 1,
            jobs: [{ name: "Deploy production", conclusion: "success" }],
          },
        },
      });
      expect(missingDeployment.status).not.toBe(0);
      expect(missingDeployment.outputs.trusted).toBe("false");

      const truncated = evaluate({
        attempts: {
          "1": {
            total_count: 2,
            jobs: [{ name: "deploy", conclusion: "success" }],
          },
        },
      });
      expect(truncated.status).not.toBe(0);
      expect(truncated.outputs.trusted).toBe("false");

      for (const deployEvent of ["pull_request", "push", "workflow_run"]) {
        expect(evaluate({ deployEvent })).toMatchObject({
          calls: [],
          status: 0,
          outputs: { conclusion: "", trusted: "false" },
        });
      }
      expect(evaluate({ deployHeadBranch: "feature" })).toMatchObject({
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
      "resolve-test-alert",
      "smoke",
    ]);
    for (const [, job] of protectedJobs) {
      const needs = Array.isArray(job.needs) ? job.needs : [job.needs];
      expect(needs).toContain("deployment-trust");
      expect(job.if).toContain("needs.deployment-trust.outputs.trusted == 'true'");
    }
    expect(source).not.toContain("github.event.workflow_run.conclusion");
  });

  test("runs the orphan canary sweep only after an explicit repository opt-in", () => {
    const workflow = parse(
      readFileSync(join(root, ".github/workflows/production-monitor.yml"), "utf8"),
    ) as {
      jobs: Record<string, {
        if?: string;
        steps: Array<{ name?: string; if?: string; run?: string; uses?: string }>;
      }>;
    };
    const optIn = "vars.POSTIL_ILERT_CANARY_SWEEP_ENABLED";
    expect(workflow.jobs["canary-orphan-sweep"]!.if).toContain(
      `needs.deployment-trust.outputs.trusted == 'true' && ${optIn} == 'true' && `,
    );
    // Jobs that exist on the released monitor stay independent of the opt-in.
    for (const name of ["smoke", "release-recovery", "notify", "resolve", "resolve-release-recovery"]) {
      expect(workflow.jobs[name]!.if).not.toContain(optIn);
    }

    const report = workflow.jobs["deployment-trust"]!.steps.find(
      (step) => step.name === "Report the orphaned iLert canary sweep state",
    );
    expect(report?.uses).toBeUndefined();
    expect(report?.if).toBe(
      `\${{ steps.evidence.outputs.trusted == 'true' && github.event_name != 'workflow_run' && ${optIn} != 'true' }}`,
    );
    const summaryDirectory = mkdtempSync(join(tmpdir(), "postil-sweep-state-"));
    try {
      const summaryPath = join(summaryDirectory, "summary");
      writeFileSync(summaryPath, "");
      const result = spawnSync("bash", ["-c", report!.run!], {
        encoding: "utf8",
        env: {
          GITHUB_STEP_SUMMARY: summaryPath,
          NODE_ENV: "test",
          PATH: process.env.PATH,
        } as NodeJS.ProcessEnv,
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("::notice title=Orphaned iLert canary sweep is disabled::");
      expect(readFileSync(summaryPath, "utf8")).toContain(
        "makes no iLert management request and resolves no orphaned canary alert",
      );
    } finally {
      rmSync(summaryDirectory, { recursive: true, force: true });
    }
  });
});
