import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
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

export interface PullRequest {
  number: number;
  html_url: string;
  head: { sha: string };
  state: "open" | "closed";
  updated_at: string;
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
  created_at?: string;
}

export type ObservationStatus = "unobserved" | "empty" | "pending" | "terminal";

export interface ReviewHeadObservation extends ReviewHead {
  current: boolean;
  prState: "open" | "closed";
  prUpdatedAt: string;
  status: ObservationStatus;
  checks: CheckRun[];
  checkedAt: string | null;
  statusSince: string | null;
}

interface ReviewHeadStateV2 {
  version: 2;
  org: string;
  observations: ReviewHeadObservation[];
}

interface LoadedReviewHeadState {
  version: 1 | 2;
  observations: ReviewHeadObservation[];
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

export interface IncludedResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface RetryContext {
  attempt: number;
  status?: number;
  headers?: Record<string, string>;
  message: string;
  nowMs?: number;
  jitterMs?: number;
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
const DISCOVERY_OVERLAP_MS = 60 * 60 * 1_000;
const TERMINAL_GRACE_MS = 60 * 60 * 1_000;
const STALE_NONTERMINAL_MS = 24 * 60 * 60 * 1_000;
const OBSERVATION_REVALIDATE_MS = 60 * 60 * 1_000;
const MAX_RETRY_DELAY_MS = 5 * 60 * 1_000;
const MAX_API_PAGES = 100;
// Serial requests with this minimum spacing stay below 240 starts per minute,
// leaving headroom under GitHub's documented 900 REST points per minute limit.
const API_REQUEST_SPACING_MS = 250;
const API_REQUEST_JITTER_MS = 250;

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

export function parseIncludedResponse(output: string): IncludedResponse {
  const normalized = output.replaceAll("\r\n", "\n");
  let remaining = normalized;
  let response: IncludedResponse | undefined;
  while (remaining.startsWith("HTTP/")) {
    const match = remaining.match(/^HTTP\/\S+\s+(\d{3})[^\n]*\n([\s\S]*?)\n\n/);
    if (!match) break;
    const headers: Record<string, string> = {};
    for (const line of match[2]!.split("\n")) {
      const separator = line.indexOf(":");
      if (separator === -1) continue;
      headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
    }
    remaining = remaining.slice(match[0].length);
    response = { status: Number(match[1]), headers, body: remaining };
  }
  if (!response) throw new Error("gh api response did not include an HTTP status and headers");
  return response;
}

export function nextPageUrl(headers: Record<string, string>): string | null {
  const link = headers.link;
  if (!link) return null;
  for (const part of link.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="?next"?/);
    if (match) {
      const url = new URL(match[1]!);
      if (
        url.origin !== "https://api.github.com" ||
        url.username !== "" ||
        url.password !== "" ||
        url.hash !== ""
      ) {
        throw new Error(`gh api returned an unsafe pagination URL: ${url.origin}`);
      }
      return url.href;
    }
  }
  return null;
}

export function retryDelayMs(context: RetryContext): number | null {
  const headers = context.headers ?? {};
  const nowMs = context.nowMs ?? Date.now();
  const jitterMs = context.jitterMs ?? 0;
  const rateLimited =
    context.status === 429 ||
    (context.status === 403 && (
      headers["retry-after"] !== undefined ||
      headers["x-ratelimit-remaining"] === "0" ||
      /rate limit/i.test(context.message)
    ));
  if (rateLimited) {
    const retryAfter = headers["retry-after"];
    if (retryAfter) {
      const seconds = Number(retryAfter);
      const parsed = Date.parse(retryAfter);
      const base = Number.isFinite(seconds)
        ? seconds * 1_000
        : Number.isFinite(parsed) ? Math.max(0, parsed - nowMs) : null;
      if (base !== null) {
        const delay = Math.max(1_000, base) + jitterMs;
        return delay <= MAX_RETRY_DELAY_MS ? delay : null;
      }
    }
    if (headers["x-ratelimit-remaining"] === "0" && headers["x-ratelimit-reset"]) {
      const resetMs = Number(headers["x-ratelimit-reset"]) * 1_000;
      if (Number.isFinite(resetMs)) {
        const delay = Math.max(1_000, resetMs - nowMs) + jitterMs;
        return delay <= MAX_RETRY_DELAY_MS ? delay : null;
      }
    }
    if (
      context.status === 429 ||
      /(?:secondary rate limit|abuse detection|api rate limit exceeded)/i.test(context.message)
    ) {
      return 60_000 * 2 ** (context.attempt - 1) + jitterMs;
    }
    return null;
  }
  if (context.status !== undefined && context.status >= 400 && context.status < 500) {
    return null;
  }
  return 2_000 * 2 ** (context.attempt - 1) + jitterMs;
}

export interface GhAttempt {
  response?: IncludedResponse;
  exitCode: number;
  stderr: string;
  timedOut: boolean;
}

export interface GhApiDependencies {
  attempt: (path: string, fields: Record<string, string>) => Promise<GhAttempt>;
  sleep: (milliseconds: number) => Promise<void>;
  random: () => number;
  now: () => number;
}

export type PageContinuation<T> = (page: T, pageNumber: number) => boolean;

async function runGhApi(path: string, fields: Record<string, string>): Promise<GhAttempt> {
  const args = ["api", "--method", "GET", "--include", path];
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
  let response: IncludedResponse | undefined;
  try {
    response = parseIncludedResponse(stdout);
  } catch {
    // CLI/configuration failures can occur before an HTTP response exists.
  }
  return { response, exitCode, stderr: stderr.trim(), timedOut };
}

let ghApiQueue: Promise<void> = Promise.resolve();

function serializeGhApi<T>(operation: () => Promise<T>): Promise<T> {
  const result = ghApiQueue.then(operation, operation);
  ghApiQueue = result.then(() => undefined, () => undefined);
  return result;
}

export async function requestGhApiPages<T>(
  path: string,
  fields: Record<string, string>,
  dependencies: GhApiDependencies,
  continuePagination: PageContinuation<T> = () => true,
): Promise<T[]> {
  const pages: T[] = [];
  const visited = new Set<string>();
  let pagePath: string | null = path;
  let pageFields = fields;
  while (pagePath) {
    const activePage = pagePath;
    if (visited.has(activePage)) {
      throw new Error(`gh api pagination repeated ${activePage}`);
    }
    if (visited.size >= MAX_API_PAGES) {
      throw new Error(`gh api ${path} exceeded ${MAX_API_PAGES} pages`);
    }
    visited.add(activePage);
    let completed = false;
    let lastError = "unknown error";
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const result = await dependencies.attempt(activePage, pageFields);
      const status = result.response?.status;
      const body = result.response?.body ?? "";
      if (!result.timedOut && result.exitCode === 0 && status !== undefined && status < 400) {
        let page: T;
        try {
          page = JSON.parse(body) as T;
        } catch (error) {
          lastError = `returned invalid JSON: ${String(error)}`;
          const delay = retryDelayMs({
            attempt,
            status,
            message: lastError,
            nowMs: dependencies.now(),
            jitterMs: Math.floor(dependencies.random() * 1_001),
          });
          if (delay === null || attempt === 3) break;
          await dependencies.sleep(delay);
          continue;
        }
        const next = continuePagination(page, pages.length + 1)
          ? nextPageUrl(result.response!.headers)
          : null;
        pages.push(page);
        pagePath = next;
        pageFields = {};
        completed = true;
        break;
      } else if (result.timedOut) {
        lastError = "exceeded the 60 second deadline";
      } else {
        lastError = result.stderr || body.trim() || `HTTP ${status ?? "response unavailable"}`;
      }

      const delay = retryDelayMs({
        attempt,
        status,
        headers: result.response?.headers,
        message: lastError,
        nowMs: dependencies.now(),
        jitterMs: Math.floor(dependencies.random() * 1_001),
      });
      if (delay === null || attempt === 3) break;
      await dependencies.sleep(delay);
    }
    if (!completed) throw new Error(`gh api ${activePage} failed: ${lastError}`);
  }
  return pages;
}

async function ghApi<T>(
  path: string,
  fields: Record<string, string> = {},
  continuePagination?: PageContinuation<T>,
): Promise<T[]> {
  return serializeGhApi(() =>
    requestGhApiPages<T>(path, fields, {
      attempt: async (pagePath, pageFields) => {
        await Bun.sleep(
          API_REQUEST_SPACING_MS + Math.floor(Math.random() * (API_REQUEST_JITTER_MS + 1)),
        );
        return runGhApi(pagePath, pageFields);
      },
      sleep: Bun.sleep,
      random: Math.random,
      now: Date.now,
    }, continuePagination)
  );
}

function reviewHeadKey(head: ReviewHead): string {
  return `${head.repo}#${head.pr}@${head.commit}`;
}

function isReviewHead(value: unknown): value is ReviewHead {
  if (typeof value !== "object" || value === null) return false;
  const head = value as Record<string, unknown>;
  return (
    typeof head.repo === "string" &&
    typeof head.pr === "number" && Number.isFinite(head.pr) &&
    typeof head.prUrl === "string" &&
    typeof head.commit === "string"
  );
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isNullableTimestamp(value: unknown): value is string | null {
  return value === null || isTimestamp(value);
}

function isCheckRun(value: unknown): value is CheckRun {
  if (typeof value !== "object" || value === null) return false;
  const check = value as Record<string, unknown>;
  const app = check.app as Record<string, unknown> | null;
  const output = check.output as Record<string, unknown> | undefined;
  const pulls = check.pull_requests;
  return (
    typeof check.id === "number" && Number.isFinite(check.id) &&
    typeof check.name === "string" &&
    typeof check.status === "string" &&
    isNullableString(check.conclusion) &&
    typeof check.head_sha === "string" &&
    isNullableTimestamp(check.started_at) &&
    isNullableTimestamp(check.completed_at) &&
    isNullableString(check.details_url) &&
    typeof check.html_url === "string" &&
    (app === null || typeof app?.slug === "string") &&
    typeof output === "object" && output !== null &&
    isNullableString(output.title) && isNullableString(output.summary) &&
    (pulls === undefined || (
      Array.isArray(pulls) && pulls.every((pull) => {
        if (typeof pull !== "object" || pull === null) return false;
        const number = (pull as Record<string, unknown>).number;
        return typeof number === "number" && Number.isFinite(number);
      })
    ))
  );
}

function isObservation(value: unknown): value is ReviewHeadObservation {
  if (!isReviewHead(value)) return false;
  const observation = value as unknown as Record<string, unknown>;
  return (
    typeof observation.current === "boolean" &&
    (observation.prState === "open" || observation.prState === "closed") &&
    isTimestamp(observation.prUpdatedAt) &&
    ["unobserved", "empty", "pending", "terminal"].includes(String(observation.status)) &&
    Array.isArray(observation.checks) && observation.checks.every(isCheckRun) &&
    isNullableTimestamp(observation.checkedAt) &&
    isNullableTimestamp(observation.statusSince)
  );
}

function legacyObservation(head: ReviewHead): ReviewHeadObservation {
  return {
    ...head,
    current: false,
    prState: "closed",
    prUpdatedAt: "1970-01-01T00:00:00.000Z",
    status: "unobserved",
    checks: [],
    checkedAt: null,
    statusSince: null,
  };
}

async function readObservationState(path: string, org: string): Promise<LoadedReviewHeadState> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 2, observations: [] };
    }
    throw new Error(`could not read review-head state ${path}: ${String(error)}`);
  }
  if (typeof value !== "object" || value === null) {
    throw new Error(`review-head state ${path} is invalid for organization ${org}`);
  }
  const state = value as Record<string, unknown>;
  if (state.version === 1 && state.org === org && Array.isArray(state.heads) && state.heads.every(isReviewHead)) {
    return { version: 1, observations: state.heads.map(legacyObservation) };
  }
  if (
    state.version === 2 &&
    state.org === org &&
    Array.isArray(state.observations) &&
    state.observations.every(isObservation)
  ) {
    return { version: 2, observations: state.observations };
  }
  throw new Error(`review-head state ${path} is invalid for organization ${org}`);
}

export async function readReviewHeadState(path: string, org: string): Promise<ReviewHead[]> {
  return (await readObservationState(path, org)).observations.map(
    ({ repo, pr, prUrl, commit }) => ({ repo, pr, prUrl, commit }),
  );
}

async function writeReviewHeadState(
  path: string,
  org: string,
  observations: ReviewHeadObservation[],
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const state: ReviewHeadStateV2 = { version: 2, org, observations };
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function shouldRefreshTimeline(
  pull: PullRequest,
  observations: ReviewHeadObservation[],
  since: string,
  legacy: boolean,
): boolean {
  const matching = observations.find((observation) => observation.commit === pull.head.sha);
  if (!matching) return true;
  if (legacy) return Date.parse(pull.updated_at) >= Date.parse(since);
  const previousCurrent = observations.find((observation) => observation.current);
  return (
    (previousCurrent !== undefined && previousCurrent.commit !== pull.head.sha) ||
    matching.prState !== pull.state
  );
}

export function discoveryOverlapStart(since: string): string {
  return new Date(Date.parse(since) - DISCOVERY_OVERLAP_MS).toISOString();
}

export function shouldContinueClosedPullPages(page: PullRequest[], overlapStart: string): boolean {
  return page.length > 0 && Date.parse(page[page.length - 1]!.updated_at) >= Date.parse(overlapStart);
}

export function shouldInvalidateObservation(
  observation: ReviewHeadObservation | undefined,
  pull: PullRequest,
): boolean {
  return observation !== undefined && observation.prState !== pull.state;
}

export function observationStatus(checks: CheckRun[]): ObservationStatus {
  if (checks.length === 0) return "empty";
  if (checks.some((check) => check.status !== "completed")) return "pending";
  return "terminal";
}

export function shouldPollObservation(
  observation: ReviewHeadObservation,
  nowMs = Date.now(),
): boolean {
  const emptyWithinGrace =
    observation.status === "empty" &&
    observation.checkedAt !== null &&
    nowMs - Date.parse(observation.checkedAt) < TERMINAL_GRACE_MS;
  return (
    // A rerun can add checks to the current SHA after all prior checks complete.
    (observation.current && observation.prState === "open") ||
    observation.status === "unobserved" ||
    observation.status === "pending" ||
    observation.checkedAt === null ||
    emptyWithinGrace
  );
}

export function observationGroupsToPoll(
  observations: ReviewHeadObservation[],
  nowMs = Date.now(),
): ReviewHeadObservation[][] {
  const groups = new Map<string, ReviewHeadObservation[]>();
  for (const observation of observations) {
    const key = `${observation.repo}@${observation.commit}`;
    const group = groups.get(key) ?? [];
    group.push(observation);
    groups.set(key, group);
  }
  return [...groups.values()].filter((group) =>
    group.some((observation) => shouldPollObservation(observation, nowMs))
  );
}

export function pruneObservations(
  observations: ReviewHeadObservation[],
  since: string,
  nowMs = Date.now(),
): ReviewHeadObservation[] {
  const threshold = Date.parse(since);
  return observations.filter((observation) => {
    if (observation.current) return true;
    if (observation.status !== "terminal") {
      const ageSource = observation.checkedAt ?? observation.prUpdatedAt;
      return nowMs - Date.parse(ageSource) < STALE_NONTERMINAL_MS;
    }
    if (observation.checkedAt !== null && nowMs - Date.parse(observation.checkedAt) < TERMINAL_GRACE_MS) return true;
    const completed = observation.checks
      .map((check) => checkTime(check))
      .filter((timestamp): timestamp is number => timestamp !== null);
    return completed.length === 0 || Math.max(...completed) >= threshold;
  });
}

async function discoverReviewHeads(
  org: string,
  loaded: LoadedReviewHeadState,
  since: string,
): Promise<ReviewHeadObservation[]> {
  const repositoryPages = await ghApi<GitHubRepository[]>(
    `orgs/${org}/repos?type=all&per_page=100`,
  );
  const observations = new Map(
    loaded.observations.map((observation) => [reviewHeadKey(observation), { ...observation, current: false }]),
  );
  const previousObservations = loaded.observations;
  const activeRepositories = new Set(
    repositoryPages.flat().filter((repository) => !repository.archived).map((repository) => repository.full_name),
  );
  for (const [key, observation] of observations) {
    if (!activeRepositories.has(observation.repo)) observations.delete(key);
  }
  for (const repository of repositoryPages.flat()) {
    if (repository.archived) continue;
    const openPullPages = await ghApi<PullRequest[]>(
      `repos/${repository.full_name}/pulls?state=open&per_page=100`,
    );
    const overlapStart = discoveryOverlapStart(since);
    const closedPullPages = await ghApi<PullRequest[]>(
      `repos/${repository.full_name}/pulls?state=closed&sort=updated&direction=desc&per_page=100`,
      {},
      (page) => shouldContinueClosedPullPages(page, overlapStart),
    );
    for (const pull of [...openPullPages.flat(), ...closedPullPages.flat()]) {
      const prObservations = previousObservations.filter(
        (observation) => observation.repo === repository.full_name && observation.pr === pull.number,
      );
      const refreshTimeline = shouldRefreshTimeline(
        pull,
        prObservations,
        since,
        loaded.version === 1,
      );
      const existingCurrent = observations.get(
        `${repository.full_name}#${pull.number}@${pull.head.sha}`,
      );
      const currentHead: ReviewHeadObservation = {
        repo: repository.full_name,
        pr: pull.number,
        prUrl: pull.html_url,
        commit: pull.head.sha,
        current: pull.state === "open",
        prState: pull.state,
        prUpdatedAt: pull.updated_at,
        status: "unobserved",
        checks: [],
        checkedAt: null,
        statusSince: null,
        ...existingCurrent,
      };
      currentHead.prUrl = pull.html_url;
      currentHead.current = pull.state === "open";
      currentHead.prState = pull.state;
      currentHead.prUpdatedAt = pull.updated_at;
      if (shouldInvalidateObservation(existingCurrent, pull)) {
        currentHead.status = "unobserved";
        currentHead.checkedAt = null;
      }
      observations.set(reviewHeadKey(currentHead), currentHead);

      if (refreshTimeline) {
        const timelinePages = await ghApi<TimelineEvent[]>(
          `repos/${currentHead.repo}/issues/${currentHead.pr}/timeline?per_page=100`,
        );
        for (const head of reviewHeadsFromTimeline(currentHead, timelinePages.flat(), since)) {
          const key = reviewHeadKey(head);
          if (observations.has(key)) continue;
          observations.set(key, {
            ...head,
            current: false,
            prState: pull.state,
            prUpdatedAt: pull.updated_at,
            status: "unobserved",
            checks: [],
            checkedAt: null,
            statusSince: null,
          });
        }
      }
    }
  }
  return [...observations.values()];
}

export function reviewHeadsFromTimeline(
  head: ReviewHead,
  events: TimelineEvent[],
  since?: string,
): ReviewHead[] {
  return events
    .filter((event) => {
      if (!since || !event.created_at) return true;
      return Date.parse(event.created_at) >= Date.parse(since);
    })
    .flatMap((event) => {
      if (event.event === "committed" && event.sha) return [event.sha];
      if (event.event === "head_ref_force_pushed" && event.commit_id) {
        return [event.commit_id];
      }
      return [];
    })
    .map((commit) => ({ ...head, commit }));
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
  const loaded = await readObservationState(options.stateFile, options.org);
  const observations = await discoverReviewHeads(options.org, loaded, options.since);
  await writeReviewHeadState(options.stateFile, options.org, observations);

  for (const group of observationGroupsToPoll(observations)) {
    const representative = group[0]!;
    const checkPages = await ghApi<CheckRunsPage>(
      `repos/${representative.repo}/commits/${representative.commit}/check-runs?filter=all&per_page=100`,
    );
    const checks = checkPages
      .flatMap((page) => page.check_runs)
      .filter((check) => check.app?.slug === POSTIL_APP_SLUG);
    const status = observationStatus(checks);
    const checkedAt = new Date().toISOString();
    for (const observation of group) {
      const previousStatus = observation.status;
      observation.checks = checks;
      observation.status = status;
      if (observation.checkedAt === null || status !== previousStatus) {
        observation.checkedAt = checkedAt;
      }
    }
  }

  const results = observations.map((observation) =>
    failedRunsForCommit(
      observation.repo,
      observation.pr,
      observation.prUrl,
      observation.commit,
      observation.checks,
      options.since,
      options.until,
    ),
  );
  await writeReviewHeadState(
    options.stateFile,
    options.org,
    pruneObservations(observations, options.since),
  );

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
