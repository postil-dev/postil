import { beforeEach, describe, expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

let queryCount = 0;
let queryImpl: (text: string) => Promise<unknown>;

mock.module("@/lib/db", () => ({
  getPool: () => ({
    query: async (text: string) => {
      queryCount += 1;
      return queryImpl(text);
    },
  }),
}));

const livenessRoute = await import("@/app/api/health/route");
const dependenciesRoute = await import("@/app/api/health/dependencies/route");
const monitorRoute = await import("@/app/api/health/monitor/route");

beforeEach(() => {
  queryCount = 0;
  queryImpl = async () => ({ rows: [{ ok: 1 }] });
});

describe("/api/health", () => {
  test("is cheap process liveness and does not need database configuration", async () => {
    const previousBootProbe = process.env.POSTIL_BOOT_PROBE;
    const previousDatabaseUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    delete process.env.POSTIL_BOOT_PROBE;

    try {
      const response = await livenessRoute.GET();

      expect(response.status).toBe(200);
      expect(response.headers.has("x-postil-boot-probe")).toBe(false);
      expect(await response.json()).toEqual({ ok: true, service: "web" });
      expect(queryCount).toBe(0);
    } finally {
      restoreEnvironmentVariable("DATABASE_URL", previousDatabaseUrl);
      restoreEnvironmentVariable("POSTIL_BOOT_PROBE", previousBootProbe);
    }
  });

  test("echoes the build boot-probe nonce only after instrumentation marks readiness", async () => {
    const previousBootProbe = process.env.POSTIL_BOOT_PROBE;
    const previousBootProbeReady = process.env.POSTIL_BOOT_PROBE_READY;
    delete process.env.POSTIL_BOOT_PROBE_READY;
    process.env.POSTIL_BOOT_PROBE = "probe-123";
    try {
      const unregisteredResponse = await livenessRoute.GET();
      expect(unregisteredResponse.headers.has("x-postil-boot-probe")).toBe(false);

      process.env.POSTIL_BOOT_PROBE_READY = "probe-123";
      const response = await livenessRoute.GET();

      expect(response.headers.get("x-postil-boot-probe")).toBe("probe-123");
      expect(await response.json()).toEqual({ ok: true, service: "web" });
    } finally {
      restoreEnvironmentVariable("POSTIL_BOOT_PROBE", previousBootProbe);
      restoreEnvironmentVariable("POSTIL_BOOT_PROBE_READY", previousBootProbeReady);
    }
  });

  test("does not import the database module", async () => {
    const source = await readFile(
      new URL("../src/app/api/health/route.ts", import.meta.url),
      "utf8",
    );

    expect(source).not.toContain("@/lib/db");
    expect(source).not.toMatch(/\bget(Db|Pool)\b/);
  });
});

function restoreEnvironmentVariable(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe("/api/health/dependencies", () => {
  test("returns 200 when the database probe succeeds", async () => {
    queryImpl = async (text: string) => {
      expect(text).toBe("SELECT 1");
      return { rows: [{ ok: 1 }] };
    };

    const response = await dependenciesRoute.GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, database: "up" });
    expect(queryCount).toBe(1);
  });

  test("returns 503 when the database probe fails", async () => {
    queryImpl = async () => {
      throw new Error("database unavailable");
    };

    const response = await dependenciesRoute.GET();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      database: "down",
      error: "database health check failed",
    });
    expect(queryCount).toBe(1);
  });
});

describe("/api/health/monitor", () => {
  test("reports healthy only when process, collection, and heartbeat delivery are fresh", async () => {
    queryImpl = async (text: string) => {
      expect(text).toContain("component = 'monitor'");
      expect(text).toContain("last_completed_at");
      expect(text).toContain("component = 'monitor-heartbeat-delivery'");
      return {
        rows: [
          {
            process_age_seconds: "30",
            collection_age_seconds: "45",
            heartbeat_delivery_age_seconds: "60",
          },
        ],
      };
    };

    const response = await monitorRoute.GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      ok: true,
      monitor: {
        process: "up",
        collection: "up",
        heartbeatDelivery: "up",
      },
    });
    expect(queryCount).toBe(1);
  });

  test("distinguishes stale and missing monitor evidence", async () => {
    queryImpl = async () => ({
      rows: [
        {
          process_age_seconds: "901",
          collection_age_seconds: "2147483647",
          heartbeat_delivery_age_seconds: "900",
        },
      ],
    });

    const response = await monitorRoute.GET();

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      ok: false,
      monitor: {
        process: "stale",
        collection: "missing",
        heartbeatDelivery: "stale",
      },
    });
  });

  test("fails closed without disclosing database errors", async () => {
    queryImpl = async () => {
      throw new Error("private database endpoint");
    };

    const response = await monitorRoute.GET();

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      ok: false,
      monitor: {
        process: "unknown",
        collection: "unknown",
        heartbeatDelivery: "unknown",
      },
    });
  });
});

describe("production monitor workflow", () => {
  test("owns a bounded, accurately disclosed iLert webhook reconciliation canary", async () => {
    const source = await readFile(
      new URL("../.github/workflows/production-monitor.yml", import.meta.url),
      "utf8",
    );
    const workflow = parse(source) as {
      jobs: Record<
        string,
        {
          if?: string;
          name?: string;
          needs?: string | string[];
          outputs?: Record<string, string>;
          "timeout-minutes"?: number;
          steps?: Array<{
            env?: Record<string, string>;
            name?: string;
            run?: string;
            uses?: string;
            with?: Record<string, string>;
          }>;
        }
      >;
    };
    expect(source).toContain("reconcile_alert_stream:");
    expect(source).toContain(
      "description: Reconcile the iLert webhook action and send then resolve a HIGH-priority production test alert; it can invoke the escalation path",
    );
    const architecture = await readFile(
      new URL("../ARCHITECTURE.md", import.meta.url),
      "utf8",
    );
    expect(architecture).toContain(
      "HIGH-priority production test alert that can invoke the escalation path",
    );
    expect(architecture).toContain(
      "primary canary already proved exact\npersisted receiver create and resolve events",
    );
    expect(architecture).toContain(
      "independent cleanup-only finalizer proves that iLert management\nstate has no open deterministic alert",
    );
    expect(source).toContain(
      "primary canary already proved exact persisted\n    # receiver create and resolve events",
    );
    expect(source).toContain(
      "Other handoffs prove iLert management\n    # state has no open deterministic alert, or fail closed.",
    );
    expect(source).not.toContain("test_alert");
    expect(source).not.toContain("POSTIL_ILERT_CANARY_RUN_ATTEMPT");
    const alertStream = workflow.jobs["alert-stream"];
    expect(alertStream?.needs).toEqual(["smoke", "release-recovery"]);
    expect(alertStream?.["timeout-minutes"]).toBe(24);
    expect(alertStream?.name).toBe("Reconcile and verify iLert webhook delivery");
    expect(alertStream?.if).toContain("always()");
    expect(alertStream?.if).toContain("inputs.reconcile_alert_stream == true");
    expect(alertStream?.if).toContain("needs.smoke.result == 'success'");
    expect(alertStream?.if).toContain("needs.release-recovery.result == 'success'");
    expect(alertStream?.outputs).toMatchObject({
      "alert-submitted": "${{ steps.canary.outputs.alert_submitted }}",
    });
    expect(alertStream?.steps?.map((step) => step.name)).toContain(
      "Preview iLert alert-stream reconciliation",
    );
    expect(alertStream?.steps?.map((step) => step.name)).toContain(
      "Reconcile and verify the run-stable iLert webhook canary",
    );
    expect(alertStream?.steps?.find(
      (step) => step.name === "Preview iLert alert-stream reconciliation",
    )?.run).toContain("timeout 7m");
    expect(alertStream?.steps?.find(
      (step) => step.name === "Reconcile and verify the run-stable iLert webhook canary",
    )?.run).toContain("timeout 13m");
    expect(alertStream?.steps?.find(
      (step) => step.name === "Reconcile and verify the run-stable iLert webhook canary",
    )?.env).toMatchObject({
      POSTIL_ILERT_CANARY_RUN_ID: "${{ github.run_id }}",
      POSTIL_ILERT_RECEIVER_ORIGIN: "https://postil.dev",
    });
    const finalizer = workflow.jobs["alert-stream-finalize"];
    expect(finalizer?.needs).toBe("alert-stream");
    expect(finalizer?.["timeout-minutes"]).toBe(17);
    expect(finalizer?.if).toContain("always()");
    expect(finalizer?.name).toBe("Finalize iLert webhook canary cleanup");
    expect(finalizer?.if).toContain("inputs.reconcile_alert_stream == true");
    expect(finalizer?.if).toContain("needs.alert-stream.result != 'skipped'");
    for (const [result, runs] of [
      ["skipped", false],
      ["failure", true],
      ["cancelled", true],
      ["success", true],
    ] as const) {
      expect(finalizerRunsAfterAlertStream(finalizer?.if, result)).toBe(runs);
    }
    expect(finalizer?.steps?.find(
      (step) => step.name === "Resolve and stabilize the reconstructible iLert canary",
    )?.run).toContain("timeout 12m bun run scripts/reconcile-ilert-alert-stream.ts --finalize-canary");
    expect(finalizer?.steps?.find(
      (step) => step.name === "Resolve and stabilize the reconstructible iLert canary",
    )?.env).toMatchObject({
      POSTIL_ILERT_CANARY_ALERT_SUBMITTED:
        "${{ needs.alert-stream.outputs.alert-submitted }}",
      POSTIL_ILERT_CANARY_RUN_ID: "${{ github.run_id }}",
    });
    const expectScopedSecretLoads = (
      job: typeof alertStream,
      expectedSecrets: string[],
    ) => {
      const scopedSecretLoads = job?.steps?.filter((step) => step.with?.["secret-name"]);
      expect(scopedSecretLoads?.map((step) => step.with?.["secret-name"])).toEqual(expectedSecrets);
      expect(scopedSecretLoads?.every((step) =>
        step.uses === "Infisical/secrets-action@6cd3f7c0e4cc0d2395ee4ef414eb6eeb5d3e73db" &&
        typeof step.with?.["secret-path"] === "string",
      )).toBe(true);
    };
    expectScopedSecretLoads(alertStream, ["ILERT_API_KEY", "ILERT_INTEGRATION_KEY", "POSTIL_ILERT_WEBHOOK_SECRET"]);
    expectScopedSecretLoads(finalizer, ["ILERT_API_KEY", "ILERT_INTEGRATION_KEY"]);
    expect(workflow.jobs.notify?.if).not.toContain("reconcile_alert_stream");
    expect(workflow.jobs.resolve?.if).toContain(
      "needs.smoke.result == 'success'",
    );
    expect(workflow.jobs.resolve?.if).toContain(
      "github.event_name != 'workflow_dispatch'",
    );
    expect(workflow.jobs.resolve?.if).toContain(
      "inputs.reconcile_alert_stream != true",
    );
  });

  test("deploy staging requires the receiver secret before any Fly mutation", async () => {
    const source = await readFile(
      new URL("../.github/workflows/deploy.yml", import.meta.url),
      "utf8",
    );
    const workflow = parse(source) as {
      jobs: {
        deploy: {
          steps: Array<{
            env?: Record<string, string>;
            name?: string;
            run?: string;
          }>;
        };
      };
    };
    const stage = workflow.jobs.deploy.steps.find(
      (step) => step.name === "Stage runtime secrets",
    );
    const stageRun = stage?.run ?? "";
    expect(stageRun).toContain("POSTIL_ILERT_WEBHOOK_SECRET");
    expect(stageRun).toContain("Infisical did not provide POSTIL_ILERT_WEBHOOK_SECRET.");
    expect(stageRun.indexOf("Infisical did not provide POSTIL_ILERT_WEBHOOK_SECRET.")).toBeLessThan(
      stageRun.indexOf("flyctl secrets import --stage"),
    );
    const staged = spawnSync("bash", ["-c", stageRun], {
      encoding: "utf8",
      env: { DATABASE_URL: "postgresql://test", NODE_ENV: "test" } as NodeJS.ProcessEnv,
    });
    expect(staged.status).toBe(1);
    expect(staged.stdout).toContain(
      "Infisical did not provide POSTIL_ILERT_WEBHOOK_SECRET.",
    );
    expect(stage?.env).not.toHaveProperty("POSTIL_ILERT_WEBHOOK_SECRET");
  });

  test("resolves a production failure after manual success and scheduled success", async () => {
    const source = await readFile(
      new URL("../.github/workflows/production-monitor.yml", import.meta.url),
      "utf8",
    );
    const workflow = parse(source) as {
      jobs: {
        resolve: {
          if: string;
          steps: Array<{
            if?: string;
            name?: string;
            uses?: string;
            with?: Record<string, string>;
          }>;
        };
      };
    };
    const resolve = workflow.jobs.resolve;
    expect(resolve.if).toContain("needs.smoke.result == 'success'");
    expect(resolve.if).toContain("github.event_name != 'workflow_dispatch'");
    expect(resolve.if).toContain("inputs.reconcile_alert_stream != true");
    expect(resolve.steps.some((step) => step.name === "Check whether the previous run failed")).toBe(false);
    expect(resolve.steps.find((step) => step.name === "Load alerting secret from Infisical")?.if).toBeUndefined();
    expect(resolve.steps.find((step) => step.name === "Load alerting secret from Infisical")).toMatchObject({
      uses: "Infisical/secrets-action@6cd3f7c0e4cc0d2395ee4ef414eb6eeb5d3e73db",
      with: {
        "secret-name": "ILERT_INTEGRATION_KEY",
        "secret-path": "/postil",
      },
    });
    expect(resolve.steps.find((step) => step.name === "Resolve ilert alert")).toMatchObject({
      uses: "./.github/actions/ilert-event",
    });
  });

  test("enforces monitor health, collection, delivery, failure, and stuck-pass signals", async () => {
    const source = await readFile(
      new URL("../.github/workflows/production-monitor.yml", import.meta.url),
      "utf8",
    );

    expect(
      source.match(/https:\/\/postil\.dev\/api\/health\/monitor/g),
    ).toHaveLength(1);
    expect(source).toContain(
      "--dump-header .cache/monitor-health-headers.out",
    );
    expect(source).toContain(
      "grep -iq '^x-robots-tag: noindex, nofollow' .cache/monitor-health-headers.out",
    );
    expect(source).toContain("monitor_health_failed=0");
    expect(source).toContain('stale_found="${monitor_health_failed}"');
    expect(source).toContain("postil_private_monitor_collection_fresh 1");
    expect(source).toContain("postil_monitor_heartbeat_delivery_fresh 1");
    expect(source).toContain(
      'postil_private_monitor_consecutive_failed_passes" { print $2 }',
    );
    expect(source).toContain(
      '$(printf \'%.0f\' "${monitor_failures:-0}") > 1',
    );
    expect(source).toContain(
      'postil_private_monitor_running_pass_age_seconds" { print $2 }',
    );
    expect(source).toContain(
      '$(printf \'%.0f\' "${monitor_running_age:-0}") > 900',
    );
  });

  test("allows one failed pass and 900 seconds, then fails at the next boundary", async () => {
    const source = await readFile(
      new URL("../.github/workflows/production-monitor.yml", import.meta.url),
      "utf8",
    );
    const policyStart = source.indexOf("            monitor_failures=$(awk");
    const policyEnd = source.indexOf(
      "            review_age=$(grep",
      policyStart,
    );
    expect(policyStart).toBeGreaterThan(-1);
    expect(policyEnd).toBeGreaterThan(policyStart);
    const policy = source
      .slice(policyStart, policyEnd)
      .replace(/^ {12}/gm, "");

    const evaluate = (
      failures: number | null,
      runningAge: number | null,
    ) => {
      const metrics = [
        failures === null
          ? null
          : `postil_private_monitor_consecutive_failed_passes ${failures}`,
        runningAge === null
          ? null
          : `postil_private_monitor_running_pass_age_seconds ${runningAge}`,
      ]
        .filter((line): line is string => line !== null)
        .join("\n");
      const workingDirectory = mkdtempSync(
        join(tmpdir(), "postil-monitor-policy-"),
      );
      const script = `set -euo pipefail
mkdir -p .cache
cat > .cache/metrics.out <<'METRICS'
${metrics}
METRICS
stale_found=0
${policy}
exit "${"${stale_found}"}"
`;
      try {
        return spawnSync("bash", ["-c", script], {
          cwd: workingDirectory,
          encoding: "utf8",
        }).status;
      } finally {
        rmSync(workingDirectory, { recursive: true, force: true });
      }
    };

    expect(evaluate(1, 900)).toBe(0);
    expect(evaluate(2, 900)).toBe(1);
    expect(evaluate(1, 901)).toBe(1);
    expect(evaluate(null, 900)).toBe(1);
    expect(evaluate(1, null)).toBe(1);
  });

  test("collects metrics before failing an unhealthy monitor probe", async () => {
    const source = await readFile(
      new URL("../.github/workflows/production-monitor.yml", import.meta.url),
      "utf8",
    );
    const workflow = parse(source) as {
      jobs: { smoke: { steps: Array<{ name: string; run?: string }> } };
    };
    const run = workflow.jobs.smoke.steps.find(
      (step) => step.name === "Check public endpoints",
    )?.run;
    expect(run).toBeDefined();

    const workingDirectory = mkdtempSync(
      join(tmpdir(), "postil-monitor-workflow-"),
    );
    const metrics = [
      "postil_database_up 1",
      "postil_private_monitor_heartbeat_fresh 1",
      "postil_private_monitor_collection_fresh 1",
      "postil_monitor_heartbeat_delivery_fresh 1",
      "postil_private_monitor_consecutive_failed_passes 0",
      "postil_private_monitor_running_pass_age_seconds 0",
      "postil_oldest_running_review_age_seconds 0",
      "postil_check_run_cleanup_failures_30m 0",
      "postil_operator_alert_failures_current 0",
      "postil_oldest_operator_alert_pending_age_seconds 0",
      "postil_billing_settlement_failures_current 0",
      "postil_oldest_billing_settlement_pending_age_seconds 0",
      "postil_unmatched_billing_provider_events_24h 0",
      "postil_oldest_billing_checkout_open_age_seconds 0",
      "postil_billing_checkout_failures_24h 0",
      ...[
        "operational_failure",
        "scorer_failure",
        "scorer_fallback",
        "model_fallback",
        "invalid_output",
        "failed_job",
      ].map(
        (category) =>
          `postil_review_incidents_30m{category="${category}"} 0`,
      ),
      'postil_oldest_job_age_seconds{status="queued"} 0',
      'postil_oldest_job_age_seconds{status="running"} 0',
    ].join("\n");
    const fakeCurl = `curl() {
  local output_path=/dev/null
  local header_path=""
  local url="${"${!#}"}"
  while (( "$#" )); do
    case "$1" in
      --output) output_path="$2"; shift 2 ;;
      --dump-header) header_path="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  if [[ -n "$header_path" ]]; then
    printf 'HTTP/2 200\\nx-robots-tag: noindex, nofollow\\n' > "$header_path"
  fi
  case "$url" in
    https://postil.dev/api/health/monitor)
      printf '{"ok":false,"monitor":{"process":"up","collection":"stale","heartbeatDelivery":"up"}}\\n' > "$output_path"
      printf '503'
      return 22
      ;;
    https://postil.dev/robots.txt)
      printf 'User-Agent: *\\nAllow: /\\nSitemap: https://postil.dev/sitemap.xml\\n' > "$output_path"
      ;;
    https://postil.dev/about)
      printf '308 https://postil.dev/why-postil'
      ;;
    'https://www.postil.dev/docs?utm_source=monitor')
      printf '308 https://postil.dev/docs?utm_source=monitor'
      ;;
    https://postil.dev/api/health/dependencies)
      printf '{"ok":true}\\n' > "$output_path"
      printf '200'
      ;;
    https://postil.dev/api/metrics)
      printf '%s\\n' '${metrics}' > "$output_path"
      touch metrics-collected
      printf '200'
      ;;
  esac
}
`;

    try {
      const result = spawnSync("bash", ["-c", `${fakeCurl}\n${run}`], {
        cwd: workingDirectory,
        encoding: "utf8",
        env: { ...process.env, METRICS_API_KEY: "test" },
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("Monitor health HTTP status: 503");
      expect(result.stdout).toContain('"collection":"stale"');
      expect(result.stdout).toContain("Full metrics for context:");
      expect(
        await Bun.file(join(workingDirectory, "metrics-collected")).exists(),
      ).toBe(true);
    } finally {
      rmSync(workingDirectory, { recursive: true, force: true });
    }
  });
});

function finalizerRunsAfterAlertStream(condition: string | undefined, result: string): boolean {
  return Boolean(
    condition?.includes("always()") &&
      condition.includes("inputs.reconcile_alert_stream == true") &&
      (result !== "skipped" || !condition.includes("needs.alert-stream.result != 'skipped'")),
  );
}
