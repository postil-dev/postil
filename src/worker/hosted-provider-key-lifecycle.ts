import type { Pool } from "pg";

import { getSealingKey, seal } from "@/lib/crypto/seal";
import { getPool } from "@/lib/db";
import { hostedInferenceEnabled, optionalEnv, requireEnv } from "@/lib/env";
import {
  reconcileHostedProviderKeyLifecycle,
  type HostedProviderKeyLifecycleResult,
} from "@/lib/hosted-provider-key-lifecycle";
import {
  createOpenRouterManagementAdapter,
  OpenRouterManagementAdapterError,
  type OpenRouterManagementAdapter,
  type OpenRouterManagementRequest,
} from "@/lib/openrouter-management-adapter";
import {
  PermanentJobError,
  hostedProviderKeyLifecycleJobPayload,
  type HostedProviderKeyLifecycleJobPayload,
} from "@/lib/queue";
import {
  HostedInferenceReleaseDarkError,
  withHostedInferenceReleaseActive,
} from "@/lib/release-job-rollout";

const ACTIVE_RECONCILIATION_INTERVAL_MS = 5 * 60 * 1_000;
const PROVIDER_RETRY_INTERVAL_MS = 30 * 1_000;
const RATE_LIMIT_RETRY_INTERVAL_MS = 60 * 1_000;
const BUSY_RETRY_INTERVAL_MS = 5 * 1_000;
const IMMEDIATE_CONTINUATION_DELAY_MS = 1_000;

let lifecycleProcessTail = Promise.resolve();

export interface HostedProviderKeyLifecycleJobContinuation {
  payload: HostedProviderKeyLifecycleJobPayload;
  runAfter: Date;
}

interface HostedProviderKeyLifecycleJobDependencies {
  pool?: Pool;
  adapter?: OpenRouterManagementAdapter;
  releaseSha?: string;
  hostedInferenceEnabled?: boolean;
  sealRuntimeKey?: (runtimeKey: string) => Buffer | Promise<Buffer>;
  now?: () => Date;
}

/** Reconcile one durable organization job without exposing provider credentials. */
export async function runHostedProviderKeyLifecycleJob(
  untrustedPayload: Record<string, unknown>,
  dependencies: HostedProviderKeyLifecycleJobDependencies = {},
): Promise<HostedProviderKeyLifecycleJobContinuation | void> {
  const payload =
    validateHostedProviderKeyLifecycleJobPayload(untrustedPayload);
  const releaseSha =
    dependencies.releaseSha ?? optionalEnv("POSTIL_RELEASE_SHA");
  if (!releaseSha) {
    throw new PermanentJobError(
      "hosted provider key lifecycle requires a managed release SHA",
    );
  }
  const currentPayload = hostedProviderKeyLifecycleJobPayload(
    payload.orgId,
    releaseSha,
  );
  if (
    (dependencies.hostedInferenceEnabled ?? hostedInferenceEnabled()) !== true
  ) {
    throw new HostedInferenceReleaseDarkError(currentPayload.releaseSha);
  }

  const pool = dependencies.pool ?? getPool();
  return serializeLifecycleProcess(() =>
    withHostedInferenceReleaseActive(
      pool,
      currentPayload.releaseSha,
      async () => {
        const adapter =
          dependencies.adapter ??
          createOpenRouterManagementAdapter({
            managementCredential: requireEnv("OPENROUTER_MANAGEMENT_API_KEY"),
            transport: fetchManagementRequest,
          });
        const sealRuntimeKey =
          dependencies.sealRuntimeKey ??
          ((runtimeKey: string) => seal(runtimeKey, getSealingKey()));
        let result: HostedProviderKeyLifecycleResult;
        try {
          result = await reconcileHostedProviderKeyLifecycle(pool, adapter, {
            orgId: currentPayload.orgId,
            sealRuntimeKey,
          });
        } catch (error) {
          if (error instanceof OpenRouterManagementAdapterError) {
            return continuation(
              currentPayload,
              dependencies,
              PROVIDER_RETRY_INTERVAL_MS,
            );
          }
          throw error;
        }
        return lifecycleContinuation(currentPayload, result, dependencies);
      },
    ),
  );
}

export function validateHostedProviderKeyLifecycleJobPayload(
  payload: Record<string, unknown>,
): HostedProviderKeyLifecycleJobPayload {
  try {
    if (
      Object.keys(payload).some(
        (key) =>
          key !== "orgId" && key !== "releaseSha" && key !== "releaseDarkSha",
      )
    ) {
      throw new Error("unexpected field");
    }
    return hostedProviderKeyLifecycleJobPayload(
      payload.orgId as number,
      payload.releaseSha as string,
    );
  } catch {
    throw new PermanentJobError(
      "hosted provider key lifecycle job payload is malformed",
    );
  }
}

function lifecycleContinuation(
  payload: HostedProviderKeyLifecycleJobPayload,
  result: HostedProviderKeyLifecycleResult,
  dependencies: HostedProviderKeyLifecycleJobDependencies,
): HostedProviderKeyLifecycleJobContinuation | void {
  switch (result.status) {
    case "inactive":
      return result.reason === "no-entitlement"
        ? undefined
        : continuation(
            payload,
            dependencies,
            ACTIVE_RECONCILIATION_INTERVAL_MS,
          );
    case "created":
    case "active": {
      const now = currentTime(dependencies);
      const periodic = new Date(
        now.getTime() + ACTIVE_RECONCILIATION_INTERVAL_MS,
      );
      return {
        payload,
        runAfter:
          result.periodEndsAt.getTime() < periodic.getTime()
            ? result.periodEndsAt
            : periodic,
      };
    }
    case "busy":
      return continuation(payload, dependencies, BUSY_RETRY_INTERVAL_MS);
    case "retryable":
      return continuation(payload, dependencies, RATE_LIMIT_RETRY_INTERVAL_MS);
    case "orphaned":
    case "revocation-pending":
      return continuation(payload, dependencies, PROVIDER_RETRY_INTERVAL_MS);
    case "revoked":
    case "reconciliation-bound":
      return continuation(
        payload,
        dependencies,
        IMMEDIATE_CONTINUATION_DELAY_MS,
      );
    case "ownership-conflict":
      throw new PermanentJobError(
        "hosted provider key lifecycle stopped at an ownership conflict",
      );
    case "rejected":
      throw new PermanentJobError(
        `hosted provider key lifecycle ${result.operation} was rejected by the provider`,
      );
    case "blocked":
      throw new PermanentJobError(
        `hosted provider key lifecycle is blocked in state ${result.state}`,
      );
  }
}

function continuation(
  payload: HostedProviderKeyLifecycleJobPayload,
  dependencies: HostedProviderKeyLifecycleJobDependencies,
  delayMs: number,
): HostedProviderKeyLifecycleJobContinuation {
  return {
    payload,
    runAfter: new Date(currentTime(dependencies).getTime() + delayMs),
  };
}

function currentTime(
  dependencies: HostedProviderKeyLifecycleJobDependencies,
): Date {
  return dependencies.now?.() ?? new Date();
}

async function fetchManagementRequest(
  request: OpenRouterManagementRequest,
): Promise<Response> {
  return fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    redirect: request.redirect,
    signal: request.signal,
  });
}

async function serializeLifecycleProcess<T>(
  operation: () => Promise<T>,
): Promise<T> {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previous = lifecycleProcessTail;
  lifecycleProcessTail = previous.then(() => gate);
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}
