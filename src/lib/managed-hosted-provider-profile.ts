import release from "@/data/public-cli-release.json";

type Environment = Record<string, string | undefined>;

export interface ManagedHostedProviderProfile {
  apiBase: string;
  apiFormat: "openai-compatible";
  model: string;
  providerName: string;
  providerRoute: string;
  reasoningEffort: string;
  maxOutputTokens: number;
  temperature: number;
  maxPromptPrice: number;
  maxCompletionPrice: number;
}

/** Resolve the exact provider profile admitted by the managed CLI gateway. */
export function resolveManagedHostedProviderProfile(
  environment: Environment = process.env,
): ManagedHostedProviderProfile {
  if ((environment.POSTIL_PROVISIONAL_HOSTED_ROSTER ?? "0").trim() !== "1") {
    throw new Error("managed hosted provider profile is not enabled");
  }

  const admitted = release.hostedCliManagedProfile;
  if (
    admitted.model !== release.hostedCliDefaultModel ||
    admitted.apiFormat !== "openai-compatible"
  ) {
    throw new Error("managed hosted provider profile does not match the pinned CLI release");
  }

  const configuredModel = environment.REVIEW_MODEL?.trim();
  const configuredCascade = environment.REVIEW_MODEL_CASCADE?.trim();
  if (
    (configuredModel && configuredModel !== admitted.model) ||
    configuredCascade
  ) {
    throw new Error(
      "managed hosted provider profile requires the exact pinned model roster",
    );
  }

  const apiBase = (environment.POSTIL_API_BASE ?? admitted.apiBase)
    .trim()
    .replace(/\/+$/, "");
  if (apiBase !== admitted.apiBase) {
    throw new Error(
      "managed hosted provider profile requires the approved OpenRouter endpoint",
    );
  }
  const apiFormat = (
    environment.POSTIL_API_FORMAT ?? admitted.apiFormat
  )
    .trim()
    .toLowerCase();
  if (apiFormat !== admitted.apiFormat) {
    throw new Error(
      "managed hosted provider profile requires the OpenAI-compatible API format",
    );
  }

  const reasoningEffort = (
    environment.REVIEW_REASONING_EFFORT ?? admitted.reasoningEffort
  )
    .trim()
    .toLowerCase();
  if (reasoningEffort !== admitted.reasoningEffort) {
    throw new Error(
      `managed hosted provider profile requires reasoning effort ${admitted.reasoningEffort}`,
    );
  }
  const scorerReasoningEffort = (
    environment.REVIEW_SCORER_REASONING_EFFORT ?? admitted.reasoningEffort
  )
    .trim()
    .toLowerCase();
  if (scorerReasoningEffort !== admitted.reasoningEffort) {
    throw new Error(
      `managed hosted provider profile requires REVIEW_SCORER_REASONING_EFFORT=${admitted.reasoningEffort}`,
    );
  }

  return {
    apiBase,
    apiFormat: admitted.apiFormat,
    model: admitted.model,
    providerName: admitted.providerName,
    providerRoute: admitted.providerRoute,
    reasoningEffort,
    maxOutputTokens: admitted.maxOutputTokens,
    temperature: admitted.temperature,
    maxPromptPrice: admitted.maxPromptPrice,
    maxCompletionPrice: admitted.maxCompletionPrice,
  };
}

/**
 * Keep only supported content fields and apply the complete managed provider
 * policy. Caller-supplied model, reasoning, provider, and routing fields are
 * never forwarded.
 */
export function buildManagedHostedChatCompletionRequest(
  input: Record<string, unknown>,
  profile: ManagedHostedProviderProfile,
): Record<string, unknown> {
  const requestedMaxOutputTokens = input.max_tokens;
  const maxTokens =
    typeof requestedMaxOutputTokens === "number" &&
    Number.isSafeInteger(requestedMaxOutputTokens) &&
    requestedMaxOutputTokens > 0
      ? Math.min(requestedMaxOutputTokens, profile.maxOutputTokens)
      : profile.maxOutputTokens;
  return {
    ...(Object.hasOwn(input, "messages") ? { messages: input.messages } : {}),
    max_tokens: maxTokens,
    temperature: profile.temperature,
    model: profile.model,
    reasoning: { effort: profile.reasoningEffort },
    provider: {
      data_collection: "deny",
      zdr: true,
      order: [profile.providerRoute],
      allow_fallbacks: false,
      max_price: {
        prompt: profile.maxPromptPrice,
        completion: profile.maxCompletionPrice,
      },
    },
  };
}
