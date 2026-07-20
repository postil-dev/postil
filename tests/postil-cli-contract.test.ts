import { describe, expect, test } from "bun:test";

import {
  assertEnvelopeContract,
  assertReviewHelp,
} from "../scripts/verify-postil-cli-contract";

describe("postil CLI release contract", () => {
  test("requires every hosted review option", () => {
    const help = [
      "--publish",
      "--bounded",
      "--sha <SHA>",
      "--base-sha <BASE_SHA>",
    ].join("\n");
    expect(() => assertReviewHelp(help)).not.toThrow();
    expect(() => assertReviewHelp(help.replace("--publish", ""))).toThrow(
      "missing required option --publish",
    );
  });

  test("accepts the compatible empty review envelope", () => {
    const envelope = {
      version: 1,
      summary: "",
      baseSha: "2".repeat(40),
      headSha: "1".repeat(40),
      sinceSha: null,
      silent: true,
      findings: [],
      resolved: [],
      counts: { info: 0, warn: 0, error: 0, suppressed: 0, ungrounded: 0 },
      confidenceBuckets: [0, 0, 0, 0, 0],
      gate: { failOn: "error", failing: false },
      modelUsed: "test/model",
      usage: { promptTokens: 1, completionTokens: 1 },
      modelIncidents: [
        {
          phase: "planner",
          category: "invalidOutput",
          recovered: true,
          recovery: "fallback",
        },
        {
          phase: "respond",
          category: "deadline",
          recovered: false,
        },
      ],
    };
    expect(() =>
      assertEnvelopeContract(JSON.stringify(envelope)),
    ).not.toThrow();
    expect(() =>
      assertEnvelopeContract(JSON.stringify({ ...envelope, version: 2 })),
    ).toThrow("incompatible envelope");
    expect(() =>
      assertEnvelopeContract(JSON.stringify({
        ...envelope,
        modelIncidents: [{
          phase: "unknown",
          category: "invalidOutput",
          recovered: false,
        }],
      })),
    ).toThrow("modelIncidents.0.phase");
  });
});
