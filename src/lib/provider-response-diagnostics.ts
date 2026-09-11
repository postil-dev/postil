// https://openrouter.ai/docs/api_reference/errors-and-debugging#typed-error-codes
const ERROR_TYPES = new Set([
  "context_length_exceeded", "max_tokens_exceeded", "token_limit_exceeded", "string_too_long",
  "authentication", "permission_denied", "payment_required",
  "rate_limit_exceeded", "provider_overloaded", "provider_unavailable",
  "invalid_request", "invalid_prompt", "not_found", "precondition_failed",
  "payload_too_large", "unprocessable", "content_policy_violation", "refusal",
  "invalid_image", "image_too_large", "image_too_small", "unsupported_image_format",
  "image_not_found", "image_download_failed", "server", "timeout", "unmapped",
  "api_error", "authentication_error", "authorization_error", "billing_error",
  "credits_exhausted", "insufficient_credits", "insufficient_quota",
  "invalid_request_error", "key_limit_exceeded", "not_found_error",
  "overloaded_error", "permission_error", "provider_error", "rate_limit_error",
  "server_error", "timeout_error",
]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Content-free classification; provider messages and identifiers never enter logs. */
export function providerResponseErrorDiagnostic(value: unknown) {
  const envelope = record(value);
  if (!envelope) return null;
  let error = record(envelope.error);
  if (!error && Array.isArray(envelope.choices)) {
    for (const candidate of envelope.choices) {
      const choice = record(candidate);
      if (choice?.finish_reason !== "error") continue;
      error = record(choice.error);
      if (error) break;
    }
  }
  if (!error) {
    return null;
  }
  const metadata = record(error.metadata);
  const rawType = metadata?.error_type ?? error.error_type ?? error.type;
  const errorType = typeof rawType === "string" ? rawType.trim().toLowerCase() : "";
  const code = error.code;
  return {
    error_category: "upstream_error" as const,
    error_type: ERROR_TYPES.has(errorType) ? errorType : "reported",
    error_code: typeof code === "number" && Number.isInteger(code) && code >= 100 && code <= 599
      ? code
      : null,
    model_present: typeof envelope.model === "string" && envelope.model.length > 0,
    provider_present: typeof envelope.provider === "string" && envelope.provider.length > 0,
    usage_present: record(envelope.usage) !== null,
  };
}

export type ProviderResponseErrorDiagnostic = NonNullable<
  ReturnType<typeof providerResponseErrorDiagnostic>
>;
