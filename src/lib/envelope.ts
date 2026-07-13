import { z } from "zod";

/**
 * Frozen envelope schema, version 1.
 *
 * This is the JSON the `postil` CLI writes to stdout with --output-json.
 * The control plane stores it verbatim (jsonb) and derives only a few
 * denormalized columns (silent, gateFailing) for querying. Reshaping or
 * removing fields requires a version bump in the CLI contract; optional
 * additive fields (absent meaning zero) are allowed within v1 and must be
 * mirrored here, or the default-stripping parse drops them from storage.
 */

export const severitySchema = z.enum(["info", "warn", "error"]);
export const findingKindSchema = z.enum([
  "risk",
  "humanEscalation",
  "guardrail",
  "uncertainty",
  // Opt-in prose/content review dimension (CLI >= v0.1.2). Missing here
  // meant ingestion rejected the whole envelope and the review failed
  // closed the first time a repo with a content policy produced a finding.
  "contentPolicy",
]);

export const findingSchema = z.object({
  id: z.string().min(1).optional(),
  path: z.string(),
  line: z.number().int(),
  endLine: z.number().int().optional(),
  severity: severitySchema,
  kind: findingKindSchema,
  confidence: z.number().min(0).max(1),
  generatorConfidence: z.number().min(0).max(1).optional(),
  scorerConfidence: z.number().min(0).max(1).optional(),
  generatorKind: findingKindSchema.optional(),
  scorerKind: findingKindSchema.optional(),
  scorerReason: z.string().optional(),
  title: z.string(),
  body: z.string(),
});

export const suppressionReasonSchema = z.enum([
  "ignored",
  "belowSeverity",
  "belowConfidence",
  "maxFindings",
]);

export const suppressedFindingSchema = z.object({
  finding: findingSchema,
  reason: suppressionReasonSchema,
});

export const modelIncidentSchema = z.object({
  phase: z.enum(["review", "scorer"]),
  category: z.enum(["providerError", "invalidOutput", "timeout", "deadline"]),
  recovered: z.boolean(),
  recovery: z.enum(["repair", "fallback"]).optional(),
});

export const envelopeSchema = z
  .object({
    version: z.literal(1),
    summary: z.string(),
    silent: z.boolean(),
    findings: z.array(findingSchema),
    resolved: z.array(findingSchema),
    // CLI >= v0.5.1 retains policy-suppressed details for the authenticated run
    // page. Older envelopes expose only counts.suppressed.
    suppressedFindings: z.array(suppressedFindingSchema).optional(),
    counts: z.object({
      info: z.number().int().nonnegative(),
      warn: z.number().int().nonnegative(),
      error: z.number().int().nonnegative(),
      suppressed: z.number().int().nonnegative(),
      // Model findings dropped for not citing a changed line (model-quality signal).
      ungrounded: z.number().int().nonnegative().optional().default(0),
    }),
    // Counts in [0-.2, .2-.4, .4-.6, .6-.8, .8-1].
    confidenceBuckets: z.tuple([
      z.number().int().nonnegative(),
      z.number().int().nonnegative(),
      z.number().int().nonnegative(),
      z.number().int().nonnegative(),
      z.number().int().nonnegative(),
    ]),
    gate: z.object({
      failOn: severitySchema,
      failing: z.boolean(),
      blockOnKinds: z.array(findingKindSchema).optional(),
      block_on_kinds: z.array(findingKindSchema).optional(),
    }),
    modelUsed: z.string(),
    scorerModel: z.string().optional(),
    scorerError: z.string().optional(),
    scorerDisagreements: z.number().int().nonnegative().optional(),
    usage: z.object({
      promptTokens: z.number().int().nonnegative(),
      completionTokens: z.number().int().nonnegative(),
    }),
    modelUsage: z
      .array(
        z.object({
          model: z.string().trim().min(1),
          promptTokens: z.number().int().nonnegative(),
          completionTokens: z.number().int().nonnegative(),
        }),
      )
      .optional(),
    // CLI >= v0.5.1 emits safe structured degradation signals. Raw provider
    // responses and generated content never enter this monitoring field.
    modelIncidents: z.array(modelIncidentSchema).optional(),
    usageAccountingComplete: z.boolean().optional(),
    // Engine wall-clock duration in milliseconds (0 when emitted by older CLIs).
    durationMs: z.number().int().nonnegative().optional().default(0),
    baseSha: z.string(),
    headSha: z.string(),
    sinceSha: z.string().nullable(),
  })
  .superRefine((envelope, ctx) => {
    if (envelope.modelUsage) {
      const totals = envelope.modelUsage.reduce(
        (sum, entry) => ({
          promptTokens: sum.promptTokens + entry.promptTokens,
          completionTokens: sum.completionTokens + entry.completionTokens,
        }),
        { promptTokens: 0, completionTokens: 0 },
      );
      if (
        totals.promptTokens !== envelope.usage.promptTokens ||
        totals.completionTokens !== envelope.usage.completionTokens
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["modelUsage"],
          message: "per-model token totals must match aggregate usage",
        });
      }
    }
    const seen = new Map<string, number>();
    envelope.findings.forEach((finding, index) => {
      const id = findingStableId(finding);
      if (!id) return;
      const firstIndex = seen.get(id);
      if (firstIndex === undefined) {
        seen.set(id, index);
        return;
      }
      ctx.addIssue({
        code: "custom",
        path: ["findings", index, "id"],
        message: `duplicate finding id also used at findings.${firstIndex}.id`,
      });
    });
    envelope.modelIncidents?.forEach((incident, index) => {
      if (incident.recovered === Boolean(incident.recovery)) return;
      ctx.addIssue({
        code: "custom",
        path: ["modelIncidents", index, "recovery"],
        message: "recovery must be present exactly when the incident recovered",
      });
    });
  });

export type Severity = z.infer<typeof severitySchema>;
export type FindingKind = z.infer<typeof findingKindSchema>;
export type Finding = z.infer<typeof findingSchema>;
export type SuppressionReason = z.infer<typeof suppressionReasonSchema>;
export type SuppressedFinding = z.infer<typeof suppressedFindingSchema>;
export type Envelope = z.infer<typeof envelopeSchema>;

const SEVERITY_RANK: Record<Severity, number> = { error: 0, warn: 1, info: 2 };

export const HUMAN_ESCALATION_GATE_MIN_CONFIDENCE = 0.3;

/**
 * Human escalations are intentionally held to a separate, low confidence
 * floor before they can block. Confidence is the calibrated signal
 * shared by the generator and scorer; matching prose templates would be more
 * brittle and could suppress a terse but genuine request for human judgment.
 */
export function qualifiesHumanEscalation(finding: Finding): boolean {
  return (
    finding.kind === "humanEscalation" &&
    finding.confidence >= HUMAN_ESCALATION_GATE_MIN_CONFIDENCE
  );
}

export interface FindingBlockState {
  finding: Finding;
  findingId: string | null;
  kindBlocking: boolean;
  severityBlocking: boolean;
  approved: boolean;
  blocking: boolean;
}

export interface EffectiveGateState {
  failing: boolean;
  blockers: FindingBlockState[];
  kindBlockers: FindingBlockState[];
}

export interface IngestedEnvelope {
  envelope: Envelope;
  silent: boolean;
  gateFailing: boolean;
  findingCount: number;
  promptTokens: number;
  completionTokens: number;
  modelUsed: string;
  modelUsage: Array<{ model: string; promptTokens: number; completionTokens: number }> | null;
  usageAccountingComplete: boolean;
}

/**
 * Parse and validate CLI stdout into a stored envelope plus the
 * denormalized columns the dashboard queries on. Throws with a precise
 * message on malformed input; callers treat that as an operational
 * failure of the review (fail closed), never as a clean pass.
 */
export function ingestEnvelope(raw: string): IngestedEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `CLI output is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const result = envelopeSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue ? `${issue.path.join(".") || "<root>"}: ${issue.message}` : "unknown";
    throw new Error(`CLI output does not match envelope schema v1 (${where})`);
  }
  const envelope = result.data;
  return {
    envelope,
    silent: envelope.silent,
    gateFailing: envelope.gate.failing,
    findingCount: envelope.findings.length,
    promptTokens: envelope.usage.promptTokens,
    completionTokens: envelope.usage.completionTokens,
    modelUsed: envelope.modelUsed,
    modelUsage: envelope.modelUsage ?? null,
    usageAccountingComplete: envelope.usageAccountingComplete === true,
  };
}

export function severityBlocksGate(severity: Severity, failOn: Severity): boolean {
  return SEVERITY_RANK[severity] <= SEVERITY_RANK[failOn];
}

export function findingStableId(finding: Finding): string | null {
  return finding.id?.trim() || null;
}

export function computeEffectiveGate(
  envelope: Envelope | null | undefined,
  activeApprovalIds: ReadonlySet<string>,
  engineGateFailing = envelope?.gate.failing ?? false,
): EffectiveGateState {
  if (!envelope || !engineGateFailing) {
    return { failing: false, blockers: [], kindBlockers: [] };
  }

  const blockOnKinds = new Set(getGateBlockOnKinds(envelope));
  const states = envelope.findings.map((finding): FindingBlockState => {
    const findingId = findingStableId(finding);
    const approved = Boolean(findingId && activeApprovalIds.has(findingId));
    const escalationEligible =
      finding.kind !== "humanEscalation" || qualifiesHumanEscalation(finding);
    const kindBlocking = escalationEligible && blockOnKinds.has(finding.kind);
    const severityBlocking =
      escalationEligible && severityBlocksGate(finding.severity, envelope.gate.failOn);
    return {
      finding,
      findingId,
      kindBlocking,
      severityBlocking,
      approved,
      blocking: severityBlocking || (kindBlocking && !approved),
    };
  });

  const blockers = states.filter((state) => state.blocking);
  return {
    failing: blockers.length > 0,
    blockers,
    kindBlockers: states.filter((state) => state.kindBlocking),
  };
}

export function getGateBlockOnKinds(envelope: Envelope): FindingKind[] {
  return Array.from(
    new Set([...(envelope.gate.block_on_kinds ?? []), ...(envelope.gate.blockOnKinds ?? [])]),
  );
}
