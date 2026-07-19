import { optionalEnv, requireEnv } from "@/lib/env";

export async function verifyHostedProvider(input: {
  apiBase: string;
  model: string;
  apiKey: string;
  providerSlug: string;
  providerName: string;
  fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}): Promise<void> {
  const response = await (input.fetchImpl ?? fetch)(
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
          only: [input.providerSlug],
          allow_fallbacks: false,
        },
        messages: [{ role: "user", content: "Reply with exactly: ready" }],
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) {
    throw new Error(`hosted provider preflight failed with status ${response.status}`);
  }
  const payload = (await response.json()) as {
    model?: unknown;
    provider?: unknown;
    choices?: Array<{ message?: { content?: unknown } }>;
    usage?: {
      prompt_tokens?: unknown;
      completion_tokens?: unknown;
      total_tokens?: unknown;
      cost?: unknown;
      cost_details?: { upstream_inference_cost?: unknown };
    };
  };
  if (typeof payload.choices?.[0]?.message?.content !== "string") {
    throw new Error("hosted provider preflight returned no text choice");
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
}

if (import.meta.main) {
  const model = optionalEnv("REVIEW_MODEL", "z-ai/glm-5.2") as string;
  await verifyHostedProvider({
    apiBase: optionalEnv("POSTIL_API_BASE", "https://openrouter.ai/api/v1") as string,
    model,
    apiKey: requireEnv("MODEL_API_KEY"),
    providerSlug: "fireworks",
    providerName: "Fireworks",
  });
  console.log(`hosted provider preflight passed for ${model} on Fireworks`);
}
