import { optionalEnv, requireEnv } from "@/lib/env";

export async function verifyHostedProvider(input: {
  apiBase: string;
  model: string;
  apiKey: string;
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
        max_tokens: 8,
        temperature: 0,
        messages: [{ role: "user", content: "Reply with exactly: ready" }],
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) {
    throw new Error(`hosted provider preflight failed with status ${response.status}`);
  }
  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  if (typeof payload.choices?.[0]?.message?.content !== "string") {
    throw new Error("hosted provider preflight returned no text choice");
  }
}

if (import.meta.main) {
  const model = optionalEnv("REVIEW_MODEL", "z-ai/glm-5.2") as string;
  await verifyHostedProvider({
    apiBase: optionalEnv("POSTIL_API_BASE", "https://openrouter.ai/api/v1") as string,
    model,
    apiKey: requireEnv("MODEL_API_KEY"),
  });
  console.log(`hosted provider preflight passed for ${model}`);
}
