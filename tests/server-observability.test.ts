import { describe, expect, test } from "bun:test";
import type { LogRecordExporter, ReadableLogRecord } from "@opentelemetry/sdk-logs";

import {
  sanitizeOperationalError,
  ServerObservability,
} from "@/lib/server-observability";
import type { OperationalModelIncidentClassification } from "@/lib/envelope";

const TOKEN = "phc_test_project_token_abcdefghijklmnopqrstuvwxyz";
const NOW = Date.parse("2026-07-13T12:00:00.000Z");

describe("server operational observability", () => {
  test("sends only a scrubbed exception envelope for hostile errors", async () => {
    const requests: string[] = [];
    const observability = new ServerObservability({
      processGroup: "worker",
      environment: {
        POSTHOG_ERROR_CAPTURE: "1",
        POSTHOG_PROJECT_TOKEN: TOKEN,
        NEXT_PUBLIC_POSTHOG_HOST: "https://eu.i.posthog.com",
        POSTIL_RELEASE_SHA: "0123456789abcdef0123456789abcdef01234567",
        NODE_ENV: "production",
      },
      now: () => NOW,
      posthogFetch: async (_url, options) => {
        requests.push(String(options.body ?? ""));
        return successfulPostHogResponse();
      },
    });

    const error = new Error(
      "email=private@example.test cookie=session-secret repo=secret/repo prompt=raw-prompt diff=raw-diff code=raw-code finding=raw-finding model=raw-output",
    );
    error.name = "HostileSecretError";
    error.stack = [
      `${error.name}: ${error.message}`,
      "    at secretFunction (/home/ubuntu/Projects/private/src/worker/review.ts:42:9)",
      "    at bearerSecret (/home/ubuntu/Projects/private/node_modules/pkg/index.js:5:2)",
    ].join("\n");

    observability.reportFailure("job_permanently_failed", error);
    await observability.shutdown();

    expect(requests.length).toBeGreaterThan(0);
    const outbound = requests.join("\n");
    expect(outbound).toContain("job_permanently_failed");
    expect(outbound).toContain("src/worker/review.ts");
    for (const sentinel of [
      "private@example.test",
      "session-secret",
      "secret/repo",
      "raw-prompt",
      "raw-diff",
      "raw-code",
      "raw-finding",
      "raw-output",
      "HostileSecretError",
      "secretFunction",
      "/home/ubuntu/Projects/private",
      "node_modules",
    ]) {
      expect(outbound).not.toContain(sentinel);
    }
  });

  test("exports a fixed log schema without caller or error data", async () => {
    const exporter = new RetainingLogExporter();
    const observability = new ServerObservability({
      processGroup: "web",
      environment: {
        POSTHOG_LOG_CAPTURE: "1",
        POSTHOG_PROJECT_TOKEN: TOKEN,
        POSTHOG_LOG_INFO_SAMPLE_RATE: "1",
        POSTIL_RELEASE_SHA: "0123456",
        NODE_ENV: "production",
      },
      now: () => NOW,
      logExporter: exporter,
    });

    observability.reportState("worker_started");
    observability.reportFailure(
      "web_request_failed",
      new Error("Authorization: Bearer raw-secret and private@example.test"),
    );
    await observability.shutdown();

    const records = exporter.getFinishedLogRecords();
    expect(records).toHaveLength(2);
    expect(records.map((record) => record.body)).toEqual([
      "postil.worker.started",
      "postil.web.request.failed",
    ]);
    expect(records.map((record) => record.attributes)).toEqual([
      { "event.name": "postil.worker.started", outcome: "success" },
      {
        "event.name": "postil.web.request.failed",
        outcome: "failure",
        "failure.class": "web_request_failed",
      },
    ]);
    expect(records[0]?.resource.attributes).toMatchObject({
      "service.name": "postil-web",
      "service.version": "0123456",
      "deployment.environment": "production",
      "process.group": "web",
    });
    expect(JSON.stringify(records)).not.toContain("raw-secret");
    expect(JSON.stringify(records)).not.toContain("private@example.test");
  });

  test("exports only fixed model-incident classifications from hostile objects", async () => {
    const requests: string[] = [];
    const exporter = new RetainingLogExporter();
    const hostile = "private@example.test raw-provider raw-model raw-repo raw-finding";
    const recoveredIncident = {
      phase: "scorer",
      category: "invalidOutput",
      recovered: true,
      recovery: "repair",
      source: "model_incident",
      provider: hostile,
      model: hostile,
      repository: hostile,
      finding: hostile,
    } as OperationalModelIncidentClassification;
    const unrecoveredIncident = {
      phase: "review",
      category: "providerError",
      recovered: false,
      source: "provider_sentinel",
      path: hostile,
      title: hostile,
      body: hostile,
    } as OperationalModelIncidentClassification;
    const observability = new ServerObservability({
      processGroup: "worker",
      environment: {
        POSTHOG_ERROR_CAPTURE: "1",
        POSTHOG_LOG_CAPTURE: "1",
        POSTHOG_PROJECT_TOKEN: TOKEN,
        POSTHOG_LOG_WARN_SAMPLE_RATE: "1",
      },
      now: () => NOW,
      posthogFetch: async (_url, options) => {
        requests.push(String(options.body ?? ""));
        return successfulPostHogResponse();
      },
      logExporter: exporter,
    });

    observability.reportModelIncident(recoveredIncident);
    observability.reportModelIncident(unrecoveredIncident);
    observability.reportModelIncident({
      phase: hostile,
      category: hostile,
      recovered: false,
      source: hostile,
    } as unknown as OperationalModelIncidentClassification);
    for (const forged of [
      {
        phase: "scorer",
        category: "operational",
        recovered: false,
        source: "provider_sentinel",
      },
      {
        phase: "review",
        category: "providerError",
        recovered: true,
        recovery: "repair",
        source: "provider_sentinel",
      },
      {
        phase: "review",
        category: "operational",
        recovered: false,
        source: "model_incident",
      },
    ]) {
      observability.reportModelIncident(
        forged as unknown as OperationalModelIncidentClassification,
      );
    }
    await observability.shutdown();

    expect(postHogBatchSize(requests)).toBe(2);
    const outbound = requests.join("\n");
    expect(outbound).toContain("postil_model_incident");
    expect(outbound).toContain("invalidOutput");
    expect(outbound).toContain("providerError");
    expect(outbound).not.toContain(hostile);
    expect(exporter.records.map((record) => record.attributes)).toEqual([
      {
        "event.name": "postil.model.incident",
        outcome: "recovered",
        "incident.phase": "scorer",
        "incident.category": "invalidOutput",
        "incident.recovered": true,
        "incident.recovery": "repair",
        "incident.source": "model_incident",
      },
      {
        "event.name": "postil.model.incident",
        outcome: "failure",
        "incident.phase": "review",
        "incident.category": "providerError",
        "incident.recovered": false,
        "incident.source": "provider_sentinel",
      },
    ]);
    expect(JSON.stringify(exporter.records)).not.toContain(hostile);
  });

  test("does no network or exporter work while both features are disabled", async () => {
    let fetches = 0;
    const exporter = new RetainingLogExporter();
    const observability = new ServerObservability({
      processGroup: "worker",
      environment: {
        POSTHOG_ERROR_CAPTURE: "0",
        POSTHOG_LOG_CAPTURE: "0",
        POSTHOG_PROJECT_TOKEN: TOKEN,
      },
      posthogFetch: async () => {
        fetches += 1;
        return successfulPostHogResponse();
      },
      logExporter: exporter,
    });

    observability.reportFailure("worker_boot_failed", new Error("must stay local"));
    observability.reportState("worker_started");
    await observability.shutdown();

    expect(fetches).toBe(0);
    expect(exporter.getFinishedLogRecords()).toEqual([]);
  });

  test("deduplicates exceptions and enforces hard exception and log caps", async () => {
    const requests: string[] = [];
    const exporter = new RetainingLogExporter();
    const observability = new ServerObservability({
      processGroup: "worker",
      environment: {
        POSTHOG_ERROR_CAPTURE: "1",
        POSTHOG_LOG_CAPTURE: "1",
        POSTHOG_PROJECT_TOKEN: TOKEN,
        POSTHOG_ERROR_MAX_PER_HOUR: "2",
        POSTHOG_LOG_MAX_PER_MINUTE: "2",
      },
      now: () => NOW,
      posthogFetch: async (_url, options) => {
        requests.push(String(options.body ?? ""));
        return successfulPostHogResponse();
      },
      logExporter: exporter,
    });

    for (const line of [1, 1, 2, 3]) {
      const error = new Error("private details");
      error.stack = `Error: private details\n    at privateName (/app/src/worker/runner.ts:${line}:1)`;
      observability.reportFailure("job_permanently_failed", error);
    }
    await observability.shutdown();

    expect(postHogBatchSize(requests)).toBe(2);
    expect(exporter.getFinishedLogRecords()).toHaveLength(2);
  });

  test("samples warning logs deterministically by event, process, and minute", async () => {
    const first = await sampledWarningMinutes();
    const second = await sampledWarningMinutes();

    expect(first).toEqual(second);
    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThan(20);
  });

  test("sanitizes non-errors and absolute stack paths", () => {
    expect(sanitizeOperationalError("worker_boot_failed", "raw secret").stack).toBe(
      "PostilOperationalError: worker_boot_failed",
    );
    const error = new Error("raw secret");
    error.stack = "Error: raw secret\n    at named (/srv/postil/src/worker/index.ts:8:3)";
    expect(sanitizeOperationalError("worker_boot_failed", error).stack).toBe(
      "PostilOperationalError: worker_boot_failed\n    at src/worker/index.ts:8:3",
    );
  });
});

function successfulPostHogResponse() {
  return {
    status: 200,
    text: async () => "ok",
    json: async () => ({ status: "ok" }),
    headers: { get: () => null },
  };
}

function postHogBatchSize(requests: string[]): number {
  return requests.reduce((total, body) => {
    const payload = JSON.parse(body) as { batch?: unknown[] };
    return total + (payload.batch?.length ?? 0);
  }, 0);
}

async function sampledWarningMinutes(): Promise<number[]> {
  const exporter = new RetainingLogExporter();
  let now = NOW;
  const observability = new ServerObservability({
    processGroup: "worker",
    environment: {
      POSTHOG_LOG_CAPTURE: "1",
      POSTHOG_PROJECT_TOKEN: TOKEN,
      POSTHOG_LOG_WARN_SAMPLE_RATE: "0.5",
      POSTHOG_LOG_MAX_PER_MINUTE: "10",
    },
    now: () => now,
    logExporter: exporter,
  });
  for (let minute = 0; minute < 20; minute += 1) {
    now = NOW + minute * 60_000;
    observability.reportWarning("job_retrying");
  }
  await observability.shutdown();
  return exporter.records.map((record) => Math.floor(Number(record.hrTime[0]) / 60));
}

class RetainingLogExporter implements LogRecordExporter {
  readonly records: ReadableLogRecord[] = [];

  export(
    records: ReadableLogRecord[],
    callback: Parameters<LogRecordExporter["export"]>[1],
  ): void {
    this.records.push(...records);
    callback({ code: 0 });
  }

  async shutdown(): Promise<void> {}

  async forceFlush(): Promise<void> {}

  getFinishedLogRecords(): ReadableLogRecord[] {
    return this.records;
  }
}
