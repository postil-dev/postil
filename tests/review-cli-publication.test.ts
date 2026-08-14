import { describe, expect, test } from "bun:test";

import {
  formatHostedReviewIngestionLog,
  ingestCompletedHostedReview,
  interruptedHostedSpendAction,
  livePullRequestSnapshotLagsEvent,
  publicationSkippedForChangedSnapshot,
} from "@/worker/review";

const envelope = JSON.stringify({
  version: 1,
  summary: "No merge-relevant findings.",
  silent: true,
  findings: [],
  resolved: [],
  counts: { info: 0, warn: 0, error: 0, suppressed: 0, ungrounded: 0 },
  confidenceBuckets: [0, 0, 0, 0, 0],
  gate: { failOn: "error", failing: false, blockOnKinds: [] },
  modelUsed: "z-ai/glm-5.2",
  usage: { promptTokens: 100, completionTokens: 20 },
  durationMs: 1000,
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  sinceSha: null,
});

const operationalEnvelope = JSON.stringify({
  ...JSON.parse(envelope),
  summary: "No reviewer verdict exists because execution failed.",
  silent: false,
  findings: [
    {
      id: "operational-provider",
      path: ".postil/provider",
      line: 1,
      severity: "error",
      kind: "uncertainty",
      title: "Review provider unavailable",
      body: "The review provider did not return a usable result.",
      confidence: 1,
      evidence: "The review provider did not return a usable result.",
    },
  ],
  counts: { info: 0, warn: 0, error: 1, suppressed: 0, ungrounded: 0 },
  gate: { failOn: "error", failing: true, blockOnKinds: [] },
});

describe("hosted CLI publication result", () => {
  test("trusts a validated pre-publication envelope when shutdown removes the exit code", () => {
    const result = ingestCompletedHostedReview({
      exitCode: null,
      stdout: envelope,
      stderr: "worker sent SIGTERM after terminal check publication",
      interrupted: true,
    });

    expect(result.silent).toBe(true);
    expect(result.gateFailing).toBe(false);
    expect(result.modelUsed).toBe("z-ai/glm-5.2");
  });

  test("retains a completed envelope after strict GitHub publication fails", () => {
    const result = ingestCompletedHostedReview({
      exitCode: 2,
      stdout: envelope,
      stderr:
        `${"successful GitHub read\n".repeat(100)}postil: error: required hosted check publication failed: 503 Service Unavailable`,
    });

    expect(result.silent).toBe(true);
    expect(result.gateFailing).toBe(false);
    expect(result.modelUsed).toBe("z-ai/glm-5.2");
  });

  test("does not accept an arbitrary exit-2 envelope", () => {
    expect(() =>
      ingestCompletedHostedReview({
        exitCode: 2,
        stdout: envelope,
        stderr: "postil: error: invalid local configuration",
      }),
    ).toThrow("postil CLI exited with code 2");
  });

  test("retains a validated operational sentinel envelope from exit 2", () => {
    const result = ingestCompletedHostedReview({
      exitCode: 2,
      stdout: operationalEnvelope,
      stderr: "postil: error: provider request failed",
    });

    expect(result.envelope.findings[0]?.path).toBe(".postil/provider");
    expect(result.gateFailing).toBe(true);
  });

  test("logs a no-verdict envelope before policy gate truth", () => {
    const result = ingestCompletedHostedReview({
      exitCode: 2,
      stdout: operationalEnvelope,
      stderr: "postil: error: provider request failed",
    });

    const log = formatHostedReviewIngestionLog(
      operationalEnvelope,
      result.envelope,
      false,
    );

    expect(log).toContain("no reviewer verdict");
    expect(log).not.toContain("passing");
    expect(log).not.toContain("passed");
    expect(log).not.toContain("green");
  });

  test("rejects exit 2 when a finding only resembles an operational sentinel", () => {
    const ordinaryFailure = JSON.stringify({
      ...JSON.parse(operationalEnvelope),
      findings: [
        {
          ...JSON.parse(operationalEnvelope).findings[0],
          path: "src/provider.ts",
        },
      ],
    });

    expect(() =>
      ingestCompletedHostedReview({
        exitCode: 2,
        stdout: ordinaryFailure,
        stderr: "postil: error: provider request failed",
      }),
    ).toThrow("postil CLI exited with code 2");
  });

  test("rejects exit 2 when an ordinary finding accompanies a sentinel", () => {
    const mixedFailure = JSON.stringify({
      ...JSON.parse(operationalEnvelope),
      findings: [
        ...JSON.parse(operationalEnvelope).findings,
        {
          ...JSON.parse(operationalEnvelope).findings[0],
          id: "ordinary-finding",
          path: "src/provider.ts",
        },
      ],
      counts: {
        info: 0,
        warn: 0,
        error: 2,
        suppressed: 0,
        ungrounded: 0,
      },
    });

    expect(() =>
      ingestCompletedHostedReview({
        exitCode: 2,
        stdout: mixedFailure,
        stderr: "postil: error: provider request failed",
      }),
    ).toThrow("postil CLI exited with code 2");
  });

  test("fails when strict publication has no valid envelope", () => {
    expect(() =>
      ingestCompletedHostedReview({
        exitCode: 2,
        stdout: "",
        stderr: "postil: error: required hosted publication failed",
      }),
    ).toThrow("publication failed without a valid envelope");
  });
});

describe("review input convergence", () => {
  test("compares event and live snapshots at exact timestamp precision", () => {
    const event = "2026-08-12T03:04:05.123Z";
    expect(
      livePullRequestSnapshotLagsEvent(
        event,
        "2026-08-12T03:04:05.122Z",
      ),
    ).toBe(true);
    expect(livePullRequestSnapshotLagsEvent(event, event)).toBe(false);
    expect(
      livePullRequestSnapshotLagsEvent(
        event,
        "2026-08-12T03:04:05.124Z",
      ),
    ).toBe(false);
    expect(() => livePullRequestSnapshotLagsEvent(event, "invalid")).toThrow(
      "pull request update timestamps must be valid",
    );
  });
});

describe("interrupted hosted spend", () => {
  test("prefers receipts and distinguishes every provider outcome", () => {
    expect(
      interruptedHostedSpendAction({
        receiptAvailable: true,
        cliStarted: true,
        billingOutcome: "ambiguous",
      }),
    ).toBe("receipt");
    expect(
      interruptedHostedSpendAction({
        receiptAvailable: false,
        cliStarted: true,
        billingOutcome: "resumable",
      }),
    ).toBe("retain-resumable");
    expect(
      interruptedHostedSpendAction({
        receiptAvailable: false,
        cliStarted: true,
        billingOutcome: "ambiguous",
      }),
    ).toBe("reconcile-ambiguous");
    expect(
      interruptedHostedSpendAction({
        receiptAvailable: false,
        cliStarted: true,
        billingOutcome: "unused",
      }),
    ).toBe("release-unused");
    expect(
      interruptedHostedSpendAction({
        receiptAvailable: false,
        cliStarted: false,
        billingOutcome: "ambiguous",
      }),
    ).toBe("release-unused");
  });
});

describe("publication skipped for a changed pull request snapshot", () => {
  test("recognizes a check-completion skip from a moved head", () => {
    expect(
      publicationSkippedForChangedSnapshot(
        "postil: error: required hosted check publication failed: check completion skipped because the pull request snapshot changed after review",
      ),
    ).toBe(true);
  });

  test("recognizes a combined check-and-delivery skip from a moved head", () => {
    expect(
      publicationSkippedForChangedSnapshot(
        "postil: error: required hosted publication failed: check completion: check completion skipped because the pull request snapshot changed after review; review delivery: required review publication skipped because the pull request snapshot changed after review",
      ),
    ).toBe(true);
  });

  test("does not treat an ordinary transient publication failure as a moved head", () => {
    expect(
      publicationSkippedForChangedSnapshot(
        "postil: error: required hosted check publication failed: 503 Service Unavailable",
      ),
    ).toBe(false);
  });

  test("does not match on an unrelated error", () => {
    expect(
      publicationSkippedForChangedSnapshot(
        "postil: error: invalid local configuration",
      ),
    ).toBe(false);
  });
});
