export const REVIEW_MODEL_RESEARCH_CANDIDATES = [
  "deepseek/deepseek-v4-flash",
  "qwen/qwen3-coder-30b-a3b-instruct",
  "google/gemini-2.5-flash-lite",
  "anthropic/claude-sonnet-4.5",
] as const;

export function parseReviewModelCascade(
  configured: string | undefined,
  fallback: string,
): string[] {
  const raw = configured?.trim() ? configured : fallback;
  const models = raw
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);

  return models.length ? models : [fallback];
}
