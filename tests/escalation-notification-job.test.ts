import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { Envelope } from "@/lib/envelope";

let storedRow: Record<string, unknown> | undefined;
let sentInput: Record<string, unknown> | undefined;

const chain = {
  from() {
    return chain;
  },
  innerJoin() {
    return chain;
  },
  leftJoin() {
    return chain;
  },
  where() {
    return chain;
  },
  limit() {
    return Promise.resolve(storedRow ? [storedRow] : []);
  },
};

mock.module("@/lib/db", () => ({
  getDb: () => ({ select: () => chain }),
  schema: {
    reviews: { id: "reviews.id", publicId: "reviews.public_id", status: "reviews.status", envelope: "reviews.envelope", repositoryId: "reviews.repository_id" },
    repositories: { id: "repositories.id", installationId: "repositories.installation_id" },
    installations: { id: "installations.id", orgId: "installations.org_id" },
    organizations: { id: "organizations.id", slug: "organizations.slug" },
    orgSettings: {
      orgId: "org_settings.org_id",
      escalationEmail: "org_settings.escalation_email",
      escalationEmailVerifiedAt: "org_settings.escalation_email_verified_at",
    },
  },
}));

mock.module("@/lib/escalation-notification", () => ({
  configuredGithubWebBase: () => "https://github.example.com",
  sendHumanEscalationNotification: async (input: Record<string, unknown>) => {
    sentInput = input;
    return { sent: true, findingCount: 1, recipientCount: 1 };
  },
}));

const { runEscalationNotificationJob } = await import(
  "@/worker/escalation-notification"
);

const reviewPublicId = "00000000-0000-0000-0000-000000000007";
const envelope = {
  findings: [],
} as unknown as Envelope;

beforeEach(() => {
  process.env.BREVO_API_KEY = "test-key";
  sentInput = undefined;
  storedRow = {
    status: "completed",
    publicId: reviewPublicId,
    envelope,
    escalationEmail: "owners@example.com",
    escalationEmailVerifiedAt: new Date("2026-07-01T00:00:00.000Z"),
  };
});

describe("durable escalation notification job", () => {
  test("loads the completed review and sends to its organization setting", async () => {
    await runEscalationNotificationJob({
      reviewId: 7,
      reviewPublicId,
      repoFullName: "octo/repo",
      prNumber: 9,
      runUrl: "https://postil.dev/orgs/octo/runs/7",
    });

    expect(sentInput).toMatchObject({
      envelope,
      repoFullName: "octo/repo",
      prNumber: 9,
      reviewPublicId,
      recipient: "owners@example.com",
      apiKey: "test-key",
      githubWebBase: "https://github.example.com",
    });
  });

  test("skips cleanly without an explicit verified recipient", async () => {
    storedRow = { ...storedRow, escalationEmail: null };
    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (...values: unknown[]) => logs.push(values.join(" "));
    try {
      await runEscalationNotificationJob({
        reviewId: 7,
        reviewPublicId,
        repoFullName: "octo/repo",
        prNumber: 9,
        runUrl: "https://postil.dev/orgs/octo/runs/7",
      });
    } finally {
      console.log = originalLog;
    }
    expect(sentInput).toBeUndefined();
    expect(logs).toEqual([
      `escalation notification ${reviewPublicId} skipped: no verified recipient`,
    ]);
    expect(logs.join(" ")).not.toContain("example.com");
  });

  test("refuses a stored address without verification metadata", async () => {
    storedRow = { ...storedRow, escalationEmailVerifiedAt: null };
    await runEscalationNotificationJob({
      reviewId: 7,
      reviewPublicId,
      repoFullName: "octo/private",
      prNumber: 9,
      runUrl: "https://postil.dev/orgs/octo/runs/7",
    });
    expect(sentInput).toBeUndefined();
  });
});
