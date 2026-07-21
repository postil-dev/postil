/**
 * Local hosted-review harness for the Postil worker.
 *
 *   bun run scripts/run-review-locally.ts --staged --repo-path /path/to/repo
 *   POSTIL_BIN=/path/to/postil bun run scripts/run-review-locally.ts --base origin/main --repo-path .
 *   bun run scripts/run-review-locally.ts --diff-file /tmp/change.diff --repo-path .
 *
 * The script creates a disposable local Postgres database, applies the real
 * Drizzle migration chain, seeds a minimal installation/repository fixture,
 * enqueues a review job, and drains it through the real worker queue path. A
 * localhost fake GitHub API serves the target diff and records every check-run
 * creation, check-run completion, and PR review post. GITHUB_API_URL is forced
 * to that localhost server for both the worker and the spawned CLI, so this
 * harness never posts a real GitHub comment, check-run, or review.
 *
 * POSTIL_BIN, when set, must be an absolute executable Postil v0.6.0+ path. The
 * harness resolves and validates it before loading a model credential.
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { Client } from "pg";

import { seal } from "@/lib/crypto/seal";
import type { Envelope, Finding } from "@/lib/envelope";

const root = join(import.meta.dir, "..");
const DEFAULT_INSTALLATION_ID = 990_001;
const DEFAULT_REPOSITORY_ID = 990_002;
const DEFAULT_PR_NUMBER = 1;

type DiffTarget =
  | { kind: "staged" }
  | { kind: "base"; base: string; head: string }
  | { kind: "diff-file"; path: string };

type RepositorySource =
  | { kind: "index" }
  | { kind: "tree"; ref: string }
  | { kind: "working-tree" };

interface CliOptions {
  repoPath: string;
  repoFullName: string;
  prNumber: number;
  keepDatabase: boolean;
  requireClean: boolean;
  target: DiffTarget;
}

type CheckConclusion = "success" | "failure" | "neutral";

interface CheckCreated {
  type: "check-created";
  id: number;
  name: string;
  headSha: string;
  body: unknown;
}

interface CheckCompleted {
  type: "check-completed";
  id: number;
  conclusion: CheckConclusion;
  title: string;
  summary: string;
  annotations: number;
  body: unknown;
}

interface LocalCheckRunState {
  id: number;
  name: string;
  external_id: string | null;
  head_sha: string;
  status: "in_progress" | "completed";
  conclusion: CheckConclusion | null;
  output: { title: string; summary: string } | null;
}

interface ReviewPosted {
  type: "review-posted";
  commitId: string;
  body: string;
  comments: number;
  payload: unknown;
}

type LocalGitHubEvent = CheckCreated | CheckCompleted | ReviewPosted;

interface LocalGitHubServer {
  origin: string;
  events: LocalGitHubEvent[];
  stop(): void;
}

interface LocalPullFile {
  filename: string;
  status: "added" | "removed" | "modified" | "renamed";
  previous_filename?: string;
  changes: number;
}

interface DatabaseHandle {
  databaseUrl: string;
  cleanup(): Promise<void>;
}

interface RunResult {
  reviewId: number;
  jobStatus: string;
  reviewStatus: string;
  gateFailing: boolean;
  envelope: Envelope | null;
  events: LocalGitHubEvent[];
}

export function parseArgs(argv: string[]): CliOptions {
  let repoPath = process.cwd();
  let repoFullName: string | undefined;
  let prNumber = DEFAULT_PR_NUMBER;
  let keepDatabase = false;
  let requireClean = false;
  let head: string | undefined;
  let target: DiffTarget | undefined;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--repo-path") {
      repoPath = requireValue(argv, ++index, arg);
    } else if (arg === "--repo") {
      repoFullName = requireValue(argv, ++index, arg);
    } else if (arg === "--pr") {
      prNumber = positiveInteger(requireValue(argv, ++index, arg), arg);
    } else if (arg === "--staged") {
      ensureNoTarget(target);
      target = { kind: "staged" };
    } else if (arg === "--base") {
      ensureNoTarget(target);
      target = { kind: "base", base: requireValue(argv, ++index, arg), head: "HEAD" };
    } else if (arg === "--head") {
      head = requireValue(argv, ++index, arg);
    } else if (arg === "--diff-file") {
      ensureNoTarget(target);
      target = { kind: "diff-file", path: requireValue(argv, ++index, arg) };
    } else if (arg === "--keep-database") {
      keepDatabase = true;
    } else if (arg === "--require-clean") {
      requireClean = true;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!target) throw new Error("choose exactly one of --staged, --base, or --diff-file");
  if (head && target.kind !== "base") throw new Error("--head requires --base");
  if (target.kind === "base" && head) target.head = head;
  const absoluteRepoPath = resolve(repoPath);
  return {
    repoPath: absoluteRepoPath,
    repoFullName: repoFullName ?? `local/${basename(absoluteRepoPath) || "repo"}`,
    prNumber,
    keepDatabase,
    requireClean,
    target,
  };
}

export async function runHarness(options: CliOptions): Promise<RunResult> {
  await assertGitRepository(options.repoPath);
  const diffText = await acquireDiff(options.repoPath, options.target);
  const selectedHead = options.target.kind === "base" ? options.target.head : "HEAD";
  const headSha = await gitMaybe(
    options.repoPath,
    ["rev-parse", `${selectedHead}^{commit}`],
    syntheticSha("1"),
  );
  const pullRequestTitle = await gitMaybe(
    options.repoPath,
    ["show", "-s", "--format=%s", selectedHead],
    "Proposed code change",
  );
  const baseSha =
    options.target.kind === "base"
      ? await gitMaybe(
          options.repoPath,
          ["rev-parse", `${options.target.base}^{commit}`],
          syntheticSha("0"),
        )
      : headSha;
  const repositorySource: RepositorySource =
    options.target.kind === "staged"
      ? { kind: "index" }
      : options.target.kind === "base"
        ? { kind: "tree", ref: selectedHead }
        : { kind: "working-tree" };
  const baseRepositorySource: RepositorySource =
    options.target.kind === "base"
      ? { kind: "tree", ref: options.target.base }
      : repositorySource;

  const database = await createDisposableDatabase(options.repoFullName, options.keepDatabase);
  const github = createLocalGitHubServer({
    repoPath: options.repoPath,
    repoFullName: options.repoFullName,
    prNumber: options.prNumber,
    diffText,
    headSha,
    baseSha,
    pullRequestTitle,
    repositorySource,
    baseRepositorySource,
  });

  const cacheDir = await mkdtemp(join(tmpdir(), "postil-local-review-cache-"));
  const oldEnv = { ...process.env };
  let closeDatabasePool: (() => Promise<void>) | undefined;
  try {
    const modelApiKey = process.env.MODEL_API_KEY?.trim();
    if (!modelApiKey) throw new Error("local review model credential is unavailable");
    const sealingKey = randomBytes(32);
    const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs1", format: "pem" })
      .toString();

    process.env.DATABASE_URL = database.databaseUrl;
    process.env.POSTIL_CACHE_DIR = cacheDir;
    process.env.GITHUB_API_URL = github.origin;
    process.env.GITHUB_APP_ID = "1";
    process.env.GITHUB_APP_PRIVATE_KEY = privateKey;
    process.env.POSTIL_SEALING_KEY = sealingKey.toString("hex");
    process.env.POSTIL_QUEUE_DRAIN_MAX_JOBS = "1";
    process.env.POSTIL_QUEUE_DRAIN_DEADLINE_MS = "720000";

    const [{ getPool, closeDb }, { enqueueJob }, { drainQueueOnce }] = await Promise.all([
      import("@/lib/db"),
      import("@/lib/queue"),
      import("@/worker/runner"),
    ]);
    closeDatabasePool = closeDb;

    const pool = getPool();
    await pool.query(
      `INSERT INTO org_settings (
         org_id,
         api_base,
         api_key_ciphertext,
         api_format,
         model,
         model_cascade,
         gate_enabled
       )
       SELECT id, $1, $2, $3, $4, $5, true
       FROM organizations
       WHERE slug = 'local'`,
      [
        process.env.POSTIL_API_BASE,
        seal(modelApiKey, sealingKey),
        process.env.POSTIL_API_FORMAT,
        process.env.REVIEW_MODEL,
        process.env.REVIEW_MODEL_CASCADE,
      ],
    );
    const authority = await pool.query<{
      source_installation_id: string;
      source_org_id: string;
      github_repo_id: string;
    }>(
      `SELECT installation.id AS source_installation_id,
              installation.org_id AS source_org_id,
              repository.github_repo_id
       FROM installations installation
       JOIN repositories repository ON repository.installation_id = installation.id
       WHERE installation.github_installation_id = $1
         AND repository.full_name = $2`,
      [DEFAULT_INSTALLATION_ID, options.repoFullName],
    );
    const source = authority.rows[0];
    if (!source) throw new Error("local review source identity is unavailable");
    const payload = {
      installationId: DEFAULT_INSTALLATION_ID,
      sourceInstallationId: Number(source.source_installation_id),
      sourceOrgId: Number(source.source_org_id),
      githubRepoId: Number(source.github_repo_id),
      repoFullName: options.repoFullName,
      prNumber: options.prNumber,
      headSha,
      baseSha,
    };
    const jobId = await enqueueJob(pool, "review", payload, { maxAttempts: 1 });
    const drained = await drainQueueOnce("local-review", {
      maxJobs: 1,
      deadlineMs: 12 * 60 * 1000,
    });
    if (drained !== 1) throw new Error(`local review drain claimed ${drained} jobs`);

    const jobRow = await pool.query<{ status: string }>(
      "SELECT status FROM jobs WHERE id = $1",
      [jobId],
    );
    const reviewRow = await pool.query<{
      id: string;
      status: string;
      gate_failing: boolean | null;
      envelope: Envelope | null;
      error_message: string | null;
    }>(
      `SELECT id, status, gate_failing, envelope, error_message
       FROM reviews
       ORDER BY id DESC
       LIMIT 1`,
    );
    const review = reviewRow.rows[0];
    if (!review) throw new Error("worker did not create a review row");
    const jobStatus = jobRow.rows[0]?.status ?? "missing";
    if (jobStatus !== "done" || review.status !== "completed") {
      throw new Error(
        `local review did not complete: job=${jobStatus} review=${review.status}` +
          (review.error_message ? `: ${review.error_message}` : ""),
      );
    }

    return {
      reviewId: Number(review.id),
      jobStatus,
      reviewStatus: review.status,
      gateFailing: review.gate_failing ?? false,
      envelope: review.envelope,
      events: github.events,
    };
  } finally {
    await closeDatabasePool?.().catch(() => undefined);
    github.stop();
    await rm(cacheDir, { recursive: true, force: true }).catch(() => undefined);
    await database.cleanup();
    restoreEnv(oldEnv);
  }
}

export function formatRunSummary(result: RunResult): string {
  const lines: string[] = [];
  lines.push("Local hosted-review run");
  lines.push(`review_id=${result.reviewId} job=${result.jobStatus} review=${result.reviewStatus}`);
  lines.push("");
  lines.push("Check-runs created:");
  const created = result.events.filter((event): event is CheckCreated => event.type === "check-created");
  if (created.length === 0) {
    lines.push("  none");
  } else {
    for (const event of created) {
      lines.push(`  #${event.id} ${event.name} head=${event.headSha}`);
    }
  }

  lines.push("");
  lines.push("Check-runs completed:");
  const completed = result.events.filter(
    (event): event is CheckCompleted => event.type === "check-completed",
  );
  if (completed.length === 0) {
    lines.push("  none");
  } else {
    for (const event of completed) {
      lines.push(`  #${event.id} ${event.conclusion}: ${event.title}`);
      for (const line of firstLines(event.summary, 3)) lines.push(`    ${line}`);
      if (event.annotations > 0) lines.push(`    annotations=${event.annotations}`);
    }
  }

  const posted = result.events.filter((event): event is ReviewPosted => event.type === "review-posted");
  lines.push("");
  lines.push("PR reviews posted to local fake GitHub:");
  if (posted.length === 0) {
    lines.push("  none");
  } else {
    for (const event of posted) {
      lines.push(`  commit=${event.commitId} comments=${event.comments}`);
      for (const line of firstLines(event.body, 3)) lines.push(`    ${line}`);
    }
  }

  lines.push("");
  lines.push("Review findings:");
  const findings = result.envelope?.findings ?? [];
  if (findings.length === 0) {
    lines.push("  none");
  } else {
    for (const finding of findings) {
      lines.push(`  ${formatFinding(finding)}`);
      lines.push(`    ${finding.title}`);
      if (finding.scorerReason) lines.push(`    scorer_reason=${finding.scorerReason}`);
    }
  }

  if (result.envelope) {
    lines.push("");
    lines.push(
      `Gate: ${result.gateFailing ? "failed" : "passed"} ` +
        `(fail_on=${result.envelope.gate.failOn}, model=${result.envelope.modelUsed})`,
    );
    if (result.envelope.scorerModel) lines.push(`Scorer: ${result.envelope.scorerModel}`);
    if (result.envelope.scorerError) lines.push(`Scorer error: ${result.envelope.scorerError}`);
    if (result.envelope.scorerDisagreements !== undefined) {
      lines.push(`Scorer disagreements: ${result.envelope.scorerDisagreements}`);
    }
  } else {
    lines.push("");
    lines.push("Gate: unavailable because no envelope was stored");
  }

  return lines.join("\n");
}

function createLocalGitHubServer(input: {
  repoPath: string;
  repoFullName: string;
  prNumber: number;
  diffText: string;
  headSha: string;
  baseSha: string;
  pullRequestTitle: string;
  repositorySource: RepositorySource;
  baseRepositorySource: RepositorySource;
}): LocalGitHubServer {
  const events: LocalGitHubEvent[] = [];
  const pullFiles = pullFilesFromDiff(input.diffText);
  let nextCheckRunId = 1000;
  const checkRuns = new Map<number, LocalCheckRunState>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname;
      if (request.method === "POST" && /^\/app\/installations\/\d+\/access_tokens$/.test(path)) {
        return json({
          token: "ghs_local_review_token",
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        });
      }

      const repositoryPath = `/repos/${input.repoFullName}`;
      if (request.method === "GET" && path === repositoryPath) {
        return json({ id: DEFAULT_REPOSITORY_ID, full_name: input.repoFullName, private: false });
      }

      const prefix = `${repositoryPath}/`;
      if (!path.startsWith(prefix)) return notFound();
      const suffix = path.slice(prefix.length);

      if (request.method === "GET" && suffix === `pulls/${input.prNumber}`) {
        const accept = request.headers.get("accept") ?? "";
        if (accept.includes("diff")) {
          return new Response(input.diffText, {
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          });
        }
        return json({
          title: input.pullRequestTitle,
          body: "",
          state: "open",
          merged: false,
          head: { sha: input.headSha },
          base: { sha: input.baseSha },
          changed_files: pullFiles.length,
        });
      }

      if (request.method === "GET" && suffix.startsWith("compare/")) {
        const accept = request.headers.get("accept") ?? "";
        if (!accept.includes("diff")) {
          return json({ merge_base_commit: { sha: input.baseSha } });
        }
        return new Response(input.diffText, {
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }

      if (
        request.method === "GET" &&
        suffix.startsWith(`pulls/${input.prNumber}/files`)
      ) {
        const page = Number(url.searchParams.get("page") ?? "1");
        return json(page === 1 ? pullFiles : []);
      }

      if (request.method === "GET" && suffix.startsWith("contents/")) {
        const relative = decodeURIComponent(suffix.slice("contents/".length));
        const ref = url.searchParams.get("ref");
        const source = ref === input.baseSha ? input.baseRepositorySource : input.repositorySource;
        return serveRepoFile(input.repoPath, source, relative);
      }

      if (request.method === "POST" && suffix === "check-runs") {
        const body = await request.json().catch(() => ({}));
        const id = nextCheckRunId++;
        const name = readString(body, "name", "unknown");
        const headSha = readString(body, "head_sha", input.headSha);
        const externalId = readString(body, "external_id", "") || null;
        checkRuns.set(id, {
          id,
          name,
          external_id: externalId,
          head_sha: headSha,
          status: "in_progress",
          conclusion: null,
          output: null,
        });
        events.push({ type: "check-created", id, name, headSha, body });
        console.log(`[local github] would create check-run #${id} ${name} on ${headSha}`);
        return json({ id });
      }

      const commitChecksMatch = suffix.match(
        /^commits\/([^/]+)\/check-runs$/,
      );
      if (request.method === "GET" && commitChecksMatch) {
        const headSha = decodeURIComponent(commitChecksMatch[1] ?? "");
        const checkName = url.searchParams.get("check_name");
        const requestedPerPage = Number(
          url.searchParams.get("per_page") ?? "100",
        );
        const requestedPage = Number(url.searchParams.get("page") ?? "1");
        const perPage =
          Number.isSafeInteger(requestedPerPage) && requestedPerPage > 0
            ? requestedPerPage
            : 100;
        const page =
          Number.isSafeInteger(requestedPage) && requestedPage > 0
            ? requestedPage
            : 1;
        const matching = [...checkRuns.values()].filter(
          (checkRun) =>
            checkRun.head_sha === headSha &&
            (!checkName || checkRun.name === checkName),
        );
        const start = (page - 1) * perPage;
        return json({
          total_count: matching.length,
          check_runs: matching.slice(start, start + perPage),
        });
      }

      const checkMatch = suffix.match(/^check-runs\/(\d+)$/);
      if (request.method === "GET" && checkMatch) {
        const checkRun = checkRuns.get(Number(checkMatch[1]));
        return checkRun ? json(checkRun) : notFound();
      }
      if (request.method === "PATCH" && checkMatch) {
        const body = await request.json().catch(() => ({}));
        const output = isRecord(body.output) ? body.output : {};
        const id = Number(checkMatch[1]);
        const conclusion = readConclusion(body);
        const checkRun = checkRuns.get(id);
        if (!checkRun) return notFound();
        checkRun.status = "completed";
        checkRun.conclusion = conclusion;
        const title = readString(output, "title", "No title");
        const summary = readString(output, "summary", "");
        checkRun.output = { title, summary };
        const annotations = Array.isArray(output.annotations) ? output.annotations.length : 0;
        events.push({
          type: "check-completed",
          id,
          conclusion,
          title,
          summary,
          annotations,
          body,
        });
        console.log(`[local github] would complete check-run #${id} as ${conclusion}: ${title}`);
        return json({ id });
      }

      if (request.method === "POST" && suffix === `pulls/${input.prNumber}/reviews`) {
        const payload = await request.json().catch(() => ({}));
        const comments = Array.isArray(payload.comments) ? payload.comments.length : 0;
        events.push({
          type: "review-posted",
          commitId: readString(payload, "commit_id", input.headSha),
          body: readString(payload, "body", ""),
          comments,
          payload,
        });
        console.log(`[local github] would post PR review with ${comments} comment(s)`);
        return json({ id: nextCheckRunId++ });
      }

      return notFound();
    },
  });

  return {
    origin: `http://${server.hostname}:${server.port}`,
    events,
    stop: () => server.stop(true),
  };
}

export function pullFilesFromDiff(diffText: string): LocalPullFile[] {
  const sections = diffText.split(/^diff --git /m).slice(1);
  return sections.flatMap((section) => {
    const lines = section.split("\n");
    const oldMarker = lines.find((line) => line.startsWith("--- "))?.slice(4);
    const newMarker = lines.find((line) => line.startsWith("+++ "))?.slice(4);
    const renamedFrom = lines.find((line) => line.startsWith("rename from "))?.slice(12);
    const renamedTo = lines.find((line) => line.startsWith("rename to "))?.slice(10);
    const oldPath = renamedFrom ?? repositoryPathFromMarker(oldMarker);
    const newPath = renamedTo ?? repositoryPathFromMarker(newMarker);
    const filename = newPath ?? oldPath;
    if (!filename) return [];
    const status =
      oldMarker === "/dev/null"
        ? "added"
        : newMarker === "/dev/null"
          ? "removed"
          : renamedFrom && renamedTo
            ? "renamed"
            : "modified";
    const changes = lines.filter(
      (line) =>
        (line.startsWith("+") && !line.startsWith("+++")) ||
        (line.startsWith("-") && !line.startsWith("---")),
    ).length;
    return [
      {
        filename,
        status,
        ...(status === "renamed" && oldPath ? { previous_filename: oldPath } : {}),
        changes,
      },
    ];
  });
}

function repositoryPathFromMarker(marker: string | undefined): string | undefined {
  if (!marker || marker === "/dev/null") return undefined;
  return marker.startsWith("a/") || marker.startsWith("b/") ? marker.slice(2) : marker;
}

async function createDisposableDatabase(
  repoFullName: string,
  keepDatabase: boolean,
): Promise<DatabaseHandle> {
  let containerName: string | undefined;
  let adminUrl = process.env.POSTIL_TEST_DATABASE_URL;
  if (!adminUrl) {
    const port = await freePort();
    containerName = `postil-local-review-${process.pid}-${randomBytes(3).toString("hex")}`;
    await run(["podman", "run", "-d", "--rm", "--name", containerName, "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-p", `127.0.0.1:${port}:5432`, "postgres:17.2-alpine"]);
    adminUrl = `postgresql://postgres@127.0.0.1:${port}/postgres`;
  }
  assertLocalDatabase(adminUrl);
  await waitForDatabase(adminUrl);

  const databaseName = `postil_local_review_${process.pid}_${Date.now()}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  await admin.end();

  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  await applyMigrations(databaseUrl.toString());
  await seedFixture(databaseUrl.toString(), repoFullName);

  return {
    databaseUrl: databaseUrl.toString(),
    async cleanup() {
      if (!keepDatabase) {
        const cleanupClient = new Client({ connectionString: adminUrl });
        await cleanupClient.connect().catch(() => undefined);
        await cleanupClient
          .query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`)
          .catch(() => undefined);
        await cleanupClient.end().catch(() => undefined);
      } else {
        console.log(`local review database retained: ${databaseName}`);
      }
      if (containerName) await run(["podman", "stop", containerName]).catch(() => undefined);
    },
  };
}

async function applyMigrations(databaseUrl: string): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const dir = join(root, "drizzle");
    const files = (await readdir(dir)).filter((file) => file.endsWith(".sql")).sort();
    for (const file of files) {
      const sqlText = await readFile(join(dir, file), "utf8");
      for (const statement of sqlText.split("--> statement-breakpoint")) {
        const trimmed = statement.trim();
        if (trimmed) await client.query(trimmed);
      }
    }
  } finally {
    await client.end();
  }
}

async function seedFixture(databaseUrl: string, repoFullName: string): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`
      WITH org AS (
        INSERT INTO organizations (slug, name, github_org_id)
        VALUES ('local', 'Local Harness', 990001)
        RETURNING id
      ),
      installation AS (
        INSERT INTO installations (github_installation_id, org_id, account_login, account_type, suspended)
        SELECT ${DEFAULT_INSTALLATION_ID}, org.id, 'local', 'Organization', false
        FROM org
        RETURNING id, org_id
      ),
      repository AS (
        INSERT INTO repositories (installation_id, github_repo_id, full_name, private, enabled)
        SELECT installation.id, ${DEFAULT_REPOSITORY_ID}, $1, false, true
        FROM installation
        RETURNING id, github_repo_id, full_name, private
      )
      INSERT INTO repository_enablement_events (
        org_id,
        repository_id,
        github_repo_id,
        repository_full_name,
        repository_private,
        action,
        source
      )
      SELECT installation.org_id, repository.id, repository.github_repo_id, repository.full_name, repository.private, 'enable', 'migration_baseline'
      FROM installation, repository
    `, [repoFullName]);
  } finally {
    await client.end();
  }
}

async function acquireDiff(repoPath: string, target: DiffTarget): Promise<string> {
  if (target.kind === "diff-file") return readFile(resolve(repoPath, target.path), "utf8");
  const args =
    target.kind === "staged"
      ? ["diff", "--cached", "--no-color", "--no-ext-diff", "--no-textconv"]
      : [
          "diff",
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          `${target.base}...${target.head}`,
        ];
  return git(repoPath, args);
}

async function serveRepoFile(
  repoPath: string,
  source: RepositorySource,
  relativePath: string,
): Promise<Response> {
  if (!isSafeRepositoryPath(relativePath)) return notFound();
  try {
    if (source.kind === "working-tree") {
      const path = resolve(repoPath, relativePath);
      const [repositoryRoot, resolvedPath] = await Promise.all([realpath(repoPath), realpath(path)]);
      const repositoryRelativePath = relative(repositoryRoot, resolvedPath);
      if (
        repositoryRelativePath === ".." ||
        repositoryRelativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
        isAbsolute(repositoryRelativePath)
      ) {
        return notFound();
      }
      const fileStat = await stat(resolvedPath);
      if (!fileStat.isFile()) return notFound();
      return new Response(await readFile(resolvedPath), {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    const object = source.kind === "index" ? `:${relativePath}` : `${source.ref}:${relativePath}`;
    const contents = await git(repoPath, ["show", object]);
    return new Response(contents, {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  } catch {
    return notFound();
  }
}

function isSafeRepositoryPath(relativePath: string): boolean {
  if (!relativePath || relativePath.startsWith("/") || relativePath.includes("\\")) return false;
  return !relativePath.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

async function assertGitRepository(repoPath: string): Promise<void> {
  await git(repoPath, ["rev-parse", "--show-toplevel"]);
}

async function git(repoPath: string, args: string[]): Promise<string> {
  const output = await run(["git", ...args], undefined, repoPath, true);
  return output.trimEnd();
}

async function gitMaybe(repoPath: string, args: string[], fallback: string): Promise<string> {
  try {
    const output = await git(repoPath, args);
    return output.trim() || fallback;
  } catch {
    return fallback;
  }
}

async function run(
  command: string[],
  env?: Record<string, string | undefined>,
  cwd = root,
  capture = false,
): Promise<string> {
  const child = Bun.spawn(command, {
    cwd,
    env,
    stdout: capture ? "pipe" : "inherit",
    stderr: capture ? "pipe" : "inherit",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    capture ? new Response(child.stdout).text() : "",
    capture ? new Response(child.stderr).text() : "",
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed (${exitCode})\n${stderr || stdout}`);
  }
  return stdout;
}

async function waitForDatabase(databaseUrl: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const client = new Client({ connectionString: databaseUrl });
    try {
      await client.connect();
      await client.end();
      return;
    } catch (err) {
      lastError = err;
      await client.end().catch(() => undefined);
      await Bun.sleep(500);
    }
  }
  throw new Error(`database did not become reachable: ${String(lastError)}`);
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === "object" && address) resolvePort(address.port);
        else reject(new Error("could not allocate a local port"));
      });
    });
    server.on("error", reject);
  });
}

function assertLocalDatabase(databaseUrl: string): void {
  const url = new URL(databaseUrl);
  if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
    throw new Error("local review harness refuses to use a non-local Postgres URL");
  }
}

function restoreEnv(oldEnv: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in oldEnv)) delete process.env[key];
  }
  Object.assign(process.env, oldEnv);
}

function firstLines(text: string, limit: number): string[] {
  const lines = text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean);
  return lines.slice(0, limit);
}

function formatFinding(finding: Finding): string {
  const scorer: string[] = [];
  if (finding.generatorConfidence !== undefined) {
    scorer.push(`generator=${formatConfidence(finding.generatorConfidence)}`);
  }
  if (finding.scorerConfidence !== undefined) {
    scorer.push(`scorer=${formatConfidence(finding.scorerConfidence)}`);
  }
  if (finding.generatorKind) scorer.push(`generator_kind=${finding.generatorKind}`);
  if (finding.scorerKind) scorer.push(`scorer_kind=${finding.scorerKind}`);
  return [
    `${finding.severity}/${finding.kind}`,
    `${finding.path}:${finding.line}`,
    `confidence=${formatConfidence(finding.confidence)}`,
    ...scorer,
  ].join(" ");
}

function formatConfidence(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function syntheticSha(char: string): string {
  return char.repeat(40);
}

function readString(record: unknown, key: string, fallback: string): string {
  if (!isRecord(record)) return fallback;
  const value = record[key];
  return typeof value === "string" ? value : fallback;
}

function readConclusion(record: unknown): CheckConclusion {
  const value = readString(record, "conclusion", "neutral");
  return value === "success" || value === "failure" || value === "neutral" ? value : "neutral";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function notFound(): Response {
  return json({ message: "Not Found" }, 404);
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function positiveInteger(raw: string, flag: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function ensureNoTarget(target: DiffTarget | undefined): void {
  if (target) throw new Error("choose exactly one of --staged, --base, or --diff-file");
}

function printUsage(): void {
  console.log(`Usage:
  bun run scripts/run-review-locally.ts --staged [--repo-path PATH]
  bun run scripts/run-review-locally.ts --base REF [--head REF] [--repo-path PATH]
  bun run scripts/run-review-locally.ts --diff-file PATH [--repo-path PATH]

Options:
  --repo-path PATH    Git repository containing the local diff. Defaults to cwd.
  --repo OWNER/NAME   Synthetic repository slug exposed by the local fake GitHub API.
  --pr NUMBER         Synthetic pull request number. Defaults to 1.
  --keep-database     Keep the disposable database for inspection.
  --require-clean     Exit 1 when any surviving finding would be posted.
`);
}

async function ensureLocalModelCredential(): Promise<void> {
  let openRouterApiKey = process.env.OPENROUTER_API_KEY?.trim() ?? "";

  if (!openRouterApiKey) {
    const trustedHome = await resolveTrustedHome();
    const explicitSecrets = process.env.POSTIL_LOCAL_SECRETS_BIN?.trim();
    if (explicitSecrets && !isAbsolute(explicitSecrets)) {
      throw new Error("POSTIL_LOCAL_SECRETS_BIN must be an absolute path");
    }
    const candidate = explicitSecrets ?? join(trustedHome, ".local", "bin", "secrets");
    let secretsExecutable: string;
    try {
      secretsExecutable = await realpath(candidate);
      const metadata = await stat(secretsExecutable);
      if (!metadata.isFile() || (metadata.mode & 0o111) === 0) throw new Error("not executable");
    } catch {
      throw new Error(
        "local review has no OPENROUTER_API_KEY and no trusted secrets executable is available",
      );
    }
    const trustedPath = [
      "/usr/bin",
      "/bin",
      dirname(process.execPath),
      join(trustedHome, ".volta", "bin"),
      join(trustedHome, ".bun", "bin"),
      dirname(secretsExecutable),
    ].join(":");
    const child = Bun.spawn(
      [secretsExecutable, "--profile", "morgaesis", "get", "OPENROUTER_API_KEY"],
      {
        env: { HOME: trustedHome, PATH: trustedPath },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [secret, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    openRouterApiKey = secret.trim();
    if (exitCode !== 0 || !openRouterApiKey) {
      throw new Error(
        "could not load OPENROUTER_API_KEY from the morgaesis secrets profile" +
          (stderr.trim() ? `: ${stderr.trim()}` : "") +
          "; run `infisical-morgaesis login` to refresh the session",
      );
    }
  }
  process.env.MODEL_API_KEY = openRouterApiKey;
  delete process.env.POSTIL_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.POSTIL_LOCAL_SECRETS_BIN;
  delete process.env.POSTIL_ENDPOINT_AUTH_HEADER;
  delete process.env.POSTIL_ENDPOINT_AUTH_VALUE;
  delete process.env.POSTIL_ALLOW_CONFIG_API_BASE;
  process.env.POSTIL_API_BASE = "https://openrouter.ai/api/v1";
  process.env.POSTIL_API_FORMAT = "openai-compatible";
  // This harness uses the maintainer's own OpenRouter credential and an
  // explicit review model. Hosted mode accepts only a promoted qualification
  // profile and therefore must remain disabled for this local BYOK path.
  process.env.POSTIL_HOSTED_MODE = "0";
  process.env.REVIEW_MODEL =
    process.env.POSTIL_LOCAL_REVIEW_MODEL?.trim() || "z-ai/glm-5.2";
  // The CLI deduplicates the model chain. Repeating the primary model yields
  // one attempt, while an empty cascade variable would retain built-in defaults.
  process.env.REVIEW_MODEL_CASCADE = process.env.REVIEW_MODEL;
  process.env.POSTIL_DISABLE_SCORER = "1";
  delete process.env.REVIEW_SCORER_MODEL;
}

async function ensureTrustedPostilExecutable(): Promise<void> {
  const trustedHome = await resolveTrustedHome();
  const explicit = process.env.POSTIL_BIN?.trim();
  if (explicit && !isAbsolute(explicit)) {
    throw new Error("POSTIL_BIN must be an absolute path for local review");
  }
  const candidates = explicit
    ? [explicit]
    : [
        join(trustedHome, ".local", "bin", "postil"),
        "/usr/local/bin/postil",
        "/usr/bin/postil",
      ];
  let executable: string | undefined;
  for (const candidate of candidates) {
    try {
      const resolved = await realpath(candidate);
      const metadata = await stat(resolved);
      if (metadata.isFile() && (metadata.mode & 0o111) !== 0) {
        executable = resolved;
        break;
      }
    } catch {
      // Try the next trusted installation location.
    }
  }
  if (!executable) {
    throw new Error("no executable Postil binary exists in a trusted installation location");
  }
  const trustedPath = [
    "/usr/bin",
    "/bin",
    dirname(process.execPath),
    join(trustedHome, ".volta", "bin"),
    join(trustedHome, ".bun", "bin"),
    join(trustedHome, ".local", "bin"),
    dirname(executable),
  ].join(":");
  const child = Bun.spawn([executable, "--version"], {
    env: { HOME: trustedHome, PATH: trustedPath },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const versionMatch = /^postil (\d+)\.(\d+)\.(\d+)(?:\+[^\s]+)?$/m.exec(stdout.trim());
  const supported =
    exitCode === 0 &&
    versionMatch !== null &&
    (Number(versionMatch[1]) > 0 || Number(versionMatch[2]) >= 6);
  if (!supported) {
    throw new Error(
      `local review requires Postil v0.6.0 or newer; ${executable} reported ${JSON.stringify((stdout || stderr).trim())}`,
    );
  }
  const supportsBoundedReview =
    Number(versionMatch[1]) > 0 || Number(versionMatch[2]) >= 7;
  process.env.POSTIL_LOCAL_REVIEW_BOUNDED = supportsBoundedReview ? "1" : "0";
  process.env.POSTIL_BIN = executable;
  process.env.PATH = trustedPath;
}

async function resolveTrustedHome(): Promise<string> {
  const home = process.env.HOME?.trim();
  if (!home || !isAbsolute(home)) throw new Error("HOME must be an absolute directory for local review");
  const resolved = await realpath(home);
  if (!(await stat(resolved)).isDirectory()) {
    throw new Error("HOME must be an absolute directory for local review");
  }
  return resolved;
}

function clearInjectedGitEnvironment(): void {
  for (const name of [
    "GIT_EXTERNAL_DIFF",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_SYSTEM",
    "GIT_EXEC_PATH",
    "GIT_DIR",
    "GIT_WORK_TREE",
  ]) {
    delete process.env[name];
  }
  for (const name of Object.keys(process.env)) {
    if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(name)) delete process.env[name];
  }
}

if (import.meta.main) {
  try {
    const options = parseArgs(process.argv.slice(2));
    await ensureTrustedPostilExecutable();
    clearInjectedGitEnvironment();
    await ensureLocalModelCredential();
    const result = await runHarness(options);
    console.log("");
    console.log(formatRunSummary(result));
    const hasFindings = (result.envelope?.findings.length ?? 0) > 0;
    process.exitCode = result.gateFailing || (options.requireClean && hasFindings) ? 1 : 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 2;
  }
}
