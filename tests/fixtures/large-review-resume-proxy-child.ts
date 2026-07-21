import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "@/lib/db/schema";
import {
  PostgresLargeReviewAttemptStore,
  startLargeReviewProviderProxy,
} from "@/lib/large-review-resume";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const pool = new Pool({ connectionString: required("DATABASE_URL"), max: 1 });
const proxy = await startLargeReviewProviderProxy({
  upstreamApiBase: required("POSTIL_TEST_UPSTREAM_API_BASE"),
  apiFormat: "openai-compatible",
  allowPrivateUpstream: true,
  identity: {
    repositoryId: Number(required("POSTIL_TEST_REPOSITORY_ID")),
    prNumber: 1,
    cliVersion: "0.8.0",
    configurationSha256: "a".repeat(64),
    providerIdentity: '["managed","openai-compatible","http://fixture/v1"]',
    headSha: "b".repeat(40),
    baseSha: "0".repeat(40),
    retryLineage: "review-job:fixture",
  },
  runContext: {
    currentReviewId: Number(required("POSTIL_TEST_REVIEW_ID")),
    hostedReservationId: null,
  },
  store: new PostgresLargeReviewAttemptStore(drizzle(pool, { schema })),
});
const registration = await fetch(proxy.planEndpoint, {
  method: "POST",
  headers: {
    authorization: `Bearer ${proxy.planToken}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({
    version: 1,
    planSha256: "c".repeat(64),
    directHunks: 1,
    semanticHunks: 0,
    unreviewedHunks: 0,
    selectedBatches: 1,
    totalBatches: 1,
    concurrency: 1,
    requestTimeoutSeconds: 60,
    reviewBudgetSeconds: 420,
  }),
});
if (registration.status !== 204) throw new Error("fixture plan registration failed");
process.stdout.write(`${JSON.stringify({ apiBase: proxy.apiBase })}\n`);

await new Promise<never>(() => {});
