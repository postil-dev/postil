import type { Octokit } from "@octokit/rest";
import { env } from "@/lib/env";
import { appOctokit } from "@/lib/github";
import { captureException, track } from "@/lib/posthog";
import type { PostilConfig } from "@/lib/config";
import type { ReviewPayload } from "./review-types";

type GitHubUser = {
  login?: unknown;
  type?: unknown;
};

const ALLOWED_REVIEW_STATES = new Set(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"]);

function userLogin(user: GitHubUser | null): string {
  return typeof user?.login === "string" ? user.login : "";
}

function normalizeLogin(login: string): string {
  return login.toLowerCase();
}

function isCurrentAppBotUser(user: GitHubUser | null, appBotLogin: string | null): boolean {
  const login = userLogin(user);
  return !!appBotLogin && normalizeLogin(login) === normalizeLogin(appBotLogin);
}

async function fetchCurrentAppBotLogin(): Promise<string | null> {
  const fallbackSlug = String(env.GITHUB_APP_SLUG ?? "").trim();
  try {
    const octokit = appOctokit();
    const appRes = await octokit.request("GET /app");
    const slug = String((appRes.data as { slug?: unknown }).slug ?? "").trim();
    if (slug) return `${slug}[bot]`;
    return fallbackSlug ? `${fallbackSlug}[bot]` : null;
  } catch (err) {
    console.warn(
      "[auto-merge] app identity fetch failed:",
      err instanceof Error ? err.message : err,
    );
    return fallbackSlug ? `${fallbackSlug}[bot]` : null;
  }
}

async function fetchPaginated(
  octokit: Octokit,
  route: string,
  params: Record<string, unknown>,
  options: { maxPages?: number; maxItems?: number } = {},
): Promise<unknown[]> {
  const perPage = 100;
  const maxPages = options.maxPages ?? 5;
  const maxItems = options.maxItems ?? 300;
  const items: unknown[] = [];

  for (let page = 1; page <= maxPages && items.length < maxItems; page++) {
    const res = await octokit.request(route, {
      ...params,
      per_page: perPage,
      page,
    });
    if (!Array.isArray(res.data)) return items;

    const remaining = maxItems - items.length;
    items.push(...res.data.slice(0, remaining));
    if (res.data.length < perPage || items.length >= maxItems) return items;
  }

  return items;
}

export async function hasApprovedReview(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  headSha: string,
): Promise<boolean> {
  const appBotLogin = await fetchCurrentAppBotLogin();
  if (!appBotLogin) return false;

  const reviews = await fetchPaginated(
    octokit,
    "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
    {
      owner,
      repo,
      pull_number: pullNumber,
    },
  );

  let latestApprovedReviewAt = 0;
  let latestState: string | null = null;

  for (const rawReview of reviews) {
    if (!rawReview || typeof rawReview !== "object") continue;
    const state = String((rawReview as { state?: unknown }).state ?? "");
    if (!ALLOWED_REVIEW_STATES.has(state)) continue;
    const reviewCommit = String((rawReview as { commit_id?: unknown }).commit_id ?? "");
    if (reviewCommit !== headSha) continue;
    const authorObj = (rawReview as { user?: GitHubUser | null }).user ?? null;
    if (!isCurrentAppBotUser(authorObj, appBotLogin)) continue;
    const submittedAt = String(
      (rawReview as { submitted_at?: unknown; updated_at?: unknown; created_at?: unknown })
        .submitted_at ??
        (rawReview as { updated_at?: unknown; created_at?: unknown }).updated_at ??
        (rawReview as { created_at?: unknown }).created_at ??
        "",
    );
    const reviewTime = Number.isNaN(Date.parse(submittedAt)) ? 0 : Date.parse(submittedAt);
    if (reviewTime >= latestApprovedReviewAt) {
      latestApprovedReviewAt = reviewTime;
      latestState = state;
    }
  }

  return latestState === "APPROVED";
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function checkCompletedSuccessfully(check: unknown, headSha: string): boolean {
  if (!check || typeof check !== "object") return false;
  const record = check as Record<string, unknown>;
  return (
    record.head_sha === headSha && record.status === "completed" && record.conclusion === "success"
  );
}

function checkRunTime(check: unknown): number {
  if (!check || typeof check !== "object") return 0;
  const record = check as Record<string, unknown>;
  const timestamp = String(record.completed_at ?? record.started_at ?? "");
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function normalizeCheckNames(names: string[]): string[] {
  return [...new Set(names.map((name) => name.trim()).filter(Boolean))];
}

function isReviewVerifierCheck(name: string): boolean {
  return name === "Verify postil/review passed";
}

function pullLabelNames(pull: unknown): string[] {
  const labels = (pull as { labels?: unknown }).labels;
  if (!Array.isArray(labels)) return [];
  return labels.flatMap((label) => {
    if (typeof label === "string") return [label];
    if (!label || typeof label !== "object") return [];
    const name = String((label as { name?: unknown }).name ?? "").trim();
    return name ? [name] : [];
  });
}

export function autoMergeRequiredChecks(
  configuredChecks: string[],
  branchProtectionChecks: string[],
): string[] {
  const sourceChecks = configuredChecks.length ? configuredChecks : branchProtectionChecks;
  return normalizeCheckNames(sourceChecks).filter((name) => !isReviewVerifierCheck(name));
}

async function fetchBranchProtectionRequiredChecks(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
  timeoutMs: number,
): Promise<string[]> {
  try {
    const protection = await withTimeout(
      octokit.request(
        "GET /repos/{owner}/{repo}/branches/{branch}/protection/required_status_checks",
        {
          owner,
          repo,
          branch,
        },
      ),
      timeoutMs,
      "auto-merge branch protection lookup",
    );
    const data = protection.data as { contexts?: unknown; checks?: unknown };
    const names = new Set<string>();
    if (Array.isArray(data.contexts)) {
      for (const context of data.contexts) {
        if (typeof context === "string" && context.trim()) names.add(context.trim());
      }
    }
    if (Array.isArray(data.checks)) {
      for (const check of data.checks) {
        if (!check || typeof check !== "object") continue;
        const name = String((check as { context?: unknown }).context ?? "").trim();
        if (name) names.add(name);
      }
    }
    return [...names];
  } catch (err) {
    if ((err as { status?: number }).status === 404) return [];
    console.warn(
      "[auto-merge] Could not load branch protection required checks:",
      err instanceof Error ? err.message : err,
    );
    captureException(err, { properties: { op: "auto_merge_branch_protection_checks" } });
    return [];
  }
}

async function hasSuccessfulRequiredChecks(
  octokit: Octokit,
  owner: string,
  repo: string,
  headSha: string,
  requiredChecks: string[],
  timeoutMs: number,
): Promise<boolean> {
  if (!requiredChecks.length) return false;
  const checkRuns = await withTimeout(
    octokit.request("GET /repos/{owner}/{repo}/commits/{ref}/check-runs", {
      owner,
      repo,
      ref: headSha,
      per_page: 100,
    }),
    timeoutMs,
    "auto-merge required check lookup",
  );
  const runs = Array.isArray(checkRuns.data.check_runs) ? checkRuns.data.check_runs : [];
  const latestByName = new Map<string, unknown>();

  for (const run of runs) {
    if (!run || typeof run !== "object") continue;
    const name = (run as Record<string, unknown>).name;
    if (typeof name !== "string") continue;
    const current = latestByName.get(name);
    if (!current || checkRunTime(run) >= checkRunTime(current)) latestByName.set(name, run);
  }

  return requiredChecks.every((name) =>
    checkCompletedSuccessfully(latestByName.get(name), headSha),
  );
}

export async function attemptAutoMergeApprovedPull(
  octokit: Octokit,
  owner: string,
  repo: string,
  payload: ReviewPayload,
  reviewConfig: PostilConfig["review"],
) {
  try {
    const timeoutMs = reviewConfig.auto_merge_timeout_ms;
    const pull = await withTimeout(
      octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
        owner,
        repo,
        pull_number: payload.pullNumber,
      }),
      timeoutMs,
      "auto-merge mergeability check",
    );
    const pullHeadSha = String((pull.data as { head?: { sha?: unknown } }).head?.sha ?? "");
    if (pullHeadSha && pullHeadSha !== payload.headSha) return;
    if ((pull.data as { merged?: unknown }).merged === true) return;
    if (pull.data.mergeable === true && pull.data.mergeable_state === "clean") {
      const labelNames = pullLabelNames(pull.data);
      const branchName = String((pull.data as { base?: { ref?: unknown } }).base?.ref ?? "").trim();
      const configuredChecks = normalizeCheckNames(reviewConfig.required_checks ?? []);
      const requiredChecks = configuredChecks.length
        ? configuredChecks
        : await fetchBranchProtectionRequiredChecks(octokit, owner, repo, branchName, timeoutMs);
      const checks = normalizeCheckNames([
        ...autoMergeRequiredChecks(configuredChecks, requiredChecks),
        ...(labelNames.some((label) => label.toLowerCase() === "e2e") ? ["E2E tests"] : []),
      ]).filter((name) => !isReviewVerifierCheck(name));
      if (!checks.length) return;

      const checksPassed = await hasSuccessfulRequiredChecks(
        octokit,
        owner,
        repo,
        payload.headSha,
        checks,
        timeoutMs,
      );
      if (!checksPassed) return;

      await withTimeout(
        octokit.request("PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge", {
          owner,
          repo,
          pull_number: payload.pullNumber,
          merge_method: "squash",
          sha: payload.headSha,
        }),
        timeoutMs,
        "auto-merge request",
      );
      track("system", "auto_merge_completed", {
        repoFullName: payload.repoFullName,
        pullNumber: payload.pullNumber,
      });
    }
  } catch (err) {
    console.warn(
      "[auto-merge] Could not merge clean PR:",
      err instanceof Error ? err.message : err,
    );
    captureException(err, {
      properties: {
        op: "auto_merge_clean_pr",
        repoFullName: payload.repoFullName,
        pullNumber: payload.pullNumber,
      },
    });
  }
}
