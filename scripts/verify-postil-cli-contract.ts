#!/usr/bin/env bun

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import release from "../src/data/public-cli-release.json";
import { ingestEnvelope } from "../src/lib/envelope";

const REQUIRED_REVIEW_FLAGS = [
  "--publish",
  "--bounded",
  "--sha <SHA>",
  "--base-sha <BASE_SHA>",
] as const;
const PUBLICATION_CONTROLLER_PLAN_PROBE = [
  "review",
  "--publication-plan-output",
  "/dev/null",
  "--help",
] as const;
const HEAD_SHA = "1".repeat(40);
const BASE_SHA = "2".repeat(40);
const ADVANCED_BASE_SHA = "3".repeat(40);

interface CommandResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

function parseBinaryArgument(argv: string[]): string {
  const index = argv.indexOf("--binary");
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value || argv.length !== 2) {
    throw new Error("usage: verify-postil-cli-contract.ts --binary <path>");
  }
  return resolve(value);
}

async function run(
  binary: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): Promise<CommandResult> {
  const env = { ...process.env };
  for (const name of [
    "GITHUB_API_URL",
    "GITHUB_TOKEN",
    "MODEL_API_KEY",
    "OPENROUTER_API_KEY",
    "POSTIL_EXPECTED_GITHUB_REPO_ID",
    "POSTIL_HOSTED_MODE",
    "POSTIL_HOSTED_INFERENCE_ENABLED",
    "POSTIL_PROVISIONAL_HOSTED_ROSTER",
    "REVIEW_MODEL",
    "REVIEW_MODEL_CASCADE",
  ]) {
    delete env[name];
  }
  Object.assign(env, options.env);
  const child = Bun.spawn([binary, ...args], {
    cwd: options.cwd,
    env,
    stderr: "pipe",
    stdout: "pipe",
    signal: AbortSignal.timeout(20_000),
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  return { exitCode, stderr, stdout };
}

export function assertReviewHelp(help: string): void {
  for (const flag of REQUIRED_REVIEW_FLAGS) {
    if (!help.includes(flag)) {
      throw new Error(`postil review is missing required option ${flag}`);
    }
  }
}

export function assertPublicationControllerPlanProbe(
  result: CommandResult,
): void {
  if (result.exitCode !== 0) {
    throw new Error("postil review does not support publication-plan output");
  }
}

/** Verify the no-mutation plan option on the exact CLI in a managed image. */
export async function verifyPublicationControllerCliCapability(
  binary: string,
): Promise<void> {
  assertPublicationControllerPlanProbe(
    await run(binary, [...PUBLICATION_CONTROLLER_PLAN_PROBE]),
  );
}

export function assertEnvelopeContract(
  raw: string,
  expectedBaseSha?: string,
  expectedHeadSha?: string,
): void {
  let envelope;
  try {
    envelope = ingestEnvelope(raw).envelope;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "validation failed";
    throw new Error(`postil review emitted an incompatible envelope: ${detail}`);
  }
  const mismatches: string[] = [];
  if (envelope.version !== 1) mismatches.push("version");
  if (
    typeof envelope.baseSha !== "string" ||
    (expectedBaseSha !== undefined && envelope.baseSha !== expectedBaseSha)
  ) {
    mismatches.push("baseSha");
  }
  if (
    typeof envelope.headSha !== "string" ||
    (expectedHeadSha !== undefined && envelope.headSha !== expectedHeadSha)
  ) {
    mismatches.push("headSha");
  }
  if (envelope.silent !== true) mismatches.push("silent");
  if (!Array.isArray(envelope.findings) || envelope.findings.length !== 0) {
    mismatches.push("findings");
  }
  if (mismatches.length > 0) {
    throw new Error(
      `postil review emitted an incompatible envelope: ${mismatches.join(", ")} ` +
        `(baseSha=${JSON.stringify(envelope.baseSha)}, headSha=${JSON.stringify(envelope.headSha)})`,
    );
  }
}

function modelResponse(): Response {
  return Response.json({
    id: "postil-contract-smoke",
    object: "chat.completion",
    created: 0,
    model: "contract-smoke",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: {
          role: "assistant",
          content: JSON.stringify({ summary: "", findings: [] }),
        },
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 3,
      total_tokens: 13,
    },
  });
}

export async function verifyPostilCliContract(binary: string): Promise<void> {
  const version = await run(binary, ["--version"]);
  if (
    version.exitCode !== 0 ||
    version.stdout.trim() !== `postil ${release.hostedCliRelease.slice(1)}`
  ) {
    throw new Error(
      `postil binary version mismatch: expected ${release.hostedCliRelease}, received ${version.stdout.trim() || `exit ${version.exitCode}`}`,
    );
  }

  const help = await run(binary, ["review", "--help"]);
  if (help.exitCode !== 0) {
    throw new Error(`postil review --help failed: ${help.stderr.trim()}`);
  }
  assertReviewHelp(help.stdout);
  await verifyPublicationControllerCliCapability(binary);

  let rejectCheckCompletion = false;
  let rejectFileFetch = false;
  let registeredPlan = false;
  let liveBaseSha = BASE_SHA;
  let checkCompletionAttempts = 0;
  const planToken = "contract-plan-token";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/plan") {
        if (request.headers.get("authorization") !== `Bearer ${planToken}`) {
          return new Response("unauthorized", { status: 401 });
        }
        const plan = (await request.json()) as Record<string, unknown>;
        const keys = [
          "version",
          "planSha256",
          "directHunks",
          "semanticHunks",
          "unreviewedHunks",
          "selectedBatches",
          "totalBatches",
          "concurrency",
          "requestTimeoutSeconds",
          "reviewBudgetSeconds",
        ];
        const counters = keys.slice(2);
        if (
          Object.keys(plan).sort().join("\0") !== keys.sort().join("\0") ||
          plan.version !== 1 ||
          typeof plan.planSha256 !== "string" ||
          !/^[0-9a-f]{64}$/.test(plan.planSha256) ||
          counters.some(
            (key) =>
              !Number.isSafeInteger(plan[key]) || (plan[key] as number) < 0,
          ) ||
          (plan.selectedBatches as number) > (plan.totalBatches as number) ||
          (plan.concurrency as number) < 1 ||
          (plan.requestTimeoutSeconds as number) < 1 ||
          (plan.reviewBudgetSeconds as number) < 1
        ) {
          return new Response("invalid registration", { status: 400 });
        }
        registeredPlan = true;
        return new Response(null, { status: 204 });
      }
      if (path === "/v1/chat/completions") {
        return registeredPlan
          ? modelResponse()
          : new Response("plan required", { status: 428 });
      }
      if (path.endsWith("/pulls/1")) {
        return Response.json({
          title: "Contract smoke",
          body: "",
          state: "open",
          merged: false,
          head: { sha: HEAD_SHA },
          base: { sha: liveBaseSha },
          changed_files: 0,
        });
      }
      if (path.endsWith(`/compare/${BASE_SHA}...${HEAD_SHA}`)) {
        return Response.json({
          merge_base_commit: { sha: BASE_SHA },
          files: [],
        });
      }
      if (path.includes("/pulls/1/files")) {
        if (rejectFileFetch) {
          return Response.json(
            { message: "contract smoke rejection" },
            { status: 503 },
          );
        }
        return Response.json([]);
      }
      if (request.method === "PATCH" && path.includes("/check-runs/")) {
        checkCompletionAttempts += 1;
        if (rejectCheckCompletion) {
          return Response.json(
            { message: "contract smoke rejection" },
            { status: 503 },
          );
        }
        return Response.json({});
      }
      return Response.json({ message: "not found" }, { status: 404 });
    },
  });
  const workDir = await mkdtemp(join(tmpdir(), "postil-cli-contract-"));
  try {
    const modelEnv = {
      POSTIL_API_BASE: `http://127.0.0.1:${server.port}/v1`,
      POSTIL_API_FORMAT: "openai-compatible",
      POSTIL_API_KEY: "contract-smoke",
      POSTIL_ALLOW_PRIVATE_API_BASE: "1",
      POSTIL_LARGE_REVIEW_PLAN_ENDPOINT: `http://127.0.0.1:${server.port}/plan`,
      POSTIL_LARGE_REVIEW_PLAN_TOKEN: planToken,
      POSTIL_DISABLE_SCORER: "1",
      REVIEW_MODEL: "openai/contract-smoke",
      REVIEW_MODEL_CASCADE: "openai/contract-smoke",
      GITHUB_API_URL: `http://127.0.0.1:${server.port}/github`,
      GITHUB_TOKEN: "contract-smoke",
    };
    const hostedArgs = [
      "review",
      "--forge",
      "github",
      "--repo",
      "postil-dev/contract-smoke",
      "--pr",
      "1",
      "--publish",
      "--bounded",
      "--sha",
      HEAD_SHA,
      "--base-sha",
      BASE_SHA,
      "--check-run-id",
      "11",
      "--gate-check-run-id",
      "12",
      "--output",
      "json",
    ];
    const envelope = await run(binary, hostedArgs, {
      cwd: workDir,
      env: modelEnv,
    });
    if (envelope.exitCode !== 0) {
      throw new Error(
        `postil envelope smoke failed: ${envelope.stderr.trim()}`,
      );
    }
    assertEnvelopeContract(envelope.stdout, BASE_SHA, HEAD_SHA);
    if (!registeredPlan) {
      throw new Error("postil review did not register its provider-request plan");
    }

    const completedBeforeBaseAdvance = checkCompletionAttempts;
    liveBaseSha = ADVANCED_BASE_SHA;
    registeredPlan = false;
    const advancedBase = await run(binary, hostedArgs, {
      cwd: workDir,
      env: modelEnv,
    });
    if (advancedBase.exitCode === 0) {
      throw new Error("hosted publication accepted a changed target-branch SHA");
    }
    if (checkCompletionAttempts !== completedBeforeBaseAdvance) {
      throw new Error("hosted publication mutated checks after the target branch advanced");
    }
    liveBaseSha = BASE_SHA;

    rejectFileFetch = true;
    rejectCheckCompletion = true;
    registeredPlan = false;
    const operationalFailure = await run(binary, hostedArgs, {
      cwd: workDir,
      env: {
        ...modelEnv,
        POSTIL_HOSTED_MODE: "1",
        POSTIL_PROVISIONAL_HOSTED_ROSTER: "1",
      },
    });
    if (operationalFailure.exitCode !== 2) {
      throw new Error(
        `hosted publication failure must exit 2, received ${operationalFailure.exitCode}`,
      );
    }
  } finally {
    server.stop(true);
    await rm(workDir, { force: true, recursive: true });
  }
}

async function main(): Promise<void> {
  const binary = parseBinaryArgument(process.argv.slice(2));
  await verifyPostilCliContract(binary);
  console.log(`postil CLI contract verified at ${release.hostedCliRelease}`);
}

if (import.meta.main) await main();
