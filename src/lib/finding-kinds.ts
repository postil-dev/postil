export const FINDING_KINDS = [
  "risk",
  "humanEscalation",
  "guardrail",
  "uncertainty",
  "contentPolicy",
] as const;

export type FindingKind = (typeof FINDING_KINDS)[number];

export const DEFAULT_BLOCK_ON_KINDS: readonly FindingKind[] = ["humanEscalation"];

export function isFindingKind(value: unknown): value is FindingKind {
  return typeof value === "string" && FINDING_KINDS.includes(value as FindingKind);
}

/** Match the CLI's trimmed, case-insensitive `Kind::parse` configuration behavior. */
export function parseFindingKind(value: unknown): FindingKind | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return FINDING_KINDS.find((kind) => kind.toLowerCase() === normalized) ?? null;
}
