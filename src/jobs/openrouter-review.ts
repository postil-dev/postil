import { env } from "@/lib/env";
import type { TokenUsage } from "./run-review";

export type OpenRouterResult = {
  content: string;
  usage: TokenUsage;
  modelUsed: string;
};

const OPENROUTER_MODEL_TIMEOUT_MS = 120_000;

export async function callOpenRouterReview(
  model: string,
  systemPrompt: string,
  userContent: string,
  signal?: AbortSignal,
): Promise<OpenRouterResult> {
  if (!env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is not set");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENROUTER_MODEL_TIMEOUT_MS);
  const requestSignal = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;

  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      signal: requestSignal,
      method: "POST",
      headers: {
        authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        "content-type": "application/json",
        "http-referer": "https://postil.dev",
        "x-title": "Postil",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
        temperature: 0.2,
        max_tokens: 2500,
        response_format: { type: "json_object" },
      }),
    });

    clearTimeout(timeout);

    if (!res.ok) {
      throw new Error(`openrouter ${res.status}: ${(await res.text()).slice(0, 400)}`);
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const orUsage = data.usage;
    const usage: TokenUsage = {
      promptTokens: orUsage?.prompt_tokens ?? 0,
      completionTokens: orUsage?.completion_tokens ?? 0,
      totalTokens: orUsage?.total_tokens ?? 0,
    };
    return {
      content: data.choices?.[0]?.message?.content ?? "",
      usage,
      modelUsed: model,
    };
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}
