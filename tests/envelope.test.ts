import { describe, expect, test } from "bun:test";

import { ingestEnvelope, type Envelope } from "@/lib/envelope";

function validEnvelope(overrides: Partial<Envelope> = {}): Envelope {
  return {
    version: 1,
    summary: "One refund-path risk worth a look before merge.",
    silent: false,
    findings: [
      {
        path: "src/billing/invoice.ts",
        line: 84,
        endLine: 88,
        severity: "error",
        kind: "risk",
        confidence: 0.91,
        title: "Refund path skips idempotency key",
        body: "A retried webhook double-credits the customer.",
      },
    ],
    resolved: [],
    counts: { info: 0, warn: 0, error: 1, suppressed: 2, ungrounded: 0 },
    confidenceBuckets: [0, 0, 0, 0, 1],
    gate: { failOn: "error", failing: true },
    modelUsed: "deepseek/deepseek-v4-pro",
    usage: { promptTokens: 4200, completionTokens: 310 },
    durationMs: 6100,
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    sinceSha: null,
    ...overrides,
  };
}

describe("envelope ingestion", () => {
  test("ingests a valid envelope and derives columns", () => {
    const ingested = ingestEnvelope(JSON.stringify(validEnvelope()));
    expect(ingested.silent).toBe(false);
    expect(ingested.gateFailing).toBe(true);
    expect(ingested.findingCount).toBe(1);
    expect(ingested.promptTokens).toBe(4200);
    expect(ingested.completionTokens).toBe(310);
    expect(ingested.modelUsed).toBe("deepseek/deepseek-v4-pro");
    // Stored verbatim.
    expect(ingested.envelope).toEqual(validEnvelope());
  });

  test("ingests a silent envelope", () => {
    const silent = validEnvelope({
      summary: "",
      silent: true,
      findings: [],
      counts: { info: 0, warn: 0, error: 0, suppressed: 0, ungrounded: 0 },
      confidenceBuckets: [0, 0, 0, 0, 0],
      gate: { failOn: "error", failing: false },
    });
    const ingested = ingestEnvelope(JSON.stringify(silent));
    expect(ingested.silent).toBe(true);
    expect(ingested.gateFailing).toBe(false);
    expect(ingested.findingCount).toBe(0);
  });

  test("rejects non-JSON output", () => {
    expect(() => ingestEnvelope("thread 'main' panicked at src/main.rs")).toThrow(
      "not valid JSON",
    );
  });

  test("rejects a wrong version", () => {
    const wrong = { ...validEnvelope(), version: 2 };
    expect(() => ingestEnvelope(JSON.stringify(wrong))).toThrow("envelope schema v1");
  });

  test("ingests a contentPolicy finding (CLI >= v0.1.2)", () => {
    const withPolicy = validEnvelope({
      findings: [
        {
          path: ".postil/pr-description",
          line: 2,
          severity: "warn",
          kind: "contentPolicy",
          confidence: 0.9,
          title: "Fabricated adoption claim",
          body: "The description asserts unverifiable user counts.",
        },
      ],
      counts: { info: 0, warn: 1, error: 0, suppressed: 0, ungrounded: 0 },
      gate: { failOn: "error", failing: false },
    });
    const ingested = ingestEnvelope(JSON.stringify(withPolicy));
    expect(ingested.findingCount).toBe(1);
    expect(ingested.envelope.findings.map((f) => f.kind)).toEqual(["contentPolicy"]);
  });

  test("rejects schema violations with a precise path", () => {
    const bad = validEnvelope();
    // severity outside the enum
    (bad.findings[0] as { severity: string }).severity = "critical";
    expect(() => ingestEnvelope(JSON.stringify(bad))).toThrow(/findings\.0\.severity/);
  });

  test("rejects out-of-range confidence", () => {
    const bad = validEnvelope();
    (bad.findings[0] as { confidence: number }).confidence = 1.4;
    expect(() => ingestEnvelope(JSON.stringify(bad))).toThrow("envelope schema v1");
  });

  test("rejects a malformed confidenceBuckets tuple", () => {
    const bad = { ...validEnvelope(), confidenceBuckets: [0, 0, 0] };
    expect(() => ingestEnvelope(JSON.stringify(bad))).toThrow("envelope schema v1");
  });

  test("accepts findings without endLine (optional)", () => {
    const env = validEnvelope();
    delete (env.findings[0] as { endLine?: number }).endLine;
    const ingested = ingestEnvelope(JSON.stringify(env));
    expect(ingested.findingCount).toBe(1);
  });
});
