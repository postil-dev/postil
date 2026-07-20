import { describe, expect, test } from "bun:test";

import { ingestCompletedHostedReview } from "@/worker/review";

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

describe("hosted CLI publication result", () => {
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
