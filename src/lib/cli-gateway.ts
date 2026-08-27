import type { Pool } from "pg";

import { calculateUsageCostMicrosForModel } from "@/lib/billing-credits";
import { bearerCliToken, resolveCliToken, touchCliTokenLastUsed } from "@/lib/cli-auth";
import type { Database } from "@/lib/db";
import release from "@/data/public-cli-release.json";
import { hostedInferenceAvailable, optionalEnv } from "@/lib/env";
import {
  countCliGatewayReservationsLastHour,
  reconcileHostedCliGatewaySpend,
  releaseHostedCliGatewaySpend,
  reserveHostedCliGatewaySpend,
} from "@/lib/hosted-usage-reservations";
import { canProcessRepositoryInference } from "@/lib/private-repository-entitlement";
import { resolveLlmConfig } from "@/worker/review";
import { readPositiveIntEnv } from "@/worker/runner";

/**
 * `POST /api/inference/v1/chat/completions` - the hosted inference gateway.
 *
 * Every check below fails closed and runs in the fixed order the contract
 * specifies: an invalid token, an exhausted hourly cap, a denied entitlement,
 * an exhausted reservation, or an off-roster model all reject the request
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

/**
 * The hosted inference roster follows the deployment's configured default and
 * cascade. Managed provisional mode falls back to the exact default pinned for
 * the hosted CLI release when the deployment deliberately omits those values.
 */
export function hostedModelRoster(
  llm: { model?: string; modelCascade?: string },
  provisionalRoster = optionalEnv("POSTIL_PROVISIONAL_HOSTED_ROSTER", "0") as string,
): string[] {
  const models = [llm.model, ...(llm.modelCascade ?? "").split(",")]
    .map((model) => model?.trim())
    .filter((model): model is string => Boolean(model));
  if (models.length === 0 && provisionalRoster === "1") {
    models.push(release.hostedCliDefaultModel);
  }
  return Array.from(new Set(models));
}

/** The model `postil login` reports as the gateway's default, shared with the roster above. */
export async function resolveHostedGatewayDefaultModel(pool: Pool): Promise<string | null> {
  if (!(await hostedInferenceAvailable(pool))) return null;
  const llm = await resolveLlmConfig(null);
  return hostedModelRoster(llm)[0] ?? null;
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

  // 6. Reserve spend under the same fail-closed reservation layer the worker uses.
  const reservation = await reserveHostedCliGatewaySpend(db, { orgId: resolved.orgId });
  if (!reservation.allowed || !reservation.reservationId) {
    return errorResult(402, reservation.reason, "entitlement");
  }
  const reservationId = reservation.reservationId;

  // 7. Restrict the requested model to the hosted roster.
  const llm = await resolveLlmConfig(null);
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
  const roster = hostedModelRoster(llm);
  if (roster.length === 0) {
    await releaseHostedCliGatewaySpend(db, reservationId);
    return errorResult(
      503,
      "the hosted gateway has no admitted model roster configured",
      "unavailable",
    );
  }
  const requestedModel = typeof parsed.model === "string" && parsed.model.trim().length > 0
    ? parsed.model.trim()
    : undefined;
  const model = requestedModel ?? roster[0]!;
  if (!roster.includes(model)) {
    await releaseHostedCliGatewaySpend(db, reservationId);
    return errorResult(
      400,
      `model "${model}" is not on the hosted gateway's admitted roster`,
      "invalid_model",
    );
  }

  // 8. Proxy upstream with Postil's credential. The inbound Authorization
  // header (the caller's CLI token) is never forwarded; only the resolved
  // upstream credential is sent, and it is never echoed back to the caller.
  const upstreamRequestBody: Record<string, unknown> = { ...parsed, model };
  delete upstreamRequestBody.stream;
  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(`${llm.apiBase.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${llm.apiKey}`,
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
  const costMicros = usage.complete
    ? calculateUsageCostMicrosForModel(model, usage.promptTokens, usage.completionTokens)
    : null;
  try {
    await reconcileHostedCliGatewaySpend(db, {
      reservationId,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      modelUsed: model,
      actualMicros: costMicros,
      usageAccountingComplete: usage.complete && costMicros !== null,
    });
  } catch (error) {
    // The caller already has its completion; a reconciliation failure here is
    // an operator-visible accounting problem, not a reason to fail the
    // response the operator already paid an upstream provider to generate.
    console.error("cli gateway usage reconciliation failed", error);
  }

  return { status: 200, body: upstreamJson };
}
