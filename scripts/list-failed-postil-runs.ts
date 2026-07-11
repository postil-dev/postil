import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

interface Options {
  org: string;
  since: string;
  until: string;
  stateFile: string;
}

interface GitHubRepository {
  full_name: string;
  archived: boolean;
}

interface PullRequest {
  number: number;
  html_url: string;
  head: { sha: string };
}

export interface ReviewHead {
  repo: string;
  pr: number;
  prUrl: string;
  commit: string;
}

export interface TimelineEvent {
  event?: string;
  sha?: string;
  commit_id?: string;
}

interface ReviewHeadState {
  version: 1;
  org: string;
  heads: ReviewHead[];
}

export interface CheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  head_sha: string;
  started_at: string | null;
  completed_at: string | null;
  details_url: string | null;
  html_url: string;
  app: { slug: string } | null;
  pull_requests?: Array<{ number: number }>;
  output: {
    title: string | null;
    summary: string | null;
  };
}

interface CheckRunsPage {
  check_runs: CheckRun[];
}

export interface FailedPostilRun {
  repo: string;
  pr: number | null;
  prUrl: string | null;
  prCandidates: number[];
  commit: string;
  org: string | null;
  model: string | null;
  startedAt: string | null;
  completedAt: string;
  kind: "gate" | "operational";
  error: string;
  gateCheckId: number | null;
  gateCheckUrl: string | null;
  reviewCheckId: number | null;
  detailsUrl: string | null;
}

const POSTIL_APP_SLUG = "postil-dev";
const GATE_CHECK_NAME = "postil/gate";
const REVIEW_CHECK_NAME = "postil/review";

function usage(): string {
  return "Usage: bun scripts/list-failed-postil-runs.ts --since <ISO-8601> [--until <ISO-8601>] [--org <GitHub-org>] [--state-file <path>]";
}

function isoTimestamp(value: string, flag: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`${flag} must be an ISO-8601 timestamp`);
  return new Date(timestamp).toISOString();
}

export function parseArgs(argv: string[], now = new Date()): Options {
  let org = "postil-dev";
  let since: string | undefined;
  let until = now.toISOString();
  let stateFile: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") throw new Error(usage());
    if (
      flag !== "--org" &&
      flag !== "--since" &&
      flag !== "--until" &&
      flag !== "--state-file"
    ) {
      throw new Error(`unknown argument: ${flag ?? ""}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    index += 1;
    if (flag === "--org") org = value;
    if (flag === "--since") since = value;
    if (flag === "--until") until = value;
    if (flag === "--state-file") stateFile = value;
  }

  if (!since) throw new Error(`--since is required\n${usage()}`);
  if (!/^[A-Za-z0-9_.-]+$/.test(org)) throw new Error("--org is not a valid GitHub organization");
  const normalizedSince = isoTimestamp(since, "--since");
  const normalizedUntil = isoTimestamp(until, "--until");
  if (Date.parse(normalizedSince) >= Date.parse(normalizedUntil)) {
    throw new Error("--since must be earlier than --until");
  }
  return {
    org,
    since: normalizedSince,
    until: normalizedUntil,
    stateFile:
      stateFile ??
      join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "postil", `${org}-review-heads.json`),
  };
}

function extractModel(summary: string | null | undefined): string | null {
  return summary?.match(/(?:^|\n)Model:\s*([^\n]+)\s*(?:\n|$)/)?.[1]?.trim() ?? null;
}

function extractOrg(detailsUrl: string | null | undefined): string | null {
  if (!detailsUrl) return null;
  try {
    const match = new URL(detailsUrl).pathname.match(/^\/orgs\/([^/]+)\/runs\//);
    return match ? decodeURIComponent(match[1]!) : null;
  } catch {
    return null;
  }
}

function checkTime(check: CheckRun): number | null {
  if (!check.completed_at) return null;
  const timestamp = Date.parse(check.completed_at);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function checkAppliesToPr(check: CheckRun, pr: number): boolean {
  return !check.pull_requests?.length || check.pull_requests.some((pull) => pull.number === pr);
}

function distanceFromGate(gate: CheckRun, review: CheckRun): number {
  const gateTime = Date.parse(gate.started_at ?? gate.completed_at ?? "");
  const reviewTime = Date.parse(review.started_at ?? review.completed_at ?? "");
  if (!Number.isFinite(gateTime) || !Number.isFinite(reviewTime)) return Number.MAX_SAFE_INTEGER;
  return Math.abs(gateTime - reviewTime);
}

function pairedCheck(target: CheckRun, candidates: CheckRun[]): CheckRun | undefined {
  const sameHead = candidates.filter((candidate) => candidate.head_sha === target.head_sha);
  const sameRun = sameHead.filter(
    (candidate) => candidate.details_url === target.details_url,
  );
  return closestCheck(target, sameRun.length > 0 ? sameRun : sameHead);
}

export function failedRunsForCommit(
  repo: string,
  pr: number,
  prUrl: string,
  commit: string,
  checks: CheckRun[],
  since: string,
  until: string,
): FailedPostilRun[] {
  const start = Date.parse(since);
  const end = Date.parse(until);
  const postilChecks = checks.filter((check) => check.app?.slug === POSTIL_APP_SLUG);
  const gateFailures = postilChecks
    .filter((gate) => {
      const completed = checkTime(gate);
      return (
        gate.name === GATE_CHECK_NAME &&
        gate.status === "completed" &&
        gate.conclusion === "failure" &&
        completed !== null &&
        completed >= start &&
        completed < end &&
        checkAppliesToPr(gate, pr)
      );
    })
    .map((gate): FailedPostilRun => {
      const review = pairedCheck(
        gate,
        postilChecks.filter(
          (candidate) => candidate.name === REVIEW_CHECK_NAME,
        ),
      );
      const operational =
        gate.output.title === "Review did not complete" ||
        review?.output.title === "Review did not complete";
      return {
        repo,
        pr,
        prUrl,
        prCandidates: [pr],
        commit,
        org: extractOrg(gate.details_url) ?? repo.split("/")[0] ?? null,
        model: extractModel(review?.output.summary),
        startedAt: gate.started_at,
        completedAt: gate.completed_at!,
        kind: operational ? "operational" : "gate",
        error:
          (operational ? review?.output.summary?.trim() : gate.output.summary?.trim()) ||
          gate.output.summary?.trim() ||
          review?.output.summary?.trim() ||
          gate.output.title?.trim() ||
          "Postil gate failed without an output summary",
        gateCheckId: gate.id,
        gateCheckUrl: gate.html_url,
        reviewCheckId: review?.id ?? null,
        detailsUrl: gate.details_url,
      };
    });

  const pairedReviewIds = new Set(
    gateFailures.map((failure) => failure.reviewCheckId).filter((id) => id !== null),
  );
  const operationalFailures = postilChecks
    .filter((review) => {
      const completed = checkTime(review);
      return (
        review.name === REVIEW_CHECK_NAME &&
        review.status === "completed" &&
        review.output.title === "Review did not complete" &&
        completed !== null &&
        completed >= start &&
        completed < end &&
        checkAppliesToPr(review, pr) &&
        !pairedReviewIds.has(review.id)
      );
    })
    .map((review): FailedPostilRun => {
      const gate = pairedCheck(
        review,
        postilChecks.filter(
          (candidate) => candidate.name === GATE_CHECK_NAME,
        ),
      );
      return {
        repo,
        pr,
        prUrl,
        prCandidates: [pr],
        commit,
        org: extractOrg(review.details_url) ?? repo.split("/")[0] ?? null,
        model: extractModel(review.output.summary),
        startedAt: review.started_at,
        completedAt: review.completed_at!,
        kind: "operational",
        error:
          review.output.summary?.trim() ||
          gate?.output.summary?.trim() ||
          "Postil review did not complete without an output summary",
        gateCheckId: gate?.id ?? null,
        gateCheckUrl: gate?.html_url ?? null,
        reviewCheckId: review.id,
        detailsUrl: review.details_url,
      };
    });

  return [...gateFailures, ...operationalFailures];
}

function closestCheck(target: CheckRun, candidates: CheckRun[]): CheckRun | undefined {
  return candidates.sort(
    (left, right) => distanceFromGate(target, left) - distanceFromGate(target, right),
  )[0];
}

async function ghApi<T>(
  path: string,
  fields: Record<string, string> = {},
  attempt = 1,
): Promise<T[]> {
  const args = ["api", "--method", "GET", "--paginate", "--slurp", path];
  for (const [name, value] of Object.entries(fields)) args.push("-f", `${name}=${value}`);
  const process = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    process.kill();
  }, 60_000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  clearTimeout(timer);
  if (timedOut) {
    if (attempt < 3) return ghApi(path, fields, attempt + 1);
    throw new Error(`gh api ${path} exceeded the 60 second deadline`);
  }
  if (exitCode !== 0) {
    if (attempt < 3) {
      await Bun.sleep(250 * attempt);
      return ghApi(path, fields, attempt + 1);
    }
    throw new Error(`gh api ${path} failed (${exitCode}): ${stderr.trim() || stdout.trim()}`);
  }
  try {
    return JSON.parse(stdout) as T[];
  } catch (error) {
    if (attempt < 3) {
      await Bun.sleep(250 * attempt);
      return ghApi(path, fields, attempt + 1);
    }
    throw new Error(`gh api ${path} returned invalid JSON: ${String(error)}`);
  }
}

function reviewHeadKey(head: ReviewHead): string {
  return `${head.repo}#${head.pr}@${head.commit}`;
}

function isReviewHead(value: unknown): value is ReviewHead {
  if (typeof value !== "object" || value === null) return false;
  const head = value as Record<string, unknown>;
  return (
    typeof head.repo === "string" &&
    typeof head.pr === "number" &&
    typeof head.prUrl === "string" &&
    typeof head.commit === "string"
  );
}

export async function readReviewHeadState(path: string, org: string): Promise<ReviewHead[]> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`could not read review-head state ${path}: ${String(error)}`);
  }
  if (typeof value !== "object" || value === null) {
    throw new Error(`review-head state ${path} is invalid for organization ${org}`);
  }
  const state = value as Record<string, unknown>;
  if (
    state.version !== 1 ||
    state.org !== org ||
    !Array.isArray(state.heads) ||
    !state.heads.every(isReviewHead)
  ) {
    throw new Error(`review-head state ${path} is invalid for organization ${org}`);
  }
  return state.heads;
}

async function writeReviewHeadState(
  path: string,
  org: string,
  heads: ReviewHead[],
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  const state: ReviewHeadState = { version: 1, org, heads };
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function discoverReviewHeads(org: string): Promise<ReviewHead[]> {
  const repositoryPages = await ghApi<GitHubRepository[]>(
    `orgs/${org}/repos?type=all&per_page=100`,
  );
  const repositories = repositoryPages.flat();
  const currentHeads: ReviewHead[] = [];
  for (const repository of repositories) {
    const pullPages = await ghApi<PullRequest[]>(
      `repos/${repository.full_name}/pulls?state=all&per_page=100`,
    );
    for (const pull of pullPages.flat()) {
      currentHeads.push({
        repo: repository.full_name,
        pr: pull.number,
        prUrl: pull.html_url,
        commit: pull.head.sha,
      });
    }
  }
  const commitHeads = await mapConcurrent(currentHeads, 8, async (head) => {
    const timelinePages = await ghApi<TimelineEvent[]>(
      `repos/${head.repo}/issues/${head.pr}/timeline?per_page=100`,
    );
    return reviewHeadsFromTimeline(head, timelinePages.flat());
  });
  return [...currentHeads, ...commitHeads.flat()];
}

export function reviewHeadsFromTimeline(
  head: ReviewHead,
  events: TimelineEvent[],
): ReviewHead[] {
  return events
    .flatMap((event) => {
      if (event.event === "committed" && event.sha) return [event.sha];
      if (event.event === "head_ref_force_pushed" && event.commit_id) {
        return [event.commit_id];
      }
      return [];
    })
    .map((commit) => ({ ...head, commit }));
}

async function mapConcurrent<T, R>(
  values: T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await operation(values[index]!);
      }
    }),
  );
  return results;
}

export async function acquireStateLock(lockPath: string): Promise<() => Promise<void>> {
  const holder = Bun.spawn(
    ["flock", "--nonblock", lockPath, "sh", "-c", 'printf "locked\\n"; read -r _'],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  const reader = holder.stdout.getReader();
  const timer = setTimeout(() => holder.kill(), 5_000);
  const first = await reader.read();
  clearTimeout(timer);
  if (first.done || new TextDecoder().decode(first.value).trim() !== "locked") {
    const stderr = await new Response(holder.stderr).text();
    await holder.exited;
    throw new Error(
      `another failed-run poll is using ${lockPath.slice(0, -5)}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
    );
  }
  return async () => {
    holder.stdin.write("\n");
    holder.stdin.end();
    await holder.exited;
  };
}

async function listFailedRuns(options: Options): Promise<FailedPostilRun[]> {
  await mkdir(dirname(options.stateFile), { recursive: true });
  const lockPath = `${options.stateFile}.lock`;
  const releaseLock = await acquireStateLock(lockPath);

  try {
    return await listFailedRunsLocked(options);
  } finally {
    await releaseLock();
  }
}

async function listFailedRunsLocked(options: Options): Promise<FailedPostilRun[]> {
  const headsByKey = new Map<string, ReviewHead>();
  for (const head of await readReviewHeadState(options.stateFile, options.org)) {
    headsByKey.set(reviewHeadKey(head), head);
  }
  for (const head of await discoverReviewHeads(options.org)) {
    headsByKey.set(reviewHeadKey(head), head);
  }

  const heads = [...headsByKey.values()];
  await writeReviewHeadState(options.stateFile, options.org, heads);
  const results = await mapConcurrent(heads, 8, async (head) => {
    const checkPages = await ghApi<CheckRunsPage>(
      `repos/${head.repo}/commits/${head.commit}/check-runs?filter=all&per_page=100`,
    );
    return failedRunsForCommit(
      head.repo,
      head.pr,
      head.prUrl,
      head.commit,
      checkPages.flatMap((page) => page.check_runs),
      options.since,
      options.until,
    );
  });

  const failures: FailedPostilRun[] = [];
  const seenChecks = new Map<number, FailedPostilRun>();
  for (const headFailures of results) {
    for (const failure of headFailures) {
      const checkId = failure.gateCheckId ?? failure.reviewCheckId;
      const existing = checkId === null ? undefined : seenChecks.get(checkId);
      if (existing) {
        existing.prCandidates = [
          ...new Set([...existing.prCandidates, ...failure.prCandidates]),
        ].sort((left, right) => left - right);
        if (existing.pr !== failure.pr) {
          existing.pr = null;
          existing.prUrl = null;
        }
        continue;
      }
      if (checkId !== null) seenChecks.set(checkId, failure);
      failures.push(failure);
    }
  }
  return failures.sort((left, right) => left.completedAt.localeCompare(right.completedAt));
}

async function main(): Promise<void> {
  const argv = Bun.argv.slice(2);
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    console.log(usage());
    return;
  }
  let options: Options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
    return;
  }

  try {
    const failures = await listFailedRuns(options);
    for (const failure of failures) console.log(JSON.stringify(failure));
    process.exitCode = failures.length > 0 ? 1 : 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}

if (import.meta.main) await main();
