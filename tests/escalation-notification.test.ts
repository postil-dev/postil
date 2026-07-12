import { describe, expect, test } from "bun:test";

import {
  configuredGithubWebBase,
  qualifyingHumanEscalations,
  sendHumanEscalationNotification,
} from "@/lib/escalation-notification";
import type { Envelope } from "@/lib/envelope";

function envelope(confidences: number[]): Envelope {
  return {
    version: 1,
    summary: "Human review required.",
    silent: false,
    findings: confidences.map((confidence, index) => ({
      id: `finding-${index}`,
      path: `src/file-${index}.ts`,
      line: index + 1,
      severity: index === 0 ? "error" : "warn",
      kind: "humanEscalation",
      confidence,
      title: `Escalation ${index + 1}`,
      body: `Concrete concern ${index + 1}.`,
    })),
    resolved: [],
    counts: {
      info: 0,
      warn: Math.max(0, confidences.length - 1),
      error: confidences.length > 0 ? 1 : 0,
      suppressed: 0,
      ungrounded: 0,
    },
    confidenceBuckets: [0, 0, 0, 0, 0],
    gate: { failOn: "error", failing: true, blockOnKinds: ["humanEscalation"] },
    modelUsed: "example/model",
    usage: { promptTokens: 100, completionTokens: 20 },
    durationMs: 500,
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    sinceSha: null,
  };
}

describe("human escalation notifications", () => {
  test("derives a GitHub Enterprise web origin from the documented API URL", () => {
    const previousApi = process.env.GITHUB_API_URL;
    const previousServer = process.env.GITHUB_SERVER_URL;
    process.env.GITHUB_API_URL = "https://github.example.com/api/v3";
    delete process.env.GITHUB_SERVER_URL;
    try {
      expect(configuredGithubWebBase()).toBe("https://github.example.com");
    } finally {
      if (previousApi === undefined) delete process.env.GITHUB_API_URL;
      else process.env.GITHUB_API_URL = previousApi;
      if (previousServer === undefined) delete process.env.GITHUB_SERVER_URL;
      else process.env.GITHUB_SERVER_URL = previousServer;
    }
  });

  test("uses the same 0.30 confidence floor as the gate", () => {
    expect(qualifyingHumanEscalations(envelope([0.05, 0.29, 0.3]))).toHaveLength(1);
  });

  test("does not renotify carried escalations", () => {
    const carried = envelope([0.9]);
    carried.findings[0]!.body =
      "[carried from previous review]\nConcrete concern from the earlier review.";

    expect(qualifyingHumanEscalations(carried)).toEqual([]);
  });

  test("does not call Brevo for a weak escalation", async () => {
    let calls = 0;
    const result = await sendHumanEscalationNotification({
      envelope: envelope([0.05]),
      repoFullName: "postil-dev/postil",
      prNumber: 42,
      runUrl: "https://postil.dev/orgs/postil-dev/runs/run-42",
      reviewPublicId: "00000000-0000-0000-0000-000000000042",
      recipient: "owner@example.com",
      recipientVerifiedAt: new Date("2026-07-01T00:00:00.000Z"),
      apiKey: "test-key",
      fetchImpl: () => {
        calls += 1;
        return Promise.resolve(new Response(null, { status: 201 }));
      },
    });

    expect(result.sent).toBe(false);
    expect(calls).toBe(0);
  });

  test("refuses an unverified recipient before calling Brevo", async () => {
    let calls = 0;
    await expect(
      sendHumanEscalationNotification({
        envelope: envelope([0.8]),
        repoFullName: "postil-dev/postil",
        prNumber: 42,
        runUrl: "https://postil.dev/orgs/postil-dev/runs/run-42",
        reviewPublicId: "00000000-0000-0000-0000-000000000042",
        recipient: "owner@example.com",
        recipientVerifiedAt: undefined as unknown as Date,
        apiKey: "test-key",
        fetchImpl: async () => {
          calls += 1;
          return new Response(null, { status: 201 });
        },
      }),
    ).rejects.toThrow("escalation recipient is not verified");
    expect(calls).toBe(0);
  });

  test("sends one idempotent aggregate email with PR and run links", async () => {
    let request: Request | undefined;
    const result = await sendHumanEscalationNotification({
      envelope: envelope([0.91, 0.74]),
      repoFullName: "postil-dev/postil",
      prNumber: 42,
      runUrl: "https://postil.dev/orgs/postil-dev/runs/run-42",
      reviewPublicId: "00000000-0000-0000-0000-000000000042",
      recipient: "Owner@example.com",
      recipientVerifiedAt: new Date("2026-07-01T00:00:00.000Z"),
      apiKey: "test-key",
      githubWebBase: "https://github.example.com",
      fetchImpl: (input, init) => {
        request = new Request(input, init);
        return Promise.resolve(
          new Response(JSON.stringify({ messageId: "brevo-message" }), { status: 201 }),
        );
      },
    });

    expect(result).toEqual({ sent: true, findingCount: 2, recipientCount: 1 });
    expect(request?.url).toBe("https://api.brevo.com/v3/smtp/email");
    expect(request?.headers.get("api-key")).toBe("test-key");
    const body = (await request?.json()) as {
      to: Array<{ email: string }>;
      textContent: string;
      headers: Record<string, string>;
    };
    expect(body.to).toEqual([{ email: "owner@example.com" }]);
    expect(body.headers["Idempotency-Key"]).toBe(
      "00000000-0000-0000-0000-000000000042",
    );
    expect(body.textContent).toContain(
      "https://github.example.com/postil-dev/postil/pull/42",
    );
    expect(body.textContent).toContain("https://postil.dev/orgs/postil-dev/runs/run-42");
    expect(body.textContent).toContain("[error] Escalation 1");
    expect(body.textContent).toContain("[warn] Escalation 2");
  });

  test("reports a Brevo rejection for the worker to contain", async () => {
    await expect(
      sendHumanEscalationNotification({
        envelope: envelope([0.8]),
        repoFullName: "postil-dev/postil",
        prNumber: 42,
        runUrl: "https://postil.dev/orgs/postil-dev/runs/run-42",
        reviewPublicId: "00000000-0000-0000-0000-000000000042",
        recipient: "owner@example.com",
        recipientVerifiedAt: new Date("2026-07-01T00:00:00.000Z"),
        apiKey: "test-key",
        fetchImpl: () =>
          Promise.resolve(new Response("provider unavailable", { status: 503 })),
      }),
    ).rejects.toThrow("Brevo escalation email failed: 503");
  });

  test("treats Brevo's duplicate idempotency response as delivered", async () => {
    const result = await sendHumanEscalationNotification({
      envelope: envelope([0.8]),
      repoFullName: "postil-dev/postil",
      prNumber: 42,
      runUrl: "https://postil.dev/orgs/postil-dev/runs/run-42",
      reviewPublicId: "00000000-0000-0000-0000-000000000042",
      recipient: "owner@example.com",
      recipientVerifiedAt: new Date("2026-07-01T00:00:00.000Z"),
      apiKey: "test-key",
      fetchImpl: () =>
        Promise.resolve(
          new Response(JSON.stringify({ code: "duplicate_parameter" }), {
            status: 400,
          }),
        ),
    });

    expect(result).toEqual({ sent: true, findingCount: 1, recipientCount: 1 });
  });

  test("normalizes control characters and caps model-generated content", async () => {
    const unsafe = envelope([0.8]);
    unsafe.findings[0]!.title = "Urgent\r\nBcc: victim@example.com";
    unsafe.findings[0]!.body = `Click this model-provided link.\u0000${"x".repeat(3_000)}`;
    let request: Request | undefined;

    await sendHumanEscalationNotification({
      envelope: unsafe,
      repoFullName: "postil-dev/postil",
      prNumber: 42,
      runUrl: "https://postil.dev/orgs/postil-dev/runs/run-42",
      reviewPublicId: "00000000-0000-0000-0000-000000000042",
      recipient: "owner@example.com",
      recipientVerifiedAt: new Date("2026-07-01T00:00:00.000Z"),
      apiKey: "test-key",
      fetchImpl: (input, init) => {
        request = new Request(input, init);
        return Promise.resolve(new Response(null, { status: 201 }));
      },
    });

    const body = (await request?.json()) as { subject: string; textContent: string };
    expect(body.subject).not.toContain("\n");
    expect(body.subject).not.toContain("\r");
    expect(body.textContent).not.toContain("\u0000");
    expect(body.textContent).toContain("model-generated");
    expect(body.textContent.length).toBeLessThan(12_001);
  });

  test("keeps trusted verification links after truncating many large findings", async () => {
    const large = envelope(Array.from({ length: 20 }, () => 0.8));
    for (const finding of large.findings) finding.body = "x".repeat(3_000);
    let request: Request | undefined;

    await sendHumanEscalationNotification({
      envelope: large,
      repoFullName: "postil-dev/postil",
      prNumber: 42,
      runUrl: "https://postil.dev/orgs/postil-dev/runs/run-42",
      reviewPublicId: "00000000-0000-0000-0000-000000000042",
      recipient: "owner@example.com",
      recipientVerifiedAt: new Date("2026-07-01T00:00:00.000Z"),
      apiKey: "test-key",
      fetchImpl: (input, init) => {
        request = new Request(input, init);
        return Promise.resolve(new Response(null, { status: 201 }));
      },
    });

    const body = (await request?.json()) as { textContent: string };
    expect(body.textContent).toContain("https://github.com/postil-dev/postil/pull/42");
    expect(body.textContent).toContain("https://postil.dev/orgs/postil-dev/runs/run-42");
    expect(body.textContent.length).toBeLessThanOrEqual(12_000);
  });
});
