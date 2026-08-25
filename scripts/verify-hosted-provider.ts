import { optionalEnv, requireEnv } from "@/lib/env";

const PROVIDER_PREFLIGHT_ATTEMPTS = 3;
const PROVIDER_PREFLIGHT_RETRY_WINDOW_MS = 10_000;

function providerStatusError(status: number): Error {
  return new Error(`hosted provider preflight failed with status ${status}`);
}

function retryAfterMilliseconds(value: string | null, nowMs: number): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1_000;
  if (!/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/i.test(trimmed)) {
    return undefined;
  }
  const retryAtMs = Date.parse(trimmed);
  if (!Number.isFinite(retryAtMs)) return undefined;
  return Math.max(0, retryAtMs - nowMs);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function defaultRetryDelayMilliseconds(attempt: number): number {
  return attempt === 0 ? 500 : 1_000;
}

/** Resolve the same hosted provider credential aliases as the review worker. */
export function hostedProviderApiKeyFromEnv(): string {
  return optionalEnv("MODEL_API_KEY") ??
    optionalEnv("POSTIL_API_KEY") ??
    optionalEnv("OPENROUTER_API_KEY") ??
    requireEnv("MODEL_API_KEY");
}

export async function verifyHostedProvider(input: {
  apiBase: string;
  model: string;
  apiKey: string;
  providerName: string;
  maxPromptPrice: number;
  maxCompletionPrice: number;
  fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  sleepImpl?: (milliseconds: number) => Promise<void>;
  nowMs?: () => number;
}): Promise<void> {
  const fetchProvider = input.fetchImpl ?? fetch;
  const sleepBeforeRetry = input.sleepImpl ?? sleep;
  const nowMs = input.nowMs ?? Date.now;
  const retryWindowStartedAtMs = nowMs();
  let response: Response | undefined;

  for (let attempt = 0; attempt < PROVIDER_PREFLIGHT_ATTEMPTS; attempt += 1) {
    response = await fetchProvider(
      `${input.apiBase.replace(/\/$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${input.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: input.model,
          // Reasoning-capable endpoints may spend a small completion budget
          // before emitting visible text. Keep the probe bounded but large
          // enough to prove a usable text response.
          max_tokens: 128,
          temperature: 0,
          provider: {
            data_collection: "deny",
            zdr: true,
            order: [input.providerName],
            allow_fallbacks: false,
            max_price: {
              prompt: input.maxPromptPrice,
              completion: input.maxCompletionPrice,
            },
          },
          messages: [{ role: "user", content: "Reply with exactly: ready" }],
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );

    if (response.ok) break;
    if (response.status !== 429 || attempt === PROVIDER_PREFLIGHT_ATTEMPTS - 1) {
      throw providerStatusError(response.status);
    }

    const currentTimeMs = nowMs();
    const retryDelayMs = retryAfterMilliseconds(
      response.headers.get("retry-after"),
      currentTimeMs,
    ) ?? defaultRetryDelayMilliseconds(attempt);
    const elapsedMs = Math.max(0, currentTimeMs - retryWindowStartedAtMs);
    if (retryDelayMs > PROVIDER_PREFLIGHT_RETRY_WINDOW_MS - elapsedMs) {
      throw providerStatusError(response.status);
    }
    await sleepBeforeRetry(retryDelayMs);
  }

  if (response === undefined) {
    throw new Error("hosted provider preflight did not make a provider request");
  }
  if (!response.ok) {
    throw providerStatusError(response.status);
  }
  const payload = (await response.json()) as {
    model?: unknown;
    provider?: unknown;
    choices?: Array<{
      finish_reason?: unknown;
      message?: { content?: unknown; refusal?: unknown };
    }>;
    usage?: {
      prompt_tokens?: unknown;
      completion_tokens?: unknown;
      total_tokens?: unknown;
      cost?: unknown;
      cost_details?: { upstream_inference_cost?: unknown };
    };
  };
  const choice = payload.choices?.[0];
  if (typeof choice?.message?.content !== "string") {
    throw new Error("hosted provider preflight returned no text choice");
  }
  if (
    choice.message.content.trim() !== "ready" ||
    choice.finish_reason !== "stop" ||
    (typeof choice.message.refusal === "string" && choice.message.refusal.trim() !== "")
  ) {
    throw new Error("hosted provider preflight returned an unusable text choice");
  }
  if (payload.model !== input.model) {
    throw new Error("hosted provider preflight returned an unexpected model");
  }
  if (payload.provider !== input.providerName) {
    throw new Error("hosted provider preflight returned an unexpected provider");
  }
  const promptTokens = payload.usage?.prompt_tokens;
  const completionTokens = payload.usage?.completion_tokens;
  const totalTokens = payload.usage?.total_tokens;
  if (
    !Number.isSafeInteger(promptTokens) ||
    !Number.isSafeInteger(completionTokens) ||
    !Number.isSafeInteger(totalTokens) ||
    Number(promptTokens) < 1 ||
    Number(completionTokens) < 1 ||
    Number(totalTokens) !== Number(promptTokens) + Number(completionTokens)
  ) {
    throw new Error("hosted provider preflight returned invalid token usage");
  }
  const cost = payload.usage?.cost;
  const upstreamCost = payload.usage?.cost_details?.upstream_inference_cost;
  if (
    typeof cost !== "number" ||
    !Number.isFinite(cost) ||
    cost <= 0 ||
    typeof upstreamCost !== "number" ||
    !Number.isFinite(upstreamCost) ||
    upstreamCost <= 0
  ) {
    throw new Error("hosted provider preflight returned invalid cost accounting");
  }
  const maximumUpstreamCost =
    Number(promptTokens) * input.maxPromptPrice / 1_000_000 +
    Number(completionTokens) * input.maxCompletionPrice / 1_000_000;
  if (upstreamCost > maximumUpstreamCost + Number.EPSILON) {
    throw new Error("hosted provider preflight exceeded its price ceiling");
  }
}

if (import.meta.main) {
  const model = optionalEnv("REVIEW_MODEL", "z-ai/glm-5.2") as string;
  await verifyHostedProvider({
    apiBase: optionalEnv("POSTIL_API_BASE", "https://openrouter.ai/api/v1") as string,
    model,
    apiKey: hostedProviderApiKeyFromEnv(),
    providerName: "Fireworks",
    maxPromptPrice: 1.4,
    maxCompletionPrice: 4.4,
  });
  console.log(`hosted provider preflight passed for ${model} on Fireworks`);
}
