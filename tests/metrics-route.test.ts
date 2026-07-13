import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const TOKEN = "metrics-route-test-token";

let queryShouldThrow = false;
let getPoolCalls = 0;
let queryCalls = 0;

mock.module("@/lib/db", () => ({
  getPool: () => {
    getPoolCalls += 1;
    return {
      query: async (text: string) => {
        queryCalls += 1;
        if (queryShouldThrow) throw new Error("database unavailable");
        return queryResponse(text);
      },
    };
  },
}));

const { GET } = await import("@/app/api/metrics/route");

beforeEach(() => {
  process.env.METRICS_TOKEN = TOKEN;
  queryShouldThrow = false;
  getPoolCalls = 0;
  queryCalls = 0;
});

afterEach(() => {
  delete process.env.METRICS_TOKEN;
  delete process.env.METRICS_API_KEY;
});

function queryResponse(text: string): { rows: Array<Record<string, string | null>> } {
  const sql = text.replace(/\s+/g, " ");
  if (sql.includes("pg_database_size(current_database())")) {
    return {
      rows: [
        {
          database_size_bytes: "123456",
          active_sessions: "2",
          queue_depth: "7",
          active_installations: "3",
          suspended_installations: "1",
          enabled_repositories: "12",
          disabled_repositories: "4",
          reviews_queued_24h: "6",
          reviews_started_24h: "3",
          reviews_finished_24h: "2",
          webhook_deliveries_24h: "9",
          watchdog_kills: "5",
        },
      ],
    };
  }
  if (sql.includes("WHERE queued_at >= now() - interval '24 hours'")) {
    return { rows: [{ status: "completed", count: "6" }] };
  }
  if (sql.includes("FROM reviews GROUP BY status")) {
    return {
      rows: [
        { status: "queued", count: "5" },
        { status: "completed", count: "4" },
      ],
    };
  }
  if (sql.includes("count(*) FILTER (WHERE status = 'completed')")) {
    return { rows: [{ completed: "4", silent: "1" }] };
  }
  if (sql.includes("FROM webhook_deliveries") && sql.includes("GROUP BY event")) {
    return {
      rows: [
        { event: "issues", count: "2" },
        { event: "pull_request", count: "7" },
      ],
    };
  }
  if (sql.includes("FROM jobs") && sql.includes("GROUP BY kind, status")) {
    return {
      rows: [
        { kind: "respond", status: "failed", count: "1" },
        { kind: "review", status: "queued", count: "7" },
        { kind: "review", status: "running", count: "2" },
      ],
    };
  }
  if (sql.includes("WHERE status IN ('queued', 'running')")) {
    return {
      rows: [
        { status: "queued", age_seconds: "300" },
        { status: "running", age_seconds: "45" },
      ],
    };
  }
  if (sql.includes("MIN(started_at)") && sql.includes("status = 'running'")) {
    return { rows: [{ age_seconds: "720" }] };
  }
  if (sql.includes("FROM usage_events")) {
    return {
      rows: [
        {
          model: 'qwen/"coder"',
          prompt_tokens: "1000",
          completion_tokens: "250",
        },
      ],
    };
  }
  if (sql.includes("AS operational_failure") && sql.includes("AS scorer_fallback")) {
    expect(sql).toContain("jsonb_array_elements");
    expect(sql).toContain("modelIncidents");
    expect(sql).not.toContain("JOIN review_logs");
    expect(sql).toContain(".postil/provider");
    expect(sql).toContain(".postil/model-output");
    expect(sql).toContain("Hosted inference allowance is unavailable or fully reserved.");
    expect(sql).toContain("run_after >= now() - interval '30 minutes'");
    return {
      rows: [
        {
          operational_failure: "1",
          scorer_failure: "2",
          scorer_fallback: "3",
          model_fallback: "4",
          invalid_output: "5",
          failed_job: "6",
        },
      ],
    };
  }
  throw new Error(`unexpected metrics query: ${text}`);
}

function metricsRequest(token = TOKEN): Request {
  return new Request("https://postil.dev/api/metrics", {
    headers: { authorization: `Bearer ${token}` },
  });
}

describe("/api/metrics", () => {
  test("keeps protected disabled behavior when no metrics token is configured", async () => {
    delete process.env.METRICS_TOKEN;

    const response = await GET(metricsRequest());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "metrics disabled: METRICS_TOKEN is not configured",
    });
    expect(getPoolCalls).toBe(0);
    expect(queryCalls).toBe(0);
  });

  test("keeps bearer auth behavior before collecting database metrics", async () => {
    const response = await GET(metricsRequest("wrong-token"));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(getPoolCalls).toBe(0);
    expect(queryCalls).toBe(0);
  });

  test("accepts the legacy METRICS_API_KEY env name", async () => {
    delete process.env.METRICS_TOKEN;
    process.env.METRICS_API_KEY = TOKEN;

    const response = await GET(metricsRequest());
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).toContain("# TYPE postil_database_up gauge\npostil_database_up 1\n");
    expect(getPoolCalls).toBe(1);
  });

  test("emits activity and operations metrics when the DB is reachable", async () => {
    const response = await GET(metricsRequest());
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/plain; version=0.0.4; charset=utf-8",
    );
    expect(text).toContain("# TYPE postil_database_up gauge\npostil_database_up 1\n");
    expect(text).toContain("postil_database_size_bytes 123456");
    expect(text).toContain("postil_sessions_active 2");
    expect(text).toContain("postil_queue_depth 7");
    expect(text).toContain('postil_installations_current{state="active"} 3');
    expect(text).toContain('postil_installations_current{state="suspended"} 1');
    expect(text).toContain('postil_repositories_current{enabled="true"} 12');
    expect(text).toContain('postil_repositories_current{enabled="false"} 4');
    expect(text).toContain('postil_reviews_total{status="queued"} 5');
    expect(text).toContain('postil_reviews_total{status="running"} 0');
    expect(text).toContain('postil_reviews_24h{status="completed"} 6');
    expect(text).toContain('postil_review_activity_24h{event="queued"} 6');
    expect(text).toContain('postil_review_activity_24h{event="started"} 3');
    expect(text).toContain('postil_review_activity_24h{event="finished"} 2');
    expect(text).toContain("postil_silence_rate 0.2500");
    expect(text).toContain("postil_watchdog_kills_total 5");
    expect(text).toContain("postil_webhook_deliveries_24h 9");
    expect(text).toContain('postil_webhook_deliveries_24h_by_event{event="pull_request"} 7');
    expect(text).toContain('postil_jobs_current{kind="review",status="queued"} 7');
    expect(text).toContain('postil_jobs_current{kind="respond",status="failed"} 1');
    expect(text).toContain('postil_oldest_job_age_seconds{status="queued"} 300');
    expect(text).toContain('postil_oldest_job_age_seconds{status="running"} 45');
    expect(text).toContain("postil_oldest_running_review_age_seconds 720");
    expect(text).toContain(
      'postil_usage_tokens_total{model="qwen/\\"coder\\"",type="prompt"} 1000',
    );
    expect(text).toContain(
      'postil_usage_tokens_total{model="qwen/\\"coder\\"",type="completion"} 250',
    );
    expect(text).toContain(
      'postil_review_incidents_30m{category="operational_failure"} 1',
    );
    expect(text).toContain('postil_review_incidents_30m{category="scorer_failure"} 2');
    expect(text).toContain('postil_review_incidents_30m{category="scorer_fallback"} 3');
    expect(text).toContain('postil_review_incidents_30m{category="model_fallback"} 4');
    expect(text).toContain('postil_review_incidents_30m{category="invalid_output"} 5');
    expect(text).toContain('postil_review_incidents_30m{category="failed_job"} 6');
    expect(getPoolCalls).toBe(1);
    expect(queryCalls).toBe(10);
  });

  test("keeps the scrape successful and reports database down when DB access fails", async () => {
    queryShouldThrow = true;

    const response = await GET(metricsRequest());
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).toContain("# TYPE postil_database_up gauge\npostil_database_up 0\n");
    expect(text).not.toContain("postil_database_size_bytes");
    expect(text).not.toContain("postil_queue_depth");
    expect(getPoolCalls).toBe(1);
    expect(queryCalls).toBe(10);
  });
});
