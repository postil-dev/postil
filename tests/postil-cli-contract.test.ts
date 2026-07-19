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
      baseSha: "2".repeat(40),
      headSha: "1".repeat(40),
      silent: true,
      findings: [],
    };
    expect(() =>
      assertEnvelopeContract(JSON.stringify(envelope)),
    ).not.toThrow();
    expect(() =>
      assertEnvelopeContract(JSON.stringify({ ...envelope, version: 2 })),
    ).toThrow("incompatible envelope");
  });
});
