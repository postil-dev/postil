import type { Pool } from "pg";

import { calculateUsageCostMicrosForModel } from "@/lib/billing-credits";
import { bearerCliToken, resolveCliToken, touchCliTokenLastUsed } from "@/lib/cli-auth";
import type { Database } from "@/lib/db";
import { hostedInferenceAvailable } from "@/lib/env";
import {
  countCliGatewayReservationsLastHour,
  reconcileHostedCliGatewaySpend,
  releaseHostedCliGatewaySpend,
  reserveHostedCliGatewaySpend,
} from "@/lib/hosted-usage-reservations";
import {
  buildManagedHostedChatCompletionRequest,
  resolveManagedHostedProviderProfile,
  type ManagedHostedProviderProfile,
} from "@/lib/managed-hosted-provider-profile";
import { canProcessRepositoryInference } from "@/lib/private-repository-entitlement";
import { resolveLlmConfig } from "@/worker/review";
import { readPositiveIntEnv } from "@/worker/runner";

/**
 * `POST /api/inference/v1/chat/completions` - the hosted inference gateway.
 *
 * Every check below fails closed and runs in the fixed order the contract
 * specifies: an invalid token, an exhausted hourly cap, a denied entitlement,
 * an exhausted reservation, or an invalid service policy all reject the request
 * before Postil's own upstream credential is ever used. Request-shape
 * validation (malformed JSON, `stream: true`) is folded in immediately after
 * the hourly cap and before the entitlement lookup: rejecting a request that
 * can never be proxied should not cost an entitlement query or a reservation.
 */

const GATEWAY_UPSTREAM_TIMEOUT_MS = 420_000; // mirrors HOSTED_LLM_REQUEST_TIMEOUT_SECS
export interface CliGatewayResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

function errorResult(
  status: number,
  message: string,
  type: string,
  headers?: Record<string, string>,
): CliGatewayResult {
  return { status, body: { error: { message, type } }, headers };
}

function cliGatewayHourlyCap(): number {
  return readPositiveIntEnv("POSTIL_CLI_GATEWAY_HOURLY_CAP", 60);
}

interface GatewayPolicy {
  model: string;
  reasoningEffort: string;
  managedProfile: ManagedHostedProviderProfile | null;
}

function resolveGatewayPolicy(llm: { model?: string; modelCascade?: string }): GatewayPolicy {
  if (
    process.env.POSTIL_MANAGED_RELEASE?.trim() === "1" ||
    process.env.POSTIL_PROVISIONAL_HOSTED_ROSTER?.trim() === "1"
  ) {
    const managedProfile = resolveManagedHostedProviderProfile();
    return { ...managedProfile, managedProfile };
  }
  const model = [llm.model, ...(llm.modelCascade ?? "").split(",")]
    .map((value) => value?.trim())
    .find((value) => Boolean(value));
  if (!model) throw new Error("the hosted gateway requires a configured model");
  const reasoningEffort = (process.env.REVIEW_REASONING_EFFORT ?? "low").trim().toLowerCase();
  if (!["max", "xhigh", "high", "medium", "low", "minimal", "none"].includes(reasoningEffort)) {
    throw new Error("the hosted gateway reasoning effort is invalid");
  }
  return { model, reasoningEffort, managedProfile: null };
}

function buildGatewayRequest(input: Record<string, unknown>, policy: GatewayPolicy): Record<string, unknown> {
  if (policy.managedProfile) {
    return buildManagedHostedChatCompletionRequest(input, policy.managedProfile);
  }
  const requestedMaxTokens = input.max_tokens;
  return {
    ...(Object.hasOwn(input, "messages") ? { messages: input.messages } : {}),
    model: policy.model,
    reasoning: { effort: policy.reasoningEffort },
    max_tokens: typeof requestedMaxTokens === "number" &&
      Number.isSafeInteger(requestedMaxTokens) && requestedMaxTokens > 0
      ? Math.min(requestedMaxTokens, 8_000)
      : 8_000,
    temperature: 0.1,
  };
}

/** The service-selected default model advertised by `postil login`. */
export async function resolveHostedGatewayDefaultModel(pool: Pool): Promise<string | null> {
  if (!(await hostedInferenceAvailable(pool))) return null;
  try {
    return resolveGatewayPolicy(await resolveLlmConfig(null)).model;
  } catch {
    return null;
  }
}

interface UpstreamUsage {
  promptTokens: number;
  completionTokens: number;
  /** Whether the upstream response reported both token counts. */
  complete: boolean;
}

function extractUpstreamUsage(upstreamJson: unknown): UpstreamUsage {
  const usage =
    typeof upstreamJson === "object" && upstreamJson !== null
      ? (upstreamJson as Record<string, unknown>).usage
      : undefined;
  const promptTokensRaw =
    typeof usage === "object" && usage !== null
      ? (usage as Record<string, unknown>).prompt_tokens
      : undefined;
  const completionTokensRaw =
    typeof usage === "object" && usage !== null
      ? (usage as Record<string, unknown>).completion_tokens
      : undefined;
  const complete = typeof promptTokensRaw === "number" && typeof completionTokensRaw === "number";
  return {
    promptTokens: typeof promptTokensRaw === "number" ? promptTokensRaw : 0,
    completionTokens: typeof completionTokensRaw === "number" ? completionTokensRaw : 0,
    complete,
  };
}

interface UpstreamIdentity {
  model: string | null;
  provider: string | null;
}

function extractUpstreamIdentity(upstreamJson: unknown): UpstreamIdentity | null {
  if (typeof upstreamJson !== "object" || upstreamJson === null) return null;
  const response = upstreamJson as Record<string, unknown>;
  const identifier = (key: "model" | "provider"): string | null => {
    const value = response[key];
    if (typeof value !== "string") return null;
    const normalized = value.trim();
    if (
      normalized.length === 0 ||
      normalized.length > 500 ||
      Array.from(normalized).some((character) => /\p{Cc}/u.test(character))
    ) {
      return null;
    }
    return normalized;
  };
  const model = identifier("model");
  const provider = identifier("provider");
  return { model, provider };
}

export async function runCliGatewayChatCompletion(
  db: Database,
  pool: Pool,
  authorizationHeader: string | null,
  rawBody: string,
): Promise<CliGatewayResult> {
  // 1. Resolve the token by digest. Invalid, revoked, or expired -> 401.
  const token = bearerCliToken(authorizationHeader);
  const resolved = token ? await resolveCliToken(db, token) : null;
  if (!resolved) {
    return errorResult(401, "postil login required", "invalid_token");
  }

  // 2. Best effort; must never fail the request.
  await touchCliTokenLastUsed(db, resolved.id);

  // 3. Per-org hourly request cap.
  const cap = cliGatewayHourlyCap();
  const requestsLastHour = await countCliGatewayReservationsLastHour(db, resolved.orgId);
  if (requestsLastHour >= cap) {
    return errorResult(
      429,
      "CLI gateway hourly request cap reached for this organization",
      "rate_limited",
      { "retry-after": "60" },
    );
  }

  // Request-shape validation, including the out-of-scope streaming case.
  let parsed: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(rawBody);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("not an object");
    }
    parsed = value as Record<string, unknown>;
  } catch {
    return errorResult(400, "request body must be a JSON object", "invalid_request");
  }
  if (parsed.stream === true) {
    return errorResult(
      400,
      "streaming is not supported by the CLI gateway",
      "unsupported",
    );
  }

  // 4. Entitlement.
  const access = await canProcessRepositoryInference(db, {
    orgId: resolved.orgId,
    repositoryPrivate: true,
  });
  if (!access.allowed) {
    return errorResult(402, access.reason, "entitlement");
  }

  // 5. Honor the managed release pause and exact-image activation gate.
  if (!(await hostedInferenceAvailable(pool))) {
    return errorResult(503, "hosted inference is unavailable", "unavailable");
  }

  let policy: GatewayPolicy;
  let llm: Awaited<ReturnType<typeof resolveLlmConfig>>;
  try {
    llm = await resolveLlmConfig(null);
    policy = resolveGatewayPolicy(llm);
  } catch {
    return errorResult(
      503,
      "the hosted gateway provider policy is invalid",
      "unavailable",
    );
  }

  // 6. Reserve spend under the same fail-closed reservation layer the worker uses.
  const reservation = await reserveHostedCliGatewaySpend(db, { orgId: resolved.orgId });
  if (!reservation.allowed || !reservation.reservationId) {
    return errorResult(402, reservation.reason, "entitlement");
  }
  const reservationId = reservation.reservationId;

  // 7. Validate the service-owned upstream configuration.
  if (llm.apiFormat !== "openai-compatible") {
    await releaseHostedCliGatewaySpend(db, reservationId);
    return errorResult(
      503,
      "the hosted gateway is not configured for an OpenAI-compatible upstream",
      "unavailable",
    );
  }
  if (!llm.apiKey) {
    await releaseHostedCliGatewaySpend(db, reservationId);
    return errorResult(
      503,
      "the hosted gateway has no upstream credential configured",
      "unavailable",
    );
  }
  if (
    policy.managedProfile && (
      llm.apiBase.replace(/\/+$/, "") !== policy.managedProfile.apiBase ||
      llm.apiFormat !== policy.managedProfile.apiFormat
    )
  ) {
    await releaseHostedCliGatewaySpend(db, reservationId);
    return errorResult(
      503,
      "the hosted gateway provider configuration does not match its managed profile",
      "unavailable",
    );
  }
  // 8. Proxy upstream with Postil's credential. The inbound Authorization
  // header (the caller's CLI token) is never forwarded; only the resolved
  // upstream credential is sent, and it is never echoed back to the caller.
  const upstreamRequestBody = buildGatewayRequest(parsed, policy);
  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(`${llm.apiBase.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${llm.apiKey}`,
        ...(!policy.managedProfile && llm.apiAuthHeader && llm.apiAuthValue
          ? { [llm.apiAuthHeader]: llm.apiAuthValue }
          : {}),
      },
      body: JSON.stringify(upstreamRequestBody),
      signal: AbortSignal.timeout(GATEWAY_UPSTREAM_TIMEOUT_MS),
    });
  } catch (error) {
    await releaseHostedCliGatewaySpend(db, reservationId);
    console.warn("cli gateway upstream request failed", error);
    return errorResult(502, "the upstream model provider request failed", "upstream_error");
  }

  const upstreamText = await upstreamResponse.text();
  let upstreamJson: unknown = null;
  try {
    upstreamJson = upstreamText ? JSON.parse(upstreamText) : null;
  } catch {
    upstreamJson = null;
  }

  if (!upstreamResponse.ok || upstreamJson === null) {
    await releaseHostedCliGatewaySpend(db, reservationId);
    const status = upstreamResponse.status >= 400 && upstreamResponse.status < 600
      ? upstreamResponse.status
      : 502;
    return {
      status,
      body: upstreamJson ?? errorResult(502, "the upstream model provider request failed", "upstream_error").body,
    };
  }

  // 8. Record usage and reconcile the reservation from the response's usage block.
  const usage = extractUpstreamUsage(upstreamJson);
  const returnedIdentity = extractUpstreamIdentity(upstreamJson);
  const accountingModel = returnedIdentity?.model ?? policy.model;
  const costMicros = usage.complete
    ? calculateUsageCostMicrosForModel(
        accountingModel,
        usage.promptTokens,
        usage.completionTokens,
      )
    : null;
  try {
    await reconcileHostedCliGatewaySpend(db, {
      reservationId,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      modelUsed: accountingModel,
      actualMicros: costMicros,
      usageAccountingComplete: usage.complete && costMicros !== null,
    });
  } catch (error) {
    // The caller already has its completion; a reconciliation failure here is
    // an operator-visible accounting problem, not a reason to fail the
    // response the operator already paid an upstream provider to generate.
    console.error("cli gateway usage reconciliation failed", error);
  }

  if (
    policy.managedProfile && (
      returnedIdentity?.model !== policy.managedProfile.model ||
      returnedIdentity?.provider !== policy.managedProfile.providerName
    )
  ) {
    return errorResult(
      502,
      "the upstream response identity did not match the hosted provider policy",
      "upstream_identity_mismatch",
    );
  }

  return { status: 200, body: upstreamJson };
}
