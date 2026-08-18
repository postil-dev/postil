import { describe, expect, test } from "bun:test";

import {
  classifyOperationalModelIncidents,
  computeEffectiveGate,
  gateCheckConclusionForEnvelope,
  hasLegacyCombinedModelUsage,
  ingestEnvelope,
  reviewAdmissionSchema,
  type Envelope,
} from "@/lib/envelope";

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
    expect(ingested.usageAccountingComplete).toBe(false);
    // Stored verbatim.
    expect(ingested.envelope).toEqual(validEnvelope());
  });

  test("preserves explicit complete accounting", () => {
    expect(
      ingestEnvelope(JSON.stringify(validEnvelope({ usageAccountingComplete: true })))
        .usageAccountingComplete,
    ).toBe(true);
  });

  test("preserves deterministic coverage and hosted admission records", () => {
    const reviewCoverage = {
      mode: "bounded" as const,
      selectedBatches: 4,
      totalBatches: 12,
      plannerFallback: false,
    };
    const reviewAdmission = {
      providerAttempts: 8,
      serializedInputBytes: 240_000,
      outputTokens: 32_000,
      projectedCostMicros: 42_000,
    };
    const ingested = ingestEnvelope(
      JSON.stringify(validEnvelope({ reviewCoverage, reviewAdmission })),
    ).envelope;
    expect(ingested.reviewCoverage).toEqual(reviewCoverage);
    expect(ingested.reviewAdmission).toEqual(reviewAdmission);
  });

  test("rejects internally inconsistent deterministic coverage records", () => {
    const envelope = validEnvelope({
      reviewCoverage: {
        mode: "bounded",
        selectedBatches: 5,
        totalBatches: 4,
        plannerFallback: false,
      },
    });
    expect(() => ingestEnvelope(JSON.stringify(envelope))).toThrow(
      /selected review batches cannot exceed total batches/,
    );
  });

  test("preserves retained suppressed findings and their policy reasons", () => {
    const suppressedFinding = {
      finding: {
        path: "src/billing/invoice.ts",
        line: 90,
        severity: "info" as const,
        kind: "risk" as const,
        confidence: 0.45,
        title: "Retry signal is ambiguous",
        body: "The retry result does not distinguish a duplicate request.",
      },
      reason: "belowConfidence" as const,
    };
    const ingested = ingestEnvelope(
      JSON.stringify(validEnvelope({ suppressedFindings: [suppressedFinding] })),
    );
    expect(ingested.envelope.suppressedFindings).toEqual([suppressedFinding]);
  });

  test("accepts the CLI non-actionable suppression reason", () => {
    const suppressedFinding = {
      finding: {
        path: "src/billing/invoice.ts",
        line: 92,
        severity: "info" as const,
        kind: "risk" as const,
        confidence: 0.8,
        title: "No concrete action",
        body: "The finding does not identify a change that needs correction.",
      },
      reason: "nonActionable" as const,
    };
    const ingested = ingestEnvelope(
      JSON.stringify(validEnvelope({ suppressedFindings: [suppressedFinding] })),
    );
    expect(ingested.envelope.suppressedFindings).toEqual([suppressedFinding]);
  });

  test("accepts the CLI review-precision suppression reasons", () => {
    // Ingestion validates the envelope strictly, so a reason the CLI emits and
    // this schema does not list fails the whole review rather than one finding.
    const reasons = [
      "anchorMismatch",
      "duplicateRootCause",
      "derivedFromSuppressed",
    ] as const;
    const suppressedFindings = reasons.map((reason, index) => ({
      finding: {
        path: "ansible/playbooks/backup.yml",
        line: 981 + index,
        severity: "error" as const,
        kind: "risk" as const,
        confidence: 0.6,
        title: "Password task drops no_log",
        body: "The cited line holds an unrelated task.",
      },
      reason,
    }));
    const ingested = ingestEnvelope(
      JSON.stringify(validEnvelope({ suppressedFindings })),
    );
    expect(ingested.envelope.suppressedFindings).toEqual(suppressedFindings);
  });

  test("preserves exact model incidents and enforces recovery consistency", () => {
    const modelIncidents = [
      {
        phase: "planner" as const,
        category: "invalidOutput" as const,
        recovered: true,
        recovery: "fallback" as const,
      },
      {
        phase: "scorer" as const,
        category: "invalidOutput" as const,
        recovered: true,
        recovery: "repair" as const,
      },
      {
        phase: "review" as const,
        category: "timeout" as const,
        recovered: true,
        recovery: "fallback" as const,
      },
      {
        phase: "review" as const,
        category: "deadline" as const,
        recovered: false,
      },
      {
        phase: "scorer" as const,
        category: "providerError" as const,
        recovered: false,
      },
      {
        phase: "respond" as const,
        category: "deadline" as const,
        recovered: false,
      },
    ];
    expect(
      ingestEnvelope(JSON.stringify(validEnvelope({ modelIncidents }))).envelope
        .modelIncidents,
    ).toEqual(modelIncidents);

    for (const invalidIncident of [
      { phase: "review", category: "timeout", recovered: true },
      {
        phase: "review",
        category: "timeout",
        recovered: false,
        recovery: "fallback",
      },
    ]) {
      expect(() =>
        ingestEnvelope(
          JSON.stringify({ ...validEnvelope(), modelIncidents: [invalidIncident] }),
        ),
      ).toThrow(/recovery must be present exactly when the incident recovered/);
    }
  });

  test("classifies only typed incidents and exact operational sentinel paths", () => {
    const hostile = "private@example.test raw-provider raw-model raw-repo raw-finding";
    const rawEnvelope = validEnvelope({
      findings: [
        {
          path: ".postil/provider",
          line: 1,
          severity: "error",
          kind: "uncertainty",
          confidence: 1,
          title: hostile,
          body: hostile,
        },
        {
          path: ".postil/model-output",
          line: 1,
          severity: "error",
          kind: "uncertainty",
          confidence: 1,
          title: hostile,
          body: hostile,
        },
        {
          path: ".postil/operational",
          line: 1,
          severity: "error",
          kind: "uncertainty",
          confidence: 1,
          title: hostile,
          body: hostile,
        },
        {
          path: ".postil/provider-near-match",
          line: 1,
          severity: "error",
          kind: "uncertainty",
          confidence: 1,
          title: hostile,
          body: hostile,
        },
      ],
      modelIncidents: [
        {
          phase: "review",
          category: "providerError",
          recovered: false,
        },
        {
          phase: "scorer",
          category: "timeout",
          recovered: true,
          recovery: "fallback",
        },
      ],
    }) as Envelope & { modelIncidents: Array<Record<string, unknown>> };
    rawEnvelope.modelIncidents[1]!.provider = hostile;
    rawEnvelope.modelIncidents[1]!.model = hostile;

    const ingested = ingestEnvelope(JSON.stringify(rawEnvelope)).envelope;
    const classifications = classifyOperationalModelIncidents(ingested);
    expect(classifications).toEqual([
      {
        phase: "review",
        category: "providerError",
        recovered: false,
        source: "model_incident",
      },
      {
        phase: "scorer",
        category: "timeout",
        recovered: true,
        recovery: "fallback",
        source: "model_incident",
      },
      {
        phase: "review",
        category: "invalidOutput",
        recovered: false,
        source: "model_output_sentinel",
      },
      {
        phase: "review",
        category: "operational",
        recovered: false,
        source: "operational_sentinel",
      },
    ]);
    expect(JSON.stringify(classifications)).not.toContain(hostile);
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

  test("accepts duplicate model rows with matching aggregate totals", () => {
    const exact = validEnvelope({
      modelUsage: [
        { model: "shared-model", promptTokens: 4000, completionTokens: 300 },
        { model: "shared-model", promptTokens: 200, completionTokens: 10 },
      ],
    });

    expect(ingestEnvelope(JSON.stringify(exact)).modelUsage).toEqual(exact.modelUsage!);
  });

  test("identifies only scorer runs that predate per-model usage attribution", () => {
    const legacy = validEnvelope({ scorerModel: "independent/model" });
    expect(hasLegacyCombinedModelUsage(legacy)).toBe(true);
    expect(
      hasLegacyCombinedModelUsage(
        validEnvelope({ scorerError: "independent check failed" }),
      ),
    ).toBe(true);
    expect(
      hasLegacyCombinedModelUsage({
        ...legacy,
        modelUsage: [
          {
            model: "reviewer/model",
            promptTokens: 4000,
            completionTokens: 300,
          },
          {
            model: "independent/model",
            promptTokens: 200,
            completionTokens: 10,
          },
        ],
      }),
    ).toBe(false);
    expect(hasLegacyCombinedModelUsage(validEnvelope())).toBe(false);
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

    expect(() => ingestEnvelope(JSON.stringify(env))).toThrow(
      "duplicate finding id",
    );
  });
});

describe("effective gate recomputation", () => {
  test("does not let a declared pass suppress an admitted blocker", () => {
    const env = validEnvelope({
      gate: {
        failOn: "error",
        failing: false,
        blockOnKinds: ["humanEscalation"],
      },
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

    expect(computeEffectiveGate(env, new Set()).failing).toBe(true);
    expect(() => ingestEnvelope(JSON.stringify(env))).toThrow(/gate\.failing/);
  });

  test("keeps advisory findings passing alongside a blocking finding", () => {
    const env = validEnvelope({
      gate: { failOn: "error", failing: true, blockOnKinds: [] },
      findings: [
        {
          id: "advisory",
          path: "src/app.ts",
          line: 1,
          severity: "warn",
          kind: "risk",
          confidence: 0.8,
          title: "Worth checking",
          body: "This finding remains advisory.",
        },
        {
          id: "blocking",
          path: "src/db.ts",
          line: 2,
          severity: "error",
          kind: "risk",
          confidence: 0.9,
          title: "Breaks writes",
          body: "This finding blocks the gate.",
        },
      ],
      counts: { info: 0, warn: 1, error: 1, suppressed: 0, ungrounded: 0 },
    });

    const state = computeEffectiveGate(env, new Set());
    expect(state.blockers.map(({ findingId }) => findingId)).toEqual([
      "blocking",
    ]);
    expect(gateCheckConclusionForEnvelope(env, new Set(), true)).toBe(
      "failure",
    );
  });

  test("blocks carried findings only while they remain active", () => {
    const carried = {
      id: "carried-blocker",
      path: "src/cache.ts",
      line: 8,
      severity: "error" as const,
      kind: "risk" as const,
      confidence: 0.94,
      title: "Cache invalidation can lose writes",
      body: "[carried from previous review]\nThe active defect remains in this head.",
    };
    const activeEnvelope = validEnvelope({
      gate: { failOn: "error", failing: true, blockOnKinds: [] },
      findings: [carried],
      resolved: [],
      counts: { info: 0, warn: 0, error: 1, suppressed: 0, ungrounded: 0 },
    });
    const resolvedEnvelope = validEnvelope({
      gate: { failOn: "error", failing: false, blockOnKinds: [] },
      findings: [],
      resolved: [carried],
      counts: { info: 0, warn: 0, error: 0, suppressed: 0, ungrounded: 0 },
    });

    expect(
      gateCheckConclusionForEnvelope(activeEnvelope, new Set(), true),
    ).toBe("failure");
    expect(
      gateCheckConclusionForEnvelope(resolvedEnvelope, new Set(), true),
    ).toBe("success");
  });

  test("reports an operational advisory as unavailable instead of passing", () => {
    const env = validEnvelope({
      gate: { failOn: "error", failing: false, blockOnKinds: [] },
      findings: [
        {
          id: "provider-unavailable",
          path: ".postil/provider",
          line: 1,
          severity: "error",
          kind: "uncertainty",
          confidence: 1,
          title: "Review unavailable",
          body: "The review provider did not return a usable result.",
        },
      ],
      counts: { info: 0, warn: 0, error: 1, suppressed: 0, ungrounded: 0 },
    });

    const state = computeEffectiveGate(env, new Set());
    expect(state).toMatchObject({ failing: false, unavailable: true });
    expect(gateCheckConclusionForEnvelope(env, new Set(), true)).toBe(
      "neutral",
    );
    expect(ingestEnvelope(JSON.stringify(env)).gateFailing).toBe(false);
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

  test("dismissal clears both severity and kind blocking for only its finding", () => {
    const env = validEnvelope({
      findings: [
        { id: "dismissed", ...validEnvelope().findings[0]!, kind: "humanEscalation" },
        { id: "remaining", ...validEnvelope().findings[0]! },
      ],
      gate: { failOn: "error", failing: true, blockOnKinds: ["humanEscalation"] },
    });
    const state = computeEffectiveGate(env, new Set(), new Set(["dismissed"]));
    expect(state.failing).toBe(true);
    expect(state.blockers.map((blocker) => blocker.findingId)).toEqual(["remaining"]);
    expect(
      gateCheckConclusionForEnvelope(
        env,
        new Set(),
        true,
        new Set(["dismissed", "remaining"]),
      ),
    ).toBe("success");
  });

  test("operational sentinels remain blocking even when their id is dismissed", () => {
    const env = validEnvelope({
      findings: [{ id: "sentinel", ...validEnvelope().findings[0]!, path: ".postil/operational" }],
    });
    expect(computeEffectiveGate(env, new Set(), new Set(["sentinel"])).failing).toBe(true);
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

describe("review admission bounds", () => {
  test("accepts the worst-case plan the CLI is willing to run", () => {
    const parsed = reviewAdmissionSchema.safeParse({
      providerAttempts: 84,
      serializedInputBytes: 9_684_902,
      outputTokens: 472_640,
      // The shipped hosted profile projects about this much; a bound at the
      // per-review spend limit rejected every hosted review.
      projectedCostMicros: 15_638_530,
    });
    expect(parsed.success).toBe(true);
  });

  test("still rejects a projection beyond the admission ceiling", () => {
    const parsed = reviewAdmissionSchema.safeParse({
      providerAttempts: 84,
      serializedInputBytes: 9_684_902,
      outputTokens: 472_640,
      projectedCostMicros: 25_000_001,
    });
    expect(parsed.success).toBe(false);
  });
});
