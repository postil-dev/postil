import { describe, expect, test } from "bun:test";

import type { Database } from "@/lib/db";
import { schema } from "@/lib/db";
import type { Envelope } from "@/lib/envelope";
import { persistReviewCompletion } from "@/lib/review-completion";

function fakeDb(reviewUpdated = true): {
  db: Database;
  inserted: Array<{ table: unknown; values: Record<string, unknown> }>;
  transactions: number;
} {
  const inserted: Array<{ table: unknown; values: Record<string, unknown> }> = [];
  let transactions = 0;
  const tx = {
    update() {
      const chain = {
        set() {
          return chain;
        },
        where() {
          return chain;
        },
        returning() {
          return Promise.resolve(reviewUpdated ? [{ id: 7 }] : []);
        },
      };
      return chain;
    },
    insert(table: unknown) {
      return {
        values(values: Record<string, unknown>) {
          inserted.push({ table, values });
          return Promise.resolve();
        },
      };
    },
  };
  const db = {
    transaction<T>(callback: (transaction: typeof tx) => Promise<T>) {
      transactions += 1;
      return callback(tx);
    },
  } as unknown as Database;
  return {
    db,
    inserted,
    get transactions() {
      return transactions;
    },
  };
}

const envelope = { version: 1 } as Envelope;
const base = {
  reviewId: 7,
  envelope,
  configFiles: [],
  silent: false,
  gateFailing: true,
  usage: {
    orgId: 1,
    repositoryId: 2,
    promptTokens: 100,
    completionTokens: 20,
    modelUsed: "model",
    costCents: 1,
  },
};

describe("review completion transaction", () => {
  test("atomically records usage and exactly one escalation outbox job", async () => {
    const state = fakeDb();
    const completed = await persistReviewCompletion(state.db, {
      ...base,
      escalationJob: {
        reviewPublicId: "00000000-0000-0000-0000-000000000007",
        repoFullName: "octo/repo",
        prNumber: 9,
        runUrl: "https://postil.dev/orgs/octo/runs/7",
      },
    });

    expect(completed).toBe(true);
    expect(state.transactions).toBe(1);
    expect(state.inserted.filter((row) => row.table === schema.usageEvents)).toHaveLength(1);
    const jobs = state.inserted.filter((row) => row.table === schema.jobs);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.values).toMatchObject({
      kind: "escalation-notification",
      maxAttempts: 5,
      payload: { reviewId: 7, repoFullName: "octo/repo", prNumber: 9 },
    });
  });

  test("records no outbox job for a review without a new qualifying escalation", async () => {
    const state = fakeDb();
    expect(await persistReviewCompletion(state.db, base)).toBe(true);
    expect(state.inserted.filter((row) => row.table === schema.usageEvents)).toHaveLength(1);
    expect(state.inserted.filter((row) => row.table === schema.jobs)).toHaveLength(0);
  });

  test("records neither accounting nor notification after losing the completion race", async () => {
    const state = fakeDb(false);
    expect(
      await persistReviewCompletion(state.db, {
        ...base,
        escalationJob: {
          reviewPublicId: "00000000-0000-0000-0000-000000000007",
          repoFullName: "octo/repo",
          prNumber: 9,
          runUrl: "https://postil.dev/orgs/octo/runs/7",
        },
      }),
    ).toBe(false);
    expect(state.inserted).toEqual([]);
  });
});
