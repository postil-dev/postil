import { beforeEach, describe, expect, mock, test } from "bun:test";

let accessState: unknown;
let reviewRows: unknown[] = [];
let logRows: unknown[] = [];

mock.module("@/lib/org-access", () => ({
  getOrgMembership: async () => accessState,
  requireOrgMembership: async () => {
    const access = accessState as { ok: boolean; reason?: string };
    if (!access.ok) throw new Error(access.reason);
    return accessState;
  },
}));

const { GET } = await import("@/app/api/orgs/[slug]/runs/[publicId]/logs/route");

const PUBLIC_ID = "4ccf0c0f-8d55-4b7d-8a3e-2bd8eb88b702";

function fakeDb() {
  return {
    select(selection: Record<string, unknown>) {
      const rows = "status" in selection ? reviewRows : logRows;
      const chain = {
        from() {
          return chain;
        },
        innerJoin() {
          return chain;
        },
        where() {
          return chain;
        },
        orderBy() {
          return chain;
        },
        limit() {
          return Promise.resolve(rows);
        },
      };
      return chain;
    },
  };
}

function request(after?: string): Request {
  const url = new URL(`https://postil.dev/api/orgs/octo/runs/${PUBLIC_ID}/logs`);
  if (after !== undefined) url.searchParams.set("after", after);
  return new Request(url);
}

function invoke(after?: string, publicId = PUBLIC_ID): Promise<Response> {
  return GET(request(after), {
    params: Promise.resolve({ slug: "octo", publicId }),
  });
}

beforeEach(() => {
  reviewRows = [
    {
      id: 18,
      status: "running",
      finishedAt: null,
      gateFailing: null,
      gateSyncStatus: "running",
    },
  ];
  logRows = [
    { seq: 3, at: new Date("2026-07-10T12:00:03.000Z"), line: "CLI spawned" },
  ];
  accessState = { ok: true, db: fakeDb(), org: { id: 7 } };
});

describe("GET run logs", () => {
  test("returns 401 for a missing session", async () => {
    accessState = { ok: false, reason: "unauthenticated" };
    const response = await invoke();
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  test("returns 404 for a non-member without disclosing the organization", async () => {
    accessState = { ok: false, reason: "not_found" };
    const response = await invoke();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not found" });
  });

  test("returns a retryable error while GitHub membership verification is unavailable", async () => {
    accessState = { ok: false, reason: "verification_unavailable" };
    const response = await invoke();
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("30");
    expect(await response.json()).toEqual({
      error: "membership verification unavailable",
    });
  });

  test("rejects numeric run ids and invalid after cursors", async () => {
    expect((await invoke(undefined, "18")).status).toBe(404);
    const response = await invoke("not-a-sequence");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "after must be a non-negative integer",
    });
  });

  test("returns ordered incremental lines with run terminal state", async () => {
    const response = await invoke("2");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      lines: [
        {
          seq: 3,
          at: "2026-07-10T12:00:03.000Z",
          line: "CLI spawned",
        },
      ],
      status: "running",
      finishedAt: null,
      gateFailing: null,
      gateSyncStatus: "running",
    });
  });

  test("returns 404 when the public id is outside the member organization", async () => {
    reviewRows = [];
    const response = await invoke();
    expect(response.status).toBe(404);
  });

  // The run page renders a first status server-side and this poller replaces
  // it, so a review that never reached a verdict has to report the same
  // failure here or the page reverts to a clean pass on the first poll.
  test("reports a review that ended in an operational failure as failed", async () => {
    reviewRows = [
      {
        id: 18,
        status: "completed",
        errorMessage: null,
        envelope: {
          findings: [
            {
              path: ".postil/model-output",
              severity: "error",
              kind: "uncertainty",
              title: "Model output could not be validated",
            },
          ],
        },
        finishedAt: null,
        gateFailing: false,
        gateSyncStatus: null,
      },
    ];

    const body = (await (await invoke()).json()) as { status: string; gateFailing: boolean };
    expect(body.status).toBe("failed");
    // The gate is reported separately and keeps its own state.
    expect(body.gateFailing).toBe(false);
  });

  test("still reports a clean completed review as completed", async () => {
    reviewRows = [
      {
        id: 18,
        status: "completed",
        errorMessage: null,
        envelope: { findings: [] },
        finishedAt: null,
        gateFailing: false,
        gateSyncStatus: null,
      },
    ];

    expect(((await (await invoke()).json()) as { status: string }).status).toBe("completed");
  });
});
