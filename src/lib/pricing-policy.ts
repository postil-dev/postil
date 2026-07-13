export const HOSTED_ACTIVE_AUTHOR_MONTHLY_USD = 15;
export const HOSTED_INFERENCE_ALLOWANCE_USD = 6;
export const BYOK_ACTIVE_AUTHOR_MONTHLY_USD = 9;
export function calculatePostilPricing(activeAuthors: number) {
  const authors = Math.max(0, Math.floor(activeAuthors));

  return {
    activeAuthors: authors,
    hostedMonthlyUsd: authors * HOSTED_ACTIVE_AUTHOR_MONTHLY_USD,
    hostedInferenceAllowanceUsd:
      authors * HOSTED_INFERENCE_ALLOWANCE_USD,
    byokMonthlyUsd: authors * BYOK_ACTIVE_AUTHOR_MONTHLY_USD,
  };
}
