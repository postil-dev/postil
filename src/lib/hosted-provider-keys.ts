import { and, eq, sql } from "drizzle-orm";

import { getSealingKey, seal } from "@/lib/crypto/seal";
import type { Database } from "@/lib/db";
import { schema } from "@/lib/db";
import { optionalEnv } from "@/lib/env";

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type HostedProviderKeyProvisionResult =
  | { status: "existing" }
  | {
      status: "skipped";
      reason:
        | "missing-entitlement"
        | "zero-entitlement"
        | "missing-management-key";
    }
  | { status: "provisioned"; keyName: string; openRouterKeyHash: string };

const OPENROUTER_ORIGIN = "https://openrouter.ai";
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const KEY_PAGE_SIZE = 100;
const MAX_KEY_PAGES = 100;

export function hostedProviderKeyName(orgId: number): string {
  validateOrgId(orgId);
  return `postil-org-${orgId}`;
}

export function openRouterManagementKey(): string | undefined {
  return optionalEnv("OPENROUTER_MANAGEMENT_API_KEY");
}

/** Queue one provisioning attempt while the caller's transaction is open. */
export async function enqueueHostedProviderKeyProvision(
  db: Pick<Database, "execute" | "insert" | "select">,
  orgId: number,
): Promise<boolean> {
  validateOrgId(orgId);
  await db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`postil:hosted-key-provision:${orgId}`}, 0))`,
  );
  const active = await db
    .select({ id: schema.jobs.id })
    .from(schema.jobs)
    .where(
      and(
        eq(schema.jobs.kind, "hosted-key-provision"),
        sql`${schema.jobs.status} IN ('queued', 'running')`,
        sql`${schema.jobs.payload}->>'orgId' = ${String(orgId)}`,
      ),
    )
    .limit(1);
  if (active.length > 0) return false;

  await db.insert(schema.jobs).values({
    kind: "hosted-key-provision",
    payload: { orgId },
    maxAttempts: 5,
  });
  return true;
}

export async function provisionHostedProviderKey(
  db: Database,
  orgId: number,
  fetchImpl: Fetch = fetch,
): Promise<HostedProviderKeyProvisionResult> {
  validateOrgId(orgId);
  const existing = await db
    .select({ orgId: schema.hostedProviderKeys.orgId })
    .from(schema.hostedProviderKeys)
    .where(eq(schema.hostedProviderKeys.orgId, orgId))
    .limit(1);
  if (existing.length > 0) return { status: "existing" };

  const entitlements = await db
    .select({
      includedUsageMicros: schema.organizationEntitlements.includedUsageMicros,
      overageHardCapMicros:
        schema.organizationEntitlements.overageHardCapMicros,
    })
    .from(schema.organizationEntitlements)
    .where(eq(schema.organizationEntitlements.orgId, orgId))
    .limit(1);
  const entitlement = entitlements[0];
  if (!entitlement) {
    return { status: "skipped", reason: "missing-entitlement" };
  }

  const limit = entitlementLimitDollars(
    entitlement.includedUsageMicros,
    entitlement.overageHardCapMicros,
  );
  if (limit === 0) {
    return { status: "skipped", reason: "zero-entitlement" };
  }

  const managementKey = openRouterManagementKey();
  if (!managementKey) {
    console.log(
      `hosted provider key provisioning skipped for organization ${orgId}: OPENROUTER_MANAGEMENT_API_KEY is unset`,
    );
    return { status: "skipped", reason: "missing-management-key" };
  }

  const keyName = hostedProviderKeyName(orgId);
  const orphanedKeys = await listOpenRouterKeysByName(
    managementKey,
    keyName,
    fetchImpl,
  );
  for (const orphaned of orphanedKeys) {
    await deleteOpenRouterKey(managementKey, orphaned.hash, fetchImpl);
  }

  const created = await createOpenRouterKey(
    managementKey,
    keyName,
    limit,
    fetchImpl,
  );
  const keyCiphertext = seal(created.key, getSealingKey());
  await db.insert(schema.hostedProviderKeys).values({
    orgId,
    keyCiphertext,
    openRouterKeyHash: created.hash,
    keyName,
  });
  return {
    status: "provisioned",
    keyName,
    openRouterKeyHash: created.hash,
  };
}

/**
 * The provider cap in dollars, preserving sub-dollar entitlements exactly so
 * the provider-side limit never exceeds the configured allowance.
 */
function entitlementLimitDollars(
  includedUsageMicros: number,
  overageHardCapMicros: number | null,
): number {
  const totalMicros = includedUsageMicros + (overageHardCapMicros ?? 0);
  if (!Number.isSafeInteger(totalMicros) || totalMicros < 0) {
    throw new Error("organization entitlement usage limit is invalid");
  }
  return totalMicros / 1_000_000;
}

async function listOpenRouterKeysByName(
  managementKey: string,
  keyName: string,
  fetchImpl: Fetch,
): Promise<Array<{ hash: string }>> {
  const matches: Array<{ hash: string }> = [];
  for (let page = 0; page < MAX_KEY_PAGES; page += 1) {
    const url = new URL("/api/v1/keys", OPENROUTER_ORIGIN);
    url.searchParams.set("include_disabled", "true");
    url.searchParams.set("offset", String(page * KEY_PAGE_SIZE));
    const value = await managementRequest(
      url,
      managementKey,
      fetchImpl,
      "GET",
      "list keys",
    );
    if (!isRecord(value) || !Array.isArray(value.data)) {
      throw new Error(
        "OpenRouter key listing did not match the expected response contract",
      );
    }
    for (const raw of value.data) {
      if (!isRecord(raw) || raw.name !== keyName) continue;
      if (typeof raw.hash !== "string" || raw.hash.length === 0) {
        throw new Error(
          "OpenRouter key listing did not include an identifier for the organization key",
        );
      }
      matches.push({ hash: raw.hash });
    }
    if (value.data.length < KEY_PAGE_SIZE) return matches;
  }
  throw new Error("OpenRouter key listing exceeded the bounded page limit");
}

async function deleteOpenRouterKey(
  managementKey: string,
  hash: string,
  fetchImpl: Fetch,
): Promise<void> {
  const value = await managementRequest(
    new URL(`/api/v1/keys/${encodeURIComponent(hash)}`, OPENROUTER_ORIGIN),
    managementKey,
    fetchImpl,
    "DELETE",
    "delete orphaned key",
  );
  if (!isRecord(value) || value.deleted !== true) {
    throw new Error(
      "OpenRouter key deletion did not match the expected response contract",
    );
  }
}

async function createOpenRouterKey(
  managementKey: string,
  name: string,
  limit: number,
  fetchImpl: Fetch,
): Promise<{ key: string; hash: string }> {
  const value = await managementRequest(
    new URL("/api/v1/keys", OPENROUTER_ORIGIN),
    managementKey,
    fetchImpl,
    "POST",
    "create organization key",
    { name, limit },
  );
  if (
    !isRecord(value) ||
    typeof value.key !== "string" ||
    value.key.length === 0 ||
    !isRecord(value.data) ||
    typeof value.data.hash !== "string" ||
    value.data.hash.length === 0 ||
    value.data.name !== name
  ) {
    throw new Error(
      "OpenRouter key creation did not match the expected response contract",
    );
  }
  return { key: value.key, hash: value.data.hash };
}

async function managementRequest(
  url: URL,
  managementKey: string,
  fetchImpl: Fetch,
  method: "GET" | "POST" | "DELETE",
  operation: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: {
        authorization: `Bearer ${managementKey}`,
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new Error(
      `OpenRouter management request to ${operation} failed before an HTTP response was received`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `OpenRouter management request to ${operation} returned HTTP ${response.status}`,
    );
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error(
      `OpenRouter management response to ${operation} exceeded the size limit`,
    );
  }
  const responseBody = await response.text();
  if (Buffer.byteLength(responseBody, "utf8") > MAX_RESPONSE_BYTES) {
    throw new Error(
      `OpenRouter management response to ${operation} exceeded the size limit`,
    );
  }
  try {
    return JSON.parse(responseBody);
  } catch {
    throw new Error(
      `OpenRouter management response to ${operation} was not valid JSON`,
    );
  }
}

function validateOrgId(orgId: number): void {
  if (!Number.isSafeInteger(orgId) || orgId <= 0) {
    throw new Error("organization id must be a positive safe integer");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
