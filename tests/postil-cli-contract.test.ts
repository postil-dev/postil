import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  assertPublicationControllerCapabilityProbe,
  assertEnvelopeContract,
  assertReviewHelp,
} from "../scripts/verify-postil-cli-contract";

describe("postil CLI release contract", () => {
  test("requires the exact pure publication-plan capability response", () => {
    expect(() => assertPublicationControllerCapabilityProbe({
      exitCode: 0,
      stderr: "",
      stdout: "github-publication-v1\n",
    })).not.toThrow();
    expect(() => assertPublicationControllerCapabilityProbe({
      exitCode: 0,
      stderr: "",
      stdout: "github-publication-v2\n",
    })).toThrow("github-publication-v1 capability");
    expect(() => assertPublicationControllerCapabilityProbe({
      exitCode: 2,
      stderr: "unknown argument",
      stdout: "",
    })).toThrow("github-publication-v1 capability");
  });

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

  test("contract smoke rejects a target-branch advance before check mutation", () => {
    const source = readFileSync("scripts/verify-postil-cli-contract.ts", "utf8");
    const advanced = source.indexOf("liveBaseSha = ADVANCED_BASE_SHA");
    const staleRejection = source.indexOf(
      "hosted publication accepted a changed target-branch SHA",
      advanced,
    );
    const mutationRejection = source.indexOf(
      "hosted publication mutated checks after the target branch advanced",
      staleRejection,
    );

    expect(advanced).toBeGreaterThan(0);
    expect(staleRejection).toBeGreaterThan(advanced);
    expect(mutationRejection).toBeGreaterThan(staleRejection);
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
