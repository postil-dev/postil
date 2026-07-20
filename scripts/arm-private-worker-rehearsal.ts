import { closeDb, getPool } from "@/lib/db";
import { optionalEnv } from "@/lib/env";
import {
  armPrivateWorkerRehearsal,
  assertPrivateWorkerRehearsalOperator,
  configuredPrivateWorkerRehearsalSandbox,
} from "@/lib/private-worker-rehearsal";

interface Options {
  nonce: string;
  operatorGithubId: number;
  confirmReview: string;
  prNumber: number;
  headSha: string;
  expiresInSeconds: number;
  yes: boolean;
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(args);
  const sandbox = configuredPrivateWorkerRehearsalSandbox();
  if (!sandbox) throw new Error("private worker rehearsal is disabled");
  assertPrivateWorkerRehearsalOperator(
    options.operatorGithubId,
    optionalEnv("POSTIL_OPERATOR_GITHUB_IDS"),
  );
  if (!options.yes) {
    throw new Error(
      `refusing to arm review ${options.confirmReview}: pass --yes with the exact review id`,
    );
  }
  const target = {
    ...sandbox,
    prNumber: options.prNumber,
    headSha: options.headSha,
    reviewPublicId: options.confirmReview,
  };
  const now = new Date();
  try {
    const result = await armPrivateWorkerRehearsal(getPool(), {
      ...target,
      nonce: options.nonce,
      operatorGithubId: options.operatorGithubId,
      expiresAt: new Date(now.getTime() + options.expiresInSeconds * 1_000),
      now,
    }, sandbox);
    console.log(
      `armed private worker rehearsal nonce=${result.nonce} review=${target.reviewPublicId} expires_in_seconds=${options.expiresInSeconds}`,
    );
  } finally {
    await closeDb();
  }
}

export function parseArgs(args: string[]): Options {
  const values = new Map<string, string>();
  let yes = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--yes") {
      yes = true;
      continue;
    }
    if (!arg?.startsWith("--")) throw new Error(`unexpected argument: ${arg}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${arg}`);
    values.set(arg.slice(2), value);
    index += 1;
  }
  const operatorGithubId = positiveInteger(
    required(values, "operator-github-id"),
    "--operator-github-id",
  );
  const expiresInSeconds = positiveInteger(
    values.get("expires-in-seconds") ?? "300",
    "--expires-in-seconds",
  );
  if (expiresInSeconds < 60 || expiresInSeconds > 600) {
    throw new Error("--expires-in-seconds must be between 60 and 600");
  }
  return {
    nonce: required(values, "nonce"),
    operatorGithubId,
    confirmReview: required(values, "confirm-review"),
    prNumber: positiveInteger(required(values, "pr"), "--pr"),
    headSha: required(values, "head").toLowerCase(),
    expiresInSeconds,
    yes,
  };
}

function required(values: Map<string, string>, name: string): string {
  const value = values.get(name)?.trim();
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function positiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
