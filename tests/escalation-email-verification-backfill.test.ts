import { beforeEach, describe, expect, test } from "bun:test";

import type { Database } from "@/lib/db";
import { backfillEscalationEmailVerification } from "../scripts/backfill-escalation-email-verification";

interface Row {
  orgId: number;
  pendingEmail: string | null;
  tokenDigest: Buffer | null;
  tokenCiphertext: Buffer | null;
  expiresAt: Date | null;
  sentAt: Date | null;
}

beforeEach(() => {
  process.env.POSTIL_SEALING_KEY =
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
});

describe("escalation email verification backfill", () => {
  test("dry-run reports counts without writing addresses or tokens", async () => {
    const fixture = backfillDb([
      pendingRow(1),
      { ...pendingRow(2), pendingEmail: null },
    ]);
    const result = await backfillEscalationEmailVerification(fixture.db, {
      confirm: false,
      now: new Date("2026-07-12T12:00:00.000Z"),
    });
    expect(result).toEqual({ pending: 1, queued: 0, alreadyQueued: 0, dryRun: true });
    expect(fixture.jobs).toHaveLength(0);
    expect(fixture.updates).toHaveLength(0);
  });

  test("confirm queues each pending row once and safely reruns", async () => {
    const fixture = backfillDb([pendingRow(1), pendingRow(2)]);
    const now = new Date("2026-07-12T12:00:00.000Z");
    expect(
      await backfillEscalationEmailVerification(fixture.db, { confirm: true, now }),
    ).toEqual({ pending: 2, queued: 2, alreadyQueued: 0, dryRun: false });
    expect(fixture.jobs).toHaveLength(2);
    expect(fixture.jobs.every((job) => job.kind === "escalation-email-verification")).toBe(
      true,
    );
    expect(
      fixture.jobs.every(
        (job) =>
          !JSON.stringify(job).includes("owner1@example.com") &&
          !JSON.stringify(job).includes("owner2@example.com"),
      ),
    ).toBe(true);

    expect(
      await backfillEscalationEmailVerification(fixture.db, { confirm: true, now }),
    ).toEqual({ pending: 2, queued: 0, alreadyQueued: 2, dryRun: false });
    expect(fixture.jobs).toHaveLength(2);
  });

  test("re-enqueues an unsent valid token after its live job is gone", async () => {
    const digest = Buffer.alloc(32, 9);
    const fixture = backfillDb([
      {
        ...pendingRow(1),
        tokenDigest: digest,
        tokenCiphertext: Buffer.alloc(40, 3),
        expiresAt: new Date("2026-07-13T12:00:00.000Z"),
      },
    ]);
    const now = new Date("2026-07-12T12:00:00.000Z");
    expect(
      await backfillEscalationEmailVerification(fixture.db, { confirm: true, now }),
    ).toMatchObject({ queued: 1, alreadyQueued: 0 });
    expect(fixture.jobs[0]?.payload).toEqual({
      orgId: 1,
      tokenDigest: digest.toString("base64url"),
    });
    expect(
      await backfillEscalationEmailVerification(fixture.db, { confirm: true, now }),
    ).toMatchObject({ queued: 0, alreadyQueued: 1 });
    expect(fixture.jobs).toHaveLength(1);
  });
});

function pendingRow(orgId: number): Row {
  return {
    orgId,
    pendingEmail: `owner${orgId}@example.com`,
    tokenDigest: null,
    tokenCiphertext: null,
    expiresAt: null,
    sentAt: null,
  };
}

function backfillDb(rows: Row[]): {
  db: Database;
  jobs: Array<Record<string, unknown>>;
  updates: Array<Record<string, unknown>>;
} {
  const jobs: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  const jobInsert = () => ({
    values(values: Record<string, unknown>) {
      jobs.push(values);
      return {
        returning() {
          return Promise.resolve([{ id: jobs.length }]);
        },
      };
    },
  });
  const db = {
    select(selection: Record<string, unknown>) {
      return {
        from: () =>
          "payload" in selection
            ? {
                where: () =>
                  Promise.resolve(jobs.map((job) => ({ payload: job.payload }))),
              }
            : Promise.resolve(rows),
      };
    },
    insert: jobInsert,
    transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(tx),
  };
  let pendingUpdate: Record<string, unknown> = {};
  const tx = {
    update() {
      const chain = {
        set(values: Record<string, unknown>) {
          pendingUpdate = values;
          updates.push(values);
          return chain;
        },
        where() {
          return chain;
        },
        returning() {
          const row = rows.find(
            (candidate) =>
              candidate.pendingEmail &&
              candidate.tokenDigest === null,
          );
          if (!row) return Promise.resolve([]);
          row.tokenDigest = pendingUpdate.escalationEmailVerificationTokenDigest as Buffer;
          row.tokenCiphertext =
            pendingUpdate.escalationEmailVerificationTokenCiphertext as Buffer;
          row.expiresAt = pendingUpdate.escalationEmailVerificationExpiresAt as Date;
          return Promise.resolve([{ orgId: row.orgId }]);
        },
      };
      return chain;
    },
    insert: jobInsert,
  };
  return { db: db as unknown as Database, jobs, updates };
}
