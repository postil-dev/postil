import { describe, expect, test } from "bun:test";

import { computeEffectiveGate, ingestEnvelope, type Envelope } from "@/lib/envelope";

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
    gate: { failOn: "error", failing: true, blockOnKinds: [] },
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
    expect(ingested.modelUsage).toBeNull();
    // Stored verbatim.
    expect(ingested.envelope).toEqual(validEnvelope());
  });

  test("accepts exact per-model usage and rejects mismatched aggregates", () => {
    const exact = validEnvelope({
      modelUsage: [
        { model: "generator", promptTokens: 4000, completionTokens: 300 },
        { model: "scorer", promptTokens: 200, completionTokens: 10 },
      ],
    });
    expect(ingestEnvelope(JSON.stringify(exact)).modelUsage).toEqual(exact.modelUsage!);

    const mismatched = validEnvelope({
      modelUsage: [{ model: "generator", promptTokens: 1, completionTokens: 1 }],
    });
    expect(() => ingestEnvelope(JSON.stringify(mismatched))).toThrow(
      /per-model token totals must match aggregate usage/,
    );
  });

  test("ingests a silent envelope", () => {
    const silent = validEnvelope({
      summary: "",
      silent: true,
      findings: [],
      counts: { info: 0, warn: 0, error: 0, suppressed: 0, ungrounded: 0 },
      confidenceBuckets: [0, 0, 0, 0, 0],
      gate: { failOn: "error", failing: false, blockOnKinds: [] },
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
      gate: { failOn: "error", failing: false, blockOnKinds: [] },
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

  test("rejects duplicate stable finding ids", () => {
    const env = validEnvelope({
      findings: [
        {
          id: "duplicate-id",
          path: "src/app.ts",
          line: 10,
          severity: "warn",
          kind: "humanEscalation",
          confidence: 0.9,
          title: "First escalation",
          body: "Needs review.",
        },
        {
          id: "duplicate-id",
          path: "src/db.ts",
          line: 20,
          severity: "warn",
          kind: "humanEscalation",
          confidence: 0.9,
          title: "Second escalation",
          body: "Needs review too.",
        },
      ],
      counts: { info: 0, warn: 2, error: 0, suppressed: 0, ungrounded: 0 },
    });

    expect(() => ingestEnvelope(JSON.stringify(env))).toThrow("duplicate finding id");
  });
});

describe("effective gate recomputation", () => {
  test("does not fail when the engine gate did not fail", () => {
    const env = validEnvelope({
      gate: { failOn: "error", failing: false, blockOnKinds: ["humanEscalation"] },
      findings: [
        {
          id: "kind-only",
          path: "src/app.ts",
          line: 1,
          severity: "warn",
          kind: "humanEscalation",
          confidence: 0.8,
          title: "Needs human approval",
          body: "Escalated by policy.",
        },
      ],
    });

    expect(computeEffectiveGate(env, new Set(), false).failing).toBe(false);
  });

  test("active approval clears kind-only blockers", () => {
    const env = validEnvelope({
      gate: { failOn: "error", failing: true, blockOnKinds: ["humanEscalation"] },
      findings: [
        {
          id: "kind-only",
          path: "src/app.ts",
          line: 1,
          severity: "warn",
          kind: "humanEscalation",
          confidence: 0.8,
          title: "Needs human approval",
          body: "Escalated by policy.",
        },
      ],
      counts: { info: 0, warn: 1, error: 0, suppressed: 0, ungrounded: 0 },
    });

    expect(computeEffectiveGate(env, new Set()).failing).toBe(true);
    expect(computeEffectiveGate(env, new Set(["kind-only"])).failing).toBe(false);
  });

  test("low-confidence human escalations never block through kind or severity", () => {
    const env = validEnvelope({
      gate: { failOn: "error", failing: true, blockOnKinds: ["humanEscalation"] },
      findings: [
        {
          id: "weak-escalation",
          path: "src/app.ts",
          line: 1,
          severity: "error",
          kind: "humanEscalation",
          confidence: 0.05,
          title: "Verify this function",
          body: "Ask a human to verify this generic function works.",
        },
      ],
    });

    const state = computeEffectiveGate(env, new Set());
    expect(state.failing).toBe(false);
    expect(state.blockers).toEqual([]);
    expect(state.kindBlockers).toEqual([]);
  });

  test("active approval clears kind-only blockers from CLI v0.3 block_on_kinds", () => {
    const env = validEnvelope({
      gate: { failOn: "error", failing: true, block_on_kinds: ["humanEscalation"] },
      findings: [
        {
          id: "kind-only",
          path: "src/app.ts",
          line: 1,
          severity: "warn",
          kind: "humanEscalation",
          confidence: 0.8,
          title: "Needs human approval",
          body: "Escalated by policy.",
        },
      ],
      counts: { info: 0, warn: 1, error: 0, suppressed: 0, ungrounded: 0 },
    });

    expect(computeEffectiveGate(env, new Set()).kindBlockers).toHaveLength(1);
    expect(computeEffectiveGate(env, new Set(["kind-only"])).failing).toBe(false);
  });

  test("approval does not clear severity blockers on the same finding", () => {
    const env = validEnvelope({
      gate: { failOn: "error", failing: true, blockOnKinds: ["humanEscalation"] },
      findings: [
        {
          id: "kind-and-severity",
          path: "src/app.ts",
          line: 1,
          severity: "error",
          kind: "humanEscalation",
          confidence: 0.8,
          title: "Needs human approval",
          body: "Escalated by policy.",
        },
      ],
    });

    const state = computeEffectiveGate(env, new Set(["kind-and-severity"]));
    expect(state.failing).toBe(true);
    expect(state.blockers[0]?.severityBlocking).toBe(true);
  });

  test("all blockers must clear before the effective gate passes", () => {
    const env = validEnvelope({
      gate: { failOn: "error", failing: true, blockOnKinds: ["humanEscalation"] },
      findings: [
        {
          id: "kind-only",
          path: "src/app.ts",
          line: 1,
          severity: "warn",
          kind: "humanEscalation",
          confidence: 0.8,
          title: "Needs human approval",
          body: "Escalated by policy.",
        },
        {
          id: "severity-only",
          path: "src/db.ts",
          line: 2,
          severity: "error",
          kind: "risk",
          confidence: 0.9,
          title: "Breaks writes",
          body: "Severity still blocks.",
        },
      ],
      counts: { info: 0, warn: 1, error: 1, suppressed: 0, ungrounded: 0 },
    });

    const state = computeEffectiveGate(env, new Set(["kind-only"]));
    expect(state.failing).toBe(true);
    expect(state.blockers.map((blocker) => blocker.findingId)).toEqual(["severity-only"]);
  });
});
