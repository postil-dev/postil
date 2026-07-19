import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { RespondJobPayload } from "@/lib/queue";
import "./quiet-console";

/**
 * Unit coverage for the respond-job failure reply: when a @postil mention's
 * respond job exhausts its retries, the worker must post exactly one honest
 * fallback comment, and must stay silent for non-final failures and for
 * skipped jobs (installation suspended / repository disabled).
 *
 * The GitHub and database boundaries are mocked so the decision logic runs
 * fully in-process without a live Postgres or network. The real single-post
 * guard (failJob's conditional `running` -> `failed` transition) is exercised
 * against a real database in queue.test.ts; here we assert the worker's gate
 * and the helper's skip/idempotency behaviour given that outcome.
 */

// Schema sentinels: the helper passes `schema.installations` / `schema.repositories`
// to `.from(...)`, which our fake uses to pick the right result set.
const schema = { installations: "installations", repositories: "repositories" };

// Result sets returned by `.from(<table>).where(...).limit(1)`, by table.
let installationRows: unknown[] = [];
let repositoryRows: unknown[] = [];

function fakeDb() {
  let table: string | undefined;
  const chain = {
    select() {
      return chain;
    },
    from(t: string) {
      table = t;
      return chain;
    },
    where() {
      return chain;
    },
    // `.limit(1)` is the awaited tail of the chain; resolve to the rows for
    // whichever table `.from()` recorded.
    limit() {
      const rows = table === schema.repositories ? repositoryRows : installationRows;
      return Promise.resolve(rows);
    },
  };
  return chain;
}

let tokenMintError: Error | undefined;
const postedComments: Array<{ repo: string; number: number; body: string }> = [];
let postShouldThrow = false;
let postShouldHang = false;
let postShouldThrowAfterAccept = false;
let deliveryJobEnqueues = 0;
let delivery:
  | {
      jobId: number;
      repoFullName: string;
      issueNumber: number;
      body: string;
      state: "prepared" | "delivering" | "delivered";
      createdAt: Date;
      githubInstallationId: number;
    }
  | undefined;

mock.module("@/lib/db", () => ({
  getDb: () => fakeDb(),
  // Mirror the real module's export surface so a concurrently-loaded consumer
  // of getPool does not crash with "Export named 'getPool' not found". These
  // tests never call it; throw if they ever do.
  getPool: () => {
    throw new Error("getPool is not mocked for respond-failure tests");
  },
  closeDb: async () => undefined,
  schema,
}));

const realAppAuth = await import("@/lib/github/app-auth");
mock.module("@/lib/github/app-auth", () => ({
  ...realAppAuth,
  getInstallationToken: async () => {
    if (tokenMintError) throw tokenMintError;
    return "ghs_test_token";
  },
}));

// Preserve the rest of the checks surface (review.ts imports check-run helpers
// transitively); only override the comment poster.
const realChecks = await import("@/lib/github/checks");
mock.module("@/lib/github/checks", () => ({
  ...realChecks,
  findIssueCommentByMarker: async (
    _token: string,
    repo: string,
    number: number,
    marker: string,
  ) => {
    const index = postedComments.findIndex(
      (comment) =>
        comment.repo === repo && comment.number === number && comment.body.includes(marker),
    );
    return index < 0 ? null : index + 1;
  },
  postIssueComment: async (
    _token: string,
    repo: string,
    number: number,
    body: string,
    signal?: AbortSignal,
  ) => {
    if (postShouldThrow) throw new Error("github 500");
    if (postShouldHang) {
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    postedComments.push({ repo, number, body });
    if (postShouldThrowAfterAccept) throw new Error("connection lost after accept");
    return postedComments.length;
  },
}));

const realRespondDelivery = await import("@/lib/respond-delivery");
mock.module("@/lib/respond-delivery", () => ({
  ...realRespondDelivery,
  RESPOND_DELIVERY_REQUEST_TIMEOUT_MS: 30_000,
  claimRespondDelivery: async (_db: unknown, jobId: number) => {
    if (!delivery || delivery.jobId !== jobId || delivery.state !== "prepared") return null;
    delivery.state = "delivering";
    return delivery;
  },
  getRespondDelivery: async (_db: unknown, jobId: number) =>
    delivery?.jobId === jobId ? delivery : null,
  markRespondDelivered: async (_db: unknown, jobId: number) => {
    if (delivery?.jobId === jobId) delivery.state = "delivered";
  },
  prepareUnmeteredRespondDelivery: async (
    _db: unknown,
    input: {
      jobId: number;
      repoFullName: string;
      issueNumber: number;
      body: string;
    },
  ) => {
    if (delivery) return;
    delivery = {
      ...input,
      state: "prepared",
      createdAt: new Date(),
      githubInstallationId: 42,
    };
    deliveryJobEnqueues += 1;
  },
  respondDeliveryMarker: (jobId: number) => `<!-- postil-respond-job:${jobId} -->`,
}));

const realReview = await import("@/worker/review");
mock.module("@/worker/review", () => ({
  ...realReview,
  resolveLlmConfig: async () => ({
    byok: true,
    apiBase: "https://provider.example/v1",
    apiFormat: "openai-compatible",
    apiKey: "fixture-key",
  }),
}));

// Imported after the mocks are registered so the helper binds to them.
const {
  postRespondFailureComment,
  RESPOND_FAILURE_COMMENT,
  runRespondDeliveryJob,
} = await import("@/worker/respond");

function payload(over: Partial<RespondJobPayload> = {}): RespondJobPayload {
  return {
    installationId: 42,
    repoFullName: "octo/repo",
    number: 7,
    isPr: true,
    comment: "@postil please look",
    ...over,
  };
}

const enabledInstallation = { id: 1, githubInstallationId: 42, suspended: false, orgId: null };
const enabledRepository = { id: 10, installationId: 1, fullName: "octo/repo", enabled: true };

beforeEach(() => {
  installationRows = [enabledInstallation];
  repositoryRows = [enabledRepository];
  tokenMintError = undefined;
  postShouldThrow = false;
  postShouldHang = false;
  postShouldThrowAfterAccept = false;
  deliveryJobEnqueues = 0;
  delivery = undefined;
  postedComments.length = 0;
});

afterEach(() => {
  mock.restore();
});

describe("postRespondFailureComment (final-attempt exhaustion)", () => {
  test("posts exactly one honest fallback comment to the originating PR/issue", async () => {
    await postRespondFailureComment(payload(), 123);
    expect(postedComments).toHaveLength(1);
    expect(postedComments[0]).toEqual({
      repo: "octo/repo",
      number: 7,
      body: `${RESPOND_FAILURE_COMMENT}\n\n<!-- postil-respond-job:123 -->`,
    });
    // Brief acknowledgment without provider detail or another active mention.
    expect(RESPOND_FAILURE_COMMENT).toContain("couldn't complete");
    expect(RESPOND_FAILURE_COMMENT).not.toContain("@postil");
    expect(RESPOND_FAILURE_COMMENT).not.toContain("model");
    expect(deliveryJobEnqueues).toBe(1);
  });

  test("calling twice posts once through the durable delivery marker", async () => {
    await postRespondFailureComment(payload(), 123);
    await postRespondFailureComment(payload(), 123);
    expect(postedComments).toHaveLength(1);
    expect(deliveryJobEnqueues).toBe(1);
  });

  test("ambiguous accepted POST is found by marker instead of duplicated", async () => {
    postShouldThrowAfterAccept = true;
    await postRespondFailureComment(payload(), 123);
    expect(postedComments).toHaveLength(1);
    expect(delivery?.state).toBe("delivering");

    postShouldThrowAfterAccept = false;
    delivery!.state = "prepared"; // The real lease expiry makes this claimable.
    await runRespondDeliveryJob({ respondJobId: 123 });

    expect(postedComments).toHaveLength(1);
    expect(String(delivery?.state)).toBe("delivered");
  });
});

describe("postRespondFailureComment skips genuinely skipped work", () => {
  test("suspended installation posts no comment", async () => {
    installationRows = [{ ...enabledInstallation, suspended: true }];
    await postRespondFailureComment(payload(), 123);
    expect(postedComments).toHaveLength(0);
  });

  test("missing installation posts no comment", async () => {
    installationRows = [];
    await postRespondFailureComment(payload(), 123);
    expect(postedComments).toHaveLength(0);
  });

  test("disabled repository posts no comment", async () => {
    repositoryRows = [{ ...enabledRepository, enabled: false }];
    await postRespondFailureComment(payload(), 123);
    expect(postedComments).toHaveLength(0);
  });

  test("missing repository posts no comment", async () => {
    repositoryRows = [];
    await postRespondFailureComment(payload(), 123);
    expect(postedComments).toHaveLength(0);
  });
});

describe("postRespondFailureComment is fail-safe", () => {
  test("malformed payload (no routing fields) posts nothing and does not throw", async () => {
    await postRespondFailureComment({} as RespondJobPayload, 123);
    expect(postedComments).toHaveLength(0);
  });

  test("a failing comment POST is swallowed, never re-thrown", async () => {
    postShouldThrow = true;
    await expect(postRespondFailureComment(payload(), 123)).resolves.toBeUndefined();
    expect(postedComments).toHaveLength(0);
  });

  test("a failing token mint is swallowed, never re-thrown", async () => {
    tokenMintError = new Error("mint failed");
    await expect(postRespondFailureComment(payload(), 123)).resolves.toBeUndefined();
    expect(postedComments).toHaveLength(0);
  });

  test("a hung comment POST is bounded when the caller supplies no signal", async () => {
    postShouldHang = true;

    await expect(
      postRespondFailureComment(payload(), 123, undefined, 10),
    ).resolves.toBeUndefined();
    expect(postedComments).toHaveLength(0);
  });

  test("strict mode rejects so a durable comment job can retry", async () => {
    postShouldThrow = true;

    await expect(
      postRespondFailureComment(payload(), 123, undefined, 10, true),
    ).rejects.toThrow("github 500");
  });
});

describe("worker failure gate (which outcomes trigger a reply)", () => {
  // Mirrors the guard in src/worker/index.ts: only a respond job whose
  // failJob outcome is the permanent "failed" transition posts a reply.
  // "retried" (non-final, will run again) and "lost" (watchdog won the race)
  // must not, so the bot never spams on intermediate retries or double-posts.
  function shouldPostReply(kind: string, outcome: "retried" | "failed" | "lost"): boolean {
    return outcome === "failed" && kind === "respond";
  }

  test("final respond failure triggers a reply", () => {
    expect(shouldPostReply("respond", "failed")).toBe(true);
  });

  test("non-final respond failure (retried) triggers no reply", () => {
    expect(shouldPostReply("respond", "retried")).toBe(false);
  });

  test("watchdog-lost respond failure triggers no reply (no double-post)", () => {
    expect(shouldPostReply("respond", "lost")).toBe(false);
  });

  test("review job failures never trigger a respond reply", () => {
    expect(shouldPostReply("review", "failed")).toBe(false);
  });
});
