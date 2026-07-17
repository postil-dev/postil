import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { Pool } from "pg";

import { runWebhookRedeliveryPass } from "@/lib/github/webhook-redelivery";

const TEST_URL = process.env.POSTIL_TEST_DATABASE_URL;
const describeDb = TEST_URL ? describe : describe.skip;
const NOW = new Date("2026-07-17T12:00:00.000Z");
const FAILED_AT = "2026-07-17T11:50:00.000Z";

interface DeliveryFixture {
  id: number;
  guid: string;
  delivered_at: string;
  redelivery: boolean;
  status: string;
  status_code: number | null;
  event: string;
}

function failedDelivery(overrides: Partial<DeliveryFixture> = {}): DeliveryFixture {
  return {
    id: 101,
    guid: "failure-guid",
    delivered_at: FAILED_AT,
    redelivery: false,
    status: "timed out",
    status_code: null,
    event: "pull_request",
    ...overrides,
  };
}

function page(
  deliveries: DeliveryFixture[],
  headers: Record<string, string> = {},
): Response {
  return Response.json(deliveries, {
    headers: {
      "x-ratelimit-remaining": "5000",
      "x-ratelimit-reset": String(Math.floor(NOW.getTime() / 1_000) + 3_600),
      ...headers,
    },
  });
}

function fetchQueue(
  responses: Array<Response | Error>,
  calls: Array<{ url: string; method: string }>,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
    });
    const next = responses.shift();
    if (next === undefined) throw new Error("unexpected fetch");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
}

describeDb("GitHub App webhook redelivery", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_URL, max: 8 });
    const dir = join(import.meta.dir, "..", "drizzle");
    const files = (await readdir(dir)).filter((file) => file.endsWith(".sql")).sort();
    for (const file of files) {
      const sqlText = await readFile(join(dir, file), "utf8");
      for (const statement of sqlText.split("--> statement-breakpoint")) {
        const trimmed = statement.trim();
        if (!trimmed) continue;
        try {
          await pool.query(trimmed);
        } catch (error) {
          const code = (error as { code?: string }).code;
          if (code !== "42P07" && code !== "42710") throw error;
        }
      }
    }
  });

  beforeEach(async () => {
    await pool.query(
      "TRUNCATE github_webhook_delivery_recoveries, github_webhook_redelivery_state",
    );
  });

  afterAll(async () => {
    await pool?.end();
  });

  test("redelivers a server-down delivery once and records its successful outcome", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const first = await runWebhookRedeliveryPass(pool, {
      now: NOW,
      owner: "worker-a",
      appJwt: "test-jwt",
      fetchImpl: fetchQueue([page([failedDelivery()]), new Response(null, { status: 202 })], calls),
    });

    expect(first.accepted).toBe(1);
    expect(calls.map((call) => call.method)).toEqual(["GET", "POST"]);

    const secondCalls: Array<{ url: string; method: string }> = [];
    const second = await runWebhookRedeliveryPass(pool, {
      now: new Date(NOW.getTime() + 60_000),
      owner: "worker-b",
      appJwt: "test-jwt",
      fetchImpl: fetchQueue([page([failedDelivery()])], secondCalls),
    });
    expect(second.requested).toBe(0);
    expect(secondCalls.map((call) => call.method)).toEqual(["GET"]);

    const receipt = await pool.query<{
      request_attempts: number;
      request_state: string;
      request_status_code: number;
    }>(
      `SELECT request_attempts, request_state, request_status_code
         FROM github_webhook_delivery_recoveries
        WHERE delivery_id = '101'`,
    );
    expect(receipt.rows[0]).toEqual({
      request_attempts: 1,
      request_state: "accepted",
      request_status_code: 202,
    });
  });

  test("links a later successful redelivery and does not retry the original failure", async () => {
    await pool.query(
      `INSERT INTO github_webhook_delivery_recoveries
         (delivery_id, delivery_guid, delivered_at, event, redelivery, outcome,
          request_state, request_attempts, request_status_code)
       VALUES ('101', 'failure-guid', $1, 'pull_request', false, 'failure',
               'accepted', 1, 202)`,
      [FAILED_AT],
    );
    const calls: Array<{ url: string; method: string }> = [];
    const successfulRedelivery = failedDelivery({
      id: 102,
      delivered_at: "2026-07-17T11:55:00.000Z",
      redelivery: true,
      status: "OK",
      status_code: 204,
    });
    const result = await runWebhookRedeliveryPass(pool, {
      now: NOW,
      owner: "worker-a",
      appJwt: "test-jwt",
      fetchImpl: fetchQueue([page([successfulRedelivery, failedDelivery()])], calls),
    });

    expect(result.recovered).toBe(1);
    expect(result.requested).toBe(0);
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
    const receipt = await pool.query<{ request_state: string; recovery_delivery_id: string }>(
      `SELECT request_state, recovery_delivery_id
         FROM github_webhook_delivery_recoveries
        WHERE delivery_id = '101'`,
    );
    expect(receipt.rows[0]).toEqual({
      request_state: "recovered",
      recovery_delivery_id: "102",
    });
  });

  test("records a pending delivery without treating it as a failed attempt", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const result = await runWebhookRedeliveryPass(pool, {
      now: NOW,
      owner: "worker-a",
      appJwt: "test-jwt",
      fetchImpl: fetchQueue(
        [page([failedDelivery({ status: "Pending", status_code: null })])],
        calls,
      ),
    });
    expect(result.requested).toBe(0);
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
    const row = await pool.query<{ outcome: string }>(
      "SELECT outcome FROM github_webhook_delivery_recoveries WHERE delivery_id = '101'",
    );
    expect(row.rows[0]?.outcome).toBe("pending");
  });

  test("retries one ambiguous timeout after the reconciliation delay and then stops", async () => {
    const firstCalls: Array<{ url: string; method: string }> = [];
    const first = await runWebhookRedeliveryPass(pool, {
      now: NOW,
      owner: "worker-a",
      appJwt: "test-jwt",
      fetchImpl: fetchQueue(
        [page([failedDelivery()]), new Error("simulated timeout")],
        firstCalls,
      ),
    });
    expect(first.retryable).toBe(1);

    const secondCalls: Array<{ url: string; method: string }> = [];
    const second = await runWebhookRedeliveryPass(pool, {
      now: new Date(NOW.getTime() + 11 * 60_000),
      owner: "worker-b",
      appJwt: "test-jwt",
      fetchImpl: fetchQueue([page([failedDelivery()]), new Response(null, { status: 202 })], secondCalls),
    });
    expect(second.accepted).toBe(1);

    const receipt = await pool.query<{ request_attempts: number; request_state: string }>(
      `SELECT request_attempts, request_state
         FROM github_webhook_delivery_recoveries
        WHERE delivery_id = '101'`,
    );
    expect(receipt.rows[0]).toEqual({ request_attempts: 2, request_state: "accepted" });
  });

  test("caps ambiguous attempts across delivery ids that share a GUID", async () => {
    await pool.query(
      `INSERT INTO github_webhook_delivery_recoveries
         (delivery_id, delivery_guid, delivered_at, event, redelivery, outcome,
          request_state, request_attempts, last_requested_at)
       VALUES
         ('101', 'failure-guid', '2026-07-17T11:40:00Z', 'pull_request', false,
          'failure', 'exhausted', 2, '2026-07-17T11:42:00Z'),
         ('102', 'failure-guid', '2026-07-17T11:45:00Z', 'pull_request', true,
          'failure', 'retryable', 1, '2026-07-17T11:47:00Z')`,
    );
    const calls: Array<{ url: string; method: string }> = [];
    const newestFailure = failedDelivery({
      id: 103,
      delivered_at: "2026-07-17T11:50:00.000Z",
      redelivery: true,
    });
    const result = await runWebhookRedeliveryPass(pool, {
      now: NOW,
      owner: "worker-a",
      appJwt: "test-jwt",
      fetchImpl: fetchQueue([page([newestFailure])], calls),
    });

    expect(result.requested).toBe(0);
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
    const attempts = await pool.query<{ attempts: string }>(
      `SELECT sum(request_attempts)::text AS attempts
         FROM github_webhook_delivery_recoveries
        WHERE delivery_guid = 'failure-guid'`,
    );
    expect(attempts.rows[0]?.attempts).toBe("3");
  });

  test("exhausts a repeatedly rejected delivery after two bounded attempts", async () => {
    const firstCalls: Array<{ url: string; method: string }> = [];
    const first = await runWebhookRedeliveryPass(pool, {
      now: NOW,
      owner: "worker-a",
      appJwt: "test-jwt",
      fetchImpl: fetchQueue(
        [page([failedDelivery()]), new Response(null, { status: 503 })],
        firstCalls,
      ),
    });
    expect(first.retryable).toBe(1);

    const later = new Date(NOW.getTime() + 11 * 60_000);
    const secondCalls: Array<{ url: string; method: string }> = [];
    const second = await runWebhookRedeliveryPass(pool, {
      now: later,
      owner: "worker-b",
      appJwt: "test-jwt",
      fetchImpl: fetchQueue(
        [page([failedDelivery()]), new Response(null, { status: 503 })],
        secondCalls,
      ),
    });
    expect(second.exhausted).toBe(1);

    const thirdCalls: Array<{ url: string; method: string }> = [];
    const third = await runWebhookRedeliveryPass(pool, {
      now: new Date(later.getTime() + 11 * 60_000),
      owner: "worker-c",
      appJwt: "test-jwt",
      fetchImpl: fetchQueue([page([failedDelivery()])], thirdCalls),
    });
    expect(third.requested).toBe(0);
    expect(thirdCalls.map((call) => call.method)).toEqual(["GET"]);
  });

  test("persists a bounded pagination cursor and resumes it on the next pass", async () => {
    const next = "https://api.github.com/app/hook/deliveries?per_page=100&cursor=next-page";
    const firstCalls: Array<{ url: string; method: string }> = [];
    const first = await runWebhookRedeliveryPass(pool, {
      now: NOW,
      owner: "worker-a",
      appJwt: "test-jwt",
      maxPages: 1,
      maxRedeliveries: 0,
      fetchImpl: fetchQueue([page([failedDelivery()], { link: `<${next}>; rel="next"` })], firstCalls),
    });
    expect(first.pages).toBe(1);

    const secondCalls: Array<{ url: string; method: string }> = [];
    await runWebhookRedeliveryPass(pool, {
      now: new Date(NOW.getTime() + 60_000),
      owner: "worker-b",
      appJwt: "test-jwt",
      maxPages: 1,
      maxRedeliveries: 0,
      fetchImpl: fetchQueue([page([])], secondCalls),
    });
    expect(secondCalls[0]?.url).toContain("cursor=next-page");
    const state = await pool.query<{ cursor: string | null }>(
      "SELECT cursor FROM github_webhook_redelivery_state WHERE id = 1",
    );
    expect(state.rows[0]?.cursor).toBeNull();
  });

  test("caps caller overrides below the scan lease budget", async () => {
    const deliveries = Array.from({ length: 12 }, (_, index) =>
      failedDelivery({ id: 1_000 + index, guid: `failure-guid-${index}` })
    );
    const requestCalls: Array<{ url: string; method: string }> = [];
    const requested = await runWebhookRedeliveryPass(pool, {
      now: NOW,
      owner: "worker-a",
      appJwt: "test-jwt",
      maxRedeliveries: 25,
      fetchImpl: fetchQueue(
        [page(deliveries), ...Array.from({ length: 10 }, () => new Response(null, { status: 202 }))],
        requestCalls,
      ),
    });
    expect(requested.requested).toBe(10);
    expect(requestCalls.filter((entry) => entry.method === "POST")).toHaveLength(10);

    await pool.query(
      "TRUNCATE github_webhook_delivery_recoveries, github_webhook_redelivery_state",
    );
    const pageCalls: Array<{ url: string; method: string }> = [];
    const link = (cursor: string) =>
      `<https://api.github.com/app/hook/deliveries?per_page=100&cursor=${cursor}>; rel="next"`;
    const paged = await runWebhookRedeliveryPass(pool, {
      now: NOW,
      owner: "worker-b",
      appJwt: "test-jwt",
      maxPages: 10,
      maxRedeliveries: 0,
      fetchImpl: fetchQueue(
        [
          page([failedDelivery({ id: 2_001 })], { link: link("page-2") }),
          page([failedDelivery({ id: 2_002 })], { link: link("page-3") }),
          page([failedDelivery({ id: 2_003 })], { link: link("page-4") }),
        ],
        pageCalls,
      ),
    });
    expect(paged.pages).toBe(3);
    expect(pageCalls).toHaveLength(3);
    const state = await pool.query<{ cursor: string | null }>(
      "SELECT cursor FROM github_webhook_redelivery_state WHERE id = 1",
    );
    expect(state.rows[0]?.cursor).toBe("page-4");
  });

  test("reconciles from the head before retrying an ambiguous request", async () => {
    await pool.query(
      `INSERT INTO github_webhook_redelivery_state (id, cursor, sweep_started_at)
       VALUES (1, 'deep-page', $1)`,
      [new Date(NOW.getTime() - 30 * 60_000)],
    );
    await pool.query(
      `INSERT INTO github_webhook_delivery_recoveries
         (delivery_id, delivery_guid, delivered_at, event, redelivery, outcome,
          request_state, request_attempts, next_attempt_at, last_requested_at)
       VALUES ('101', 'failure-guid', $1, 'pull_request', false, 'failure',
               'retryable', 1, $2, $3)`,
      [
        FAILED_AT,
        new Date(NOW.getTime() - 5 * 60_000),
        new Date(NOW.getTime() - 15 * 60_000),
      ],
    );

    const resumedCalls: Array<{ url: string; method: string }> = [];
    const resumed = await runWebhookRedeliveryPass(pool, {
      now: NOW,
      owner: "worker-a",
      appJwt: "test-jwt",
      fetchImpl: fetchQueue([page([])], resumedCalls),
    });
    expect(resumed.requested).toBe(0);
    expect(resumedCalls.map((entry) => entry.method)).toEqual(["GET"]);
    expect(resumedCalls[0]?.url).toContain("cursor=deep-page");

    const successfulRedelivery = failedDelivery({
      id: 102,
      delivered_at: "2026-07-17T11:55:00.000Z",
      redelivery: true,
      status: "OK",
      status_code: 204,
    });
    const headCalls: Array<{ url: string; method: string }> = [];
    const reconciled = await runWebhookRedeliveryPass(pool, {
      now: new Date(NOW.getTime() + 60_000),
      owner: "worker-b",
      appJwt: "test-jwt",
      fetchImpl: fetchQueue([page([successfulRedelivery, failedDelivery()])], headCalls),
    });
    expect(reconciled.recovered).toBe(1);
    expect(reconciled.requested).toBe(0);
    expect(headCalls.map((entry) => entry.method)).toEqual(["GET"]);
    expect(headCalls[0]?.url).not.toContain("cursor=");
  });

  test("rejects pagination outside the configured GitHub API origin", async () => {
    await pool.query(
      `INSERT INTO github_webhook_redelivery_state (id, cursor)
       VALUES (1, 'persisted-cursor')`,
    );
    let category: string | undefined;
    try {
      await runWebhookRedeliveryPass(pool, {
        now: NOW,
        owner: "worker-a",
        appJwt: "test-jwt",
        fetchImpl: fetchQueue(
          [
            page([failedDelivery()], {
              link: '<https://example.invalid/app/hook/deliveries?cursor=stolen>; rel="next"',
            }),
          ],
          [],
        ),
      });
    } catch (error) {
      category = (error as { category?: string }).category;
    }
    expect(category).toBe("invalid_pagination");
    const state = await pool.query<{ cursor: string | null }>(
      "SELECT cursor FROM github_webhook_redelivery_state WHERE id = 1",
    );
    expect(state.rows[0]?.cursor).toBeNull();
  });

  test("resets a persisted cursor rejected by GitHub", async () => {
    await pool.query(
      `INSERT INTO github_webhook_redelivery_state (id, cursor, sweep_started_at)
       VALUES (1, 'expired-cursor', $1)`,
      [new Date(NOW.getTime() - 60_000)],
    );
    let category: string | undefined;
    try {
      await runWebhookRedeliveryPass(pool, {
        now: NOW,
        owner: "worker-a",
        appJwt: "test-jwt",
        fetchImpl: fetchQueue([new Response(null, { status: 422 })], []),
      });
    } catch (error) {
      category = (error as { category?: string }).category;
    }
    expect(category).toBe("invalid_cursor");
    const state = await pool.query<{ cursor: string | null; lease_owner: string | null }>(
      "SELECT cursor, lease_owner FROM github_webhook_redelivery_state WHERE id = 1",
    );
    expect(state.rows[0]).toEqual({ cursor: null, lease_owner: null });
  });

  test("accepts pagination under a GitHub Enterprise API path prefix", async () => {
    const previousApiUrl = process.env.GITHUB_API_URL;
    process.env.GITHUB_API_URL = "https://ghe.example/api/v3";
    try {
      const calls: Array<{ url: string; method: string }> = [];
      const next =
        "https://ghe.example/api/v3/app/hook/deliveries?per_page=100&cursor=enterprise-next";
      await runWebhookRedeliveryPass(pool, {
        now: NOW,
        owner: "worker-a",
        appJwt: "test-jwt",
        maxPages: 1,
        maxRedeliveries: 0,
        fetchImpl: fetchQueue(
          [page([failedDelivery()], { link: `<${next}>; rel="next"` })],
          calls,
        ),
      });
      expect(calls[0]?.url).toStartWith(
        "https://ghe.example/api/v3/app/hook/deliveries?",
      );
      const state = await pool.query<{ cursor: string | null }>(
        "SELECT cursor FROM github_webhook_redelivery_state WHERE id = 1",
      );
      expect(state.rows[0]?.cursor).toBe("enterprise-next");
    } finally {
      if (previousApiUrl === undefined) delete process.env.GITHUB_API_URL;
      else process.env.GITHUB_API_URL = previousApiUrl;
    }
  });

  test("rejects an oversized streamed delivery list before buffering it", async () => {
    const oversized = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(1_000_001));
          controller.close();
        },
      }),
      {
        headers: {
          "x-ratelimit-remaining": "5000",
          "x-ratelimit-reset": String(Math.floor(NOW.getTime() / 1_000) + 3_600),
        },
      },
    );
    let category: string | undefined;
    try {
      await runWebhookRedeliveryPass(pool, {
        now: NOW,
        owner: "worker-a",
        appJwt: "test-jwt",
        fetchImpl: fetchQueue([oversized], []),
      });
    } catch (error) {
      category = (error as { category?: string }).category;
    }
    expect(category).toBe("oversized_response");
  });

  test("reserves the GitHub rate limit and lets only one worker own a scan", async () => {
    const reset = Math.floor(NOW.getTime() / 1_000) + 600;
    const calls: Array<{ url: string; method: string }> = [];
    const first = await runWebhookRedeliveryPass(pool, {
      now: NOW,
      owner: "worker-a",
      appJwt: "test-jwt",
      fetchImpl: fetchQueue(
        [page([failedDelivery()], {
          "x-ratelimit-remaining": "10",
          "x-ratelimit-reset": String(reset),
        })],
        calls,
      ),
    });
    expect(first.requested).toBe(0);
    expect(first.rateLimitedUntil).toEqual(new Date(reset * 1_000));

    const skipped = await runWebhookRedeliveryPass(pool, {
      now: new Date(NOW.getTime() + 60_000),
      owner: "worker-b",
      appJwt: "test-jwt",
      fetchImpl: (() => {
        throw new Error("rate-limited scan should not fetch");
      }) as unknown as typeof fetch,
    });
    expect(skipped.claimed).toBe(false);
  });

  test("stops redelivery requests when the POST consumes the rate-limit reserve", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const secondFailure = failedDelivery({ id: 201, guid: "second-guid" });
    const result = await runWebhookRedeliveryPass(pool, {
      now: NOW,
      owner: "worker-a",
      appJwt: "test-jwt",
      fetchImpl: fetchQueue(
        [
          page([failedDelivery(), secondFailure]),
          new Response(null, {
            status: 429,
            headers: { "retry-after": "120", "x-ratelimit-remaining": "0" },
          }),
        ],
        calls,
      ),
    });

    expect(result.requested).toBe(1);
    expect(result.retryable).toBe(1);
    expect(result.rateLimitedUntil).toEqual(new Date(NOW.getTime() + 120_000));
    expect(calls.map((call) => call.method)).toEqual(["GET", "POST"]);
  });

  test("budgets POST requests from the reported rate-limit remainder", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const secondFailure = failedDelivery({ id: 201, guid: "second-guid" });
    const result = await runWebhookRedeliveryPass(pool, {
      now: NOW,
      owner: "worker-a",
      appJwt: "test-jwt",
      fetchImpl: fetchQueue(
        [
          page([failedDelivery(), secondFailure], { "x-ratelimit-remaining": "26" }),
          new Response(null, { status: 202 }),
        ],
        calls,
      ),
    });

    expect(result.requested).toBe(1);
    expect(calls.map((call) => call.method)).toEqual(["GET", "POST"]);
  });

  test("releases the scan lease after an App authentication failure", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    let category: string | undefined;
    try {
      await runWebhookRedeliveryPass(pool, {
        now: NOW,
        owner: "worker-a",
        appJwt: "test-jwt",
        fetchImpl: fetchQueue([
          new Response(null, {
            status: 403,
            headers: {
              "x-ratelimit-remaining": "4999",
              "x-ratelimit-reset": String(Math.floor(NOW.getTime() / 1_000) + 600),
            },
          }),
        ], calls),
      });
    } catch (error) {
      category = (error as { category?: string }).category;
    }
    expect(category).toBe("api");
    const state = await pool.query<{
      lease_owner: string | null;
      rate_limited_until: Date | null;
      last_error_category: string | null;
    }>(
      `SELECT lease_owner, rate_limited_until, last_error_category
         FROM github_webhook_redelivery_state
        WHERE id = 1`,
    );
    expect(state.rows[0]).toEqual({
      lease_owner: null,
      rate_limited_until: null,
      last_error_category: "api",
    });

    const retry = await runWebhookRedeliveryPass(pool, {
      now: new Date(NOW.getTime() + 60_000),
      owner: "worker-b",
      appJwt: "test-jwt",
      fetchImpl: fetchQueue([page([])], calls),
    });
    expect(retry.claimed).toBe(true);
  });

  test("allows only one worker to hold the scan lease", async () => {
    let releaseFetch: (() => void) | undefined;
    let fetchStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      fetchStarted = resolve;
    });
    const blockedFetch = (async () => {
      fetchStarted?.();
      await new Promise<void>((resolve) => {
        releaseFetch = resolve;
      });
      return page([]);
    }) as unknown as typeof fetch;

    const first = runWebhookRedeliveryPass(pool, {
      now: NOW,
      owner: "worker-a",
      appJwt: "test-jwt",
      fetchImpl: blockedFetch,
    });
    await started;
    const second = await runWebhookRedeliveryPass(pool, {
      now: NOW,
      owner: "worker-b",
      appJwt: "test-jwt",
      fetchImpl: (() => {
        throw new Error("second worker should not fetch");
      }) as unknown as typeof fetch,
    });
    expect(second.claimed).toBe(false);
    releaseFetch?.();
    expect((await first).claimed).toBe(true);
  });

  test("cancels an in-flight redelivery and releases the scan lease", async () => {
    const controller = new AbortController();
    let postStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      postStarted = resolve;
    });
    let call = 0;
    const blockedPost = (async (_input: string | URL | Request, init?: RequestInit) => {
      call += 1;
      if (call === 1) return page([failedDelivery()]);
      postStarted?.();
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("cancelled", "AbortError")),
          { once: true },
        );
      });
    }) as typeof fetch;

    const pass = runWebhookRedeliveryPass(pool, {
      now: NOW,
      owner: "worker-a",
      appJwt: "test-jwt",
      fetchImpl: blockedPost,
      signal: controller.signal,
    });
    await started;
    controller.abort();

    let category: string | undefined;
    try {
      await pass;
    } catch (error) {
      category = (error as { category?: string }).category;
    }
    expect(category).toBe("aborted");
    const state = await pool.query<{
      lease_owner: string | null;
      last_error_category: string | null;
    }>(
      `SELECT lease_owner, last_error_category
         FROM github_webhook_redelivery_state
        WHERE id = 1`,
    );
    expect(state.rows[0]).toEqual({
      lease_owner: null,
      last_error_category: "aborted",
    });
    const delivery = await pool.query<{ request_attempts: number; request_state: string }>(
      `SELECT request_attempts, request_state
         FROM github_webhook_delivery_recoveries
        WHERE delivery_id = '101'`,
    );
    expect(delivery.rows[0]).toEqual({ request_attempts: 1, request_state: "requesting" });

    const retryController = new AbortController();
    let retryPostStarted: (() => void) | undefined;
    const retryStarted = new Promise<void>((resolve) => {
      retryPostStarted = resolve;
    });
    let retryCall = 0;
    const blockedRetry = (async (_input: string | URL | Request, init?: RequestInit) => {
      retryCall += 1;
      if (retryCall === 1) return page([failedDelivery()]);
      retryPostStarted?.();
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("cancelled", "AbortError")),
          { once: true },
        );
      });
    }) as typeof fetch;
    const retryPass = runWebhookRedeliveryPass(pool, {
      now: new Date(NOW.getTime() + 11 * 60_000),
      owner: "worker-b",
      appJwt: "test-jwt",
      fetchImpl: blockedRetry,
      signal: retryController.signal,
    });
    await retryStarted;
    retryController.abort();
    await expect(retryPass).rejects.toMatchObject({ category: "aborted" });

    const repairCalls: Array<{ url: string; method: string }> = [];
    const repaired = await runWebhookRedeliveryPass(pool, {
      now: new Date(NOW.getTime() + 22 * 60_000),
      owner: "worker-c",
      appJwt: "test-jwt",
      fetchImpl: fetchQueue([page([failedDelivery()])], repairCalls),
    });
    expect(repaired.exhausted).toBe(1);
    expect(repaired.requested).toBe(0);
    expect(repairCalls.map((entry) => entry.method)).toEqual(["GET"]);
    const repairedDelivery = await pool.query<{
      request_attempts: number;
      request_state: string;
      last_error_category: string;
    }>(
      `SELECT request_attempts, request_state, last_error_category
         FROM github_webhook_delivery_recoveries
        WHERE delivery_id = '101'`,
    );
    expect(repairedDelivery.rows[0]).toEqual({
      request_attempts: 2,
      request_state: "exhausted",
      last_error_category: "ambiguous_limit",
    });
  });

  test("prunes payload-free recovery metadata after the bounded retention window", async () => {
    await pool.query(
      `INSERT INTO github_webhook_delivery_recoveries
         (delivery_id, delivery_guid, delivered_at, event, redelivery, outcome)
       VALUES ('1', 'expired-guid', $1, 'pull_request', false, 'success')`,
      [new Date(NOW.getTime() - 31 * 24 * 60 * 60 * 1_000)],
    );
    await runWebhookRedeliveryPass(pool, {
      now: NOW,
      owner: "worker-a",
      appJwt: "test-jwt",
      fetchImpl: fetchQueue([page([])], []),
    });
    const remaining = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM github_webhook_delivery_recoveries",
    );
    expect(remaining.rows[0]?.count).toBe("0");
  });
});
