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
  path: z.string(),
  line: z.number().int(),
  endLine: z.number().int().optional(),
  severity: severitySchema,
  kind: findingKindSchema,
  confidence: z.number().min(0).max(1),
  title: z.string(),
  body: z.string(),
});

export const envelopeSchema = z.object({
  version: z.literal(1),
  summary: z.string(),
  silent: z.boolean(),
  findings: z.array(findingSchema),
  resolved: z.array(findingSchema),
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
  }),
  modelUsed: z.string(),
  usage: z.object({
    promptTokens: z.number().int().nonnegative(),
    completionTokens: z.number().int().nonnegative(),
  }),
  // Engine wall-clock duration in milliseconds (0 when emitted by older CLIs).
  durationMs: z.number().int().nonnegative().optional().default(0),
  baseSha: z.string(),
  headSha: z.string(),
  sinceSha: z.string().nullable(),
});

export type Severity = z.infer<typeof severitySchema>;
export type FindingKind = z.infer<typeof findingKindSchema>;
export type Finding = z.infer<typeof findingSchema>;
export type Envelope = z.infer<typeof envelopeSchema>;

export interface IngestedEnvelope {
  envelope: Envelope;
  silent: boolean;
  gateFailing: boolean;
  findingCount: number;
  promptTokens: number;
  completionTokens: number;
  modelUsed: string;
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
  };
}
