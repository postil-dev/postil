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
const proxy = startLargeReviewProviderProxy({
  upstreamApiBase: required("POSTIL_TEST_UPSTREAM_API_BASE"),
  apiFormat: "openai-compatible",
  identity: {
    repositoryId: Number(required("POSTIL_TEST_REPOSITORY_ID")),
    cliVersion: "0.8.0",
    configurationSha256: "a".repeat(64),
    providerIdentity: '["managed","openai-compatible","http://fixture/v1"]',
    headSha: "b".repeat(40),
  },
  runContext: {
    currentReviewId: Number(required("POSTIL_TEST_REVIEW_ID")),
    hostedReservationId: null,
  },
  store: new PostgresLargeReviewAttemptStore(drizzle(pool, { schema })),
});
proxy.observeCliStderr(
  `postil: deterministic large-review plan=${"c".repeat(64)} direct_hunks=1`,
);
proxy.observeCliStderr(
  "postil: llm attempt phase=review model=test attempt=1/2 timeout=90s budget_remaining=420s",
);
process.stdout.write(`${JSON.stringify({ apiBase: proxy.apiBase })}\n`);

await new Promise<never>(() => {});
