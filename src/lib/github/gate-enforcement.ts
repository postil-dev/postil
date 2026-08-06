import { apiBase } from "./app-auth";
import { githubResponseError, GithubRateLimitError } from "./rate-limit";

export { GithubRateLimitError } from "./rate-limit";

export const GATE_ENFORCEMENT_CONTEXT = "postil/gate" as const;
const PAGE_SIZE = 100;
const MAX_RULE_PAGES = 100;

export type GateEnforcementStatus = "required" | "not_required" | "unknown";
export type BranchProtectionStatus = "protected" | "unprotected" | "unknown";
export type GateEnforcementSignalMatch =
  | "exact_app"
  | "any_source"
  | "foreign_app"
  | "unknown_identity"
  | "none";

export type ProtectionApiStatus = "ok" | "forbidden" | "not_protected" | "error";

export interface GateEnforcementObservation {
  status: GateEnforcementStatus;
  defaultBranch: string;
  branchProtection: BranchProtectionStatus;
  evidence: {
    expectedContext: typeof GATE_ENFORCEMENT_CONTEXT;
    expectedAppId: number;
    branchProtection: {
      available: boolean;
      requiredStatusChecksPresent: boolean;
      exactMatch: boolean;
      match: GateEnforcementSignalMatch;
    };
    /**
     * The dedicated branch-protection endpoint, which always carries each
     * required check's app binding but needs the App's optional
     * repository-administration read permission. "forbidden" means the
     * installation has not granted it; classic evidence then falls back to
     * the branch summary above.
     */
    protectionApi: {
      status: ProtectionApiStatus;
      exactMatch: boolean;
      match: GateEnforcementSignalMatch;
    };
    activeRules: {
      available: boolean;
      pagesRead: number;
      exactMatch: boolean;
      match: GateEnforcementSignalMatch;
    };
  };
  error: string | null;
}

interface RepositoryMetadata {
  default_branch?: unknown;
}

interface BranchPayload {
  protected?: unknown;
  protection?: {
    required_status_checks?: unknown;
  };
}

interface RequiredStatusCheck {
  context?: unknown;
  integration_id?: unknown;
}

interface BranchStatusCheck {
  context?: unknown;
  app_id?: unknown;
}

interface ActiveRule {
  type?: unknown;
  parameters?: {
    required_status_checks?: unknown;
  };
}

type FetchLike = typeof fetch;

/**
 * Read GitHub's effective default-branch rules with the App's existing
 * metadata permission. Active rulesets expose the required integration id;
 * GitHub's REST OpenAPI schema exposes checks[].app_id for classic branch
 * protection. Missing or malformed source identity remains unknown rather
 * than being guessed from check-run history.
 */
export async function fetchGateEnforcementObservation(
  token: string,
  repoFullName: string,
  expectedAppId: number,
  options: { fetchImpl?: FetchLike; signal?: AbortSignal } = {},
): Promise<GateEnforcementObservation> {
  if (!Number.isInteger(expectedAppId) || expectedAppId <= 0) {
    throw new Error("GitHub App id must be a positive integer");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const signal = options.signal ?? AbortSignal.timeout(20_000);
  const base = apiBase();
  const repositoryPath = encodeRepositoryPath(repoFullName);
  const metadataResponse = await request(
    fetchImpl,
    `${base}/repos/${repositoryPath}`,
    token,
    signal,
  );
  if (!metadataResponse.ok) {
    throw await githubResponseError("repository metadata lookup", metadataResponse);
  }
  const metadata = (await metadataResponse.json()) as RepositoryMetadata;
  if (typeof metadata.default_branch !== "string" || metadata.default_branch.length === 0) {
    throw new Error("GitHub repository metadata omitted the default branch");
  }
  const defaultBranch = metadata.default_branch;
  const branchPath = encodeURIComponent(defaultBranch);

  const branchResponse = await request(
    fetchImpl,
    `${base}/repos/${repositoryPath}/branches/${branchPath}`,
    token,
    signal,
  );
  let protectionAvailable = false;
  let branchProtection: BranchProtectionStatus = "unknown";
  let requiredStatusChecksPresent = false;
  let branchProtectionExactMatch = false;
  let branchProtectionMatch: GateEnforcementSignalMatch = "none";
  let protectionError: string | null = null;
  if (branchResponse.ok) {
    const branchEvidence = parseBranchEvidence(await branchResponse.json(), expectedAppId);
    protectionAvailable = branchEvidence.available;
    branchProtection = branchEvidence.branchProtection;
    requiredStatusChecksPresent = branchEvidence.requiredStatusChecksPresent;
    branchProtectionExactMatch = branchEvidence.exactMatch;
    branchProtectionMatch = branchEvidence.match;
    protectionError = branchEvidence.error;
  } else {
    const error = await githubResponseError("default branch lookup", branchResponse);
    if (error instanceof GithubRateLimitError) throw error;
    protectionError = error.message;
  }

  let protectionApiStatus: ProtectionApiStatus;
  let protectionApiMatch: GateEnforcementSignalMatch = "none";
  let protectionApiExactMatch = false;
  let protectionApiError: string | null = null;
  const protectionResponse = await request(
    fetchImpl,
    `${base}/repos/${repositoryPath}/branches/${branchPath}/protection`,
    token,
    signal,
  );
  if (protectionResponse.ok) {
    const parsedProtection = parseProtectionApi(await protectionResponse.json(), expectedAppId);
    if (parsedProtection.valid) {
      protectionApiStatus = "ok";
      protectionApiMatch = parsedProtection.match;
      protectionApiExactMatch = parsedProtection.exactMatch;
    } else {
      protectionApiStatus = "error";
      protectionApiError = parsedProtection.error;
    }
  } else if (protectionResponse.status === 404) {
    protectionApiStatus = "not_protected";
  } else {
    const error = await githubResponseError("branch protection lookup", protectionResponse);
    if (error instanceof GithubRateLimitError) throw error;
    if (protectionResponse.status === 403) {
      protectionApiStatus = "forbidden";
    } else {
      protectionApiStatus = "error";
      protectionApiError = error.message;
    }
  }

  let activeRulesAvailable = true;
  let activeRulesPagesRead = 0;
  let activeRulesExactMatch = false;
  let activeRulesMatch: GateEnforcementSignalMatch = "none";
  let rulesError: string | null = null;
  for (let page = 1; ; page += 1) {
    if (page > MAX_RULE_PAGES) {
      activeRulesAvailable = false;
      rulesError = "GitHub active branch rules exceeded the pagination limit";
      break;
    }
    const response = await request(
      fetchImpl,
      `${base}/repos/${repositoryPath}/rules/branches/${branchPath}?per_page=${PAGE_SIZE}&page=${page}`,
      token,
      signal,
    );
    if (!response.ok) {
      activeRulesAvailable = false;
      const error = await githubResponseError("active branch rules lookup", response);
      if (error instanceof GithubRateLimitError) throw error;
      rulesError = error.message;
      break;
    }
    const value = await response.json();
    if (!Array.isArray(value)) {
      activeRulesAvailable = false;
      rulesError = "GitHub active branch rules returned an invalid response";
      break;
    }
    activeRulesPagesRead += 1;
    const parsedRules = parseActiveRules(value, expectedAppId);
    if (!parsedRules.valid) {
      activeRulesAvailable = false;
      rulesError = parsedRules.error;
      break;
    }
    activeRulesExactMatch ||= parsedRules.exactMatch;
    activeRulesMatch = mergeSignalMatch(activeRulesMatch, parsedRules.match);
    if (!hasNextPage(response.headers.get("link"))) break;
  }

  // The dedicated protection endpoint is authoritative for classic protection
  // when readable: it names each required check's app binding, and a 404 means
  // no classic protection exists. Only without it does the branch summary's
  // possibly identity-less view stand.
  const classicReadable =
    protectionApiStatus === "ok" || protectionApiStatus === "not_protected";
  const exactMatch =
    protectionApiExactMatch ||
    activeRulesExactMatch ||
    (!classicReadable && branchProtectionExactMatch);
  const identityUnknown =
    (classicReadable
      ? protectionApiMatch === "unknown_identity"
      : branchProtectionMatch === "unknown_identity") ||
    activeRulesMatch === "unknown_identity";
  const allEvidenceAvailable =
    (classicReadable || protectionAvailable) && activeRulesAvailable;
  const error =
    [classicReadable ? null : protectionError, protectionApiError, rulesError]
      .filter(Boolean)
      .join("; ") || null;
  if (branchProtection === "unknown" && protectionApiStatus === "ok") {
    branchProtection = "protected";
  } else if (branchProtection === "unknown" && protectionApiStatus === "not_protected") {
    branchProtection = "unprotected";
  }
  return {
    status: exactMatch
      ? "required"
      : allEvidenceAvailable && !identityUnknown
        ? "not_required"
        : "unknown",
    defaultBranch,
    branchProtection,
    evidence: {
      expectedContext: GATE_ENFORCEMENT_CONTEXT,
      expectedAppId,
      branchProtection: {
        available: protectionAvailable,
        requiredStatusChecksPresent,
        exactMatch: branchProtectionExactMatch,
        match: branchProtectionMatch,
      },
      protectionApi: {
        status: protectionApiStatus,
        exactMatch: protectionApiExactMatch,
        match: protectionApiMatch,
      },
      activeRules: {
        available: activeRulesAvailable,
        pagesRead: activeRulesPagesRead,
        exactMatch: activeRulesExactMatch,
        match: activeRulesMatch,
      },
    },
    error,
  };
}

function parseBranchEvidence(value: unknown, expectedAppId: number): {
  available: boolean;
  branchProtection: BranchProtectionStatus;
  requiredStatusChecksPresent: boolean;
  exactMatch: boolean;
  match: GateEnforcementSignalMatch;
  error: string | null;
} {
  if (!isRecord(value) || typeof value.protected !== "boolean") {
    return invalidBranchEvidence("GitHub default branch returned an invalid protection summary");
  }
  if (!value.protected) {
    return {
      available: true,
      branchProtection: "unprotected",
      requiredStatusChecksPresent: false,
      exactMatch: false,
      match: "none",
      error: null,
    };
  }
  if (!isRecord(value.protection) || !("required_status_checks" in value.protection)) {
    return invalidBranchEvidence("GitHub protected branch omitted its status-check summary");
  }
  const required = value.protection.required_status_checks;
  if (required === null) {
    return {
      available: true,
      branchProtection: "protected",
      requiredStatusChecksPresent: false,
      exactMatch: false,
      match: "none",
      error: null,
    };
  }
  if (!isRecord(required) || !Array.isArray(required.contexts) ||
      !required.contexts.every((context) => typeof context === "string")) {
    return invalidBranchEvidence("GitHub default branch returned invalid required status checks");
  }
  const checks = required.checks;
  if (checks !== undefined && (!Array.isArray(checks) || !checks.every(isBranchStatusCheck))) {
    return invalidBranchEvidence("GitHub default branch returned invalid status-check details");
  }
  const checkContexts = Array.isArray(checks)
    ? checks.map((check) => check.context)
    : [];
  const matchingChecks = Array.isArray(checks)
    ? checks.filter((check) => check.context === GATE_ENFORCEMENT_CONTEXT)
    : [];
  const match = matchingChecks.length > 0
    ? classifySignalMatch(matchingChecks.map((check) => check.app_id), expectedAppId)
    : required.contexts.includes(GATE_ENFORCEMENT_CONTEXT)
      ? "unknown_identity"
      : "none";
  return {
    available: true,
    branchProtection: "protected",
    requiredStatusChecksPresent: required.contexts.length > 0 || checkContexts.length > 0,
    exactMatch: match === "exact_app",
    match,
    error: null,
  };
}

function parseProtectionApi(value: unknown, expectedAppId: number):
  | { valid: true; exactMatch: boolean; match: GateEnforcementSignalMatch }
  | { valid: false; error: string } {
  if (!isRecord(value)) {
    return { valid: false, error: "GitHub branch protection returned an invalid response" };
  }
  const required = value.required_status_checks;
  if (required === undefined || required === null) {
    return { valid: true, exactMatch: false, match: "none" };
  }
  if (!isRecord(required)) {
    return {
      valid: false,
      error: "GitHub branch protection returned invalid required status checks",
    };
  }
  const checks = required.checks;
  if (checks !== undefined && (!Array.isArray(checks) || !checks.every(isBranchStatusCheck))) {
    return {
      valid: false,
      error: "GitHub branch protection returned invalid status-check details",
    };
  }
  const matchingChecks = Array.isArray(checks)
    ? checks.filter((check) => check.context === GATE_ENFORCEMENT_CONTEXT)
    : [];
  if (matchingChecks.length > 0) {
    const match = classifySignalMatch(
      matchingChecks.map((check) => check.app_id),
      expectedAppId,
    );
    return { valid: true, match, exactMatch: match === "exact_app" };
  }
  const contexts = required.contexts;
  const namedByContext =
    Array.isArray(contexts) && contexts.includes(GATE_ENFORCEMENT_CONTEXT);
  return {
    valid: true,
    match: namedByContext ? "unknown_identity" : "none",
    exactMatch: false,
  };
}

function parseActiveRules(value: unknown[], expectedAppId: number):
  | { valid: true; exactMatch: boolean; match: GateEnforcementSignalMatch }
  | { valid: false; error: string } {
  let exactMatch = false;
  let match: GateEnforcementSignalMatch = "none";
  for (const valueRule of value) {
    if (!isRecord(valueRule) || typeof valueRule.type !== "string") {
      return { valid: false, error: "GitHub active branch rules contained an invalid rule" };
    }
    const rule = valueRule as ActiveRule;
    if (rule.type !== "required_status_checks") continue;
    const checks = rule.parameters?.required_status_checks;
    if (!Array.isArray(checks) || !checks.every(isActiveRequiredStatusCheck)) {
      return {
        valid: false,
        error: "GitHub active branch rules returned invalid required status checks",
      };
    }
    const matchingChecks = checks.filter(
      (check: RequiredStatusCheck) => check.context === GATE_ENFORCEMENT_CONTEXT,
    );
    const ruleMatch = classifySignalMatch(
      matchingChecks.map((check: RequiredStatusCheck) => check.integration_id),
      expectedAppId,
    );
    match = mergeSignalMatch(match, ruleMatch);
    exactMatch ||= ruleMatch === "exact_app";
  }
  return { valid: true, exactMatch, match };
}

function classifySignalMatch(
  appIds: unknown[],
  expectedAppId: number,
): GateEnforcementSignalMatch {
  if (appIds.some((value) => value === expectedAppId)) return "exact_app";
  if (appIds.some((value) => value === null || value === -1)) {
    return "any_source";
  }
  if (appIds.some((value) => value === undefined)) return "unknown_identity";
  return appIds.length > 0 ? "foreign_app" : "none";
}

function mergeSignalMatch(
  left: GateEnforcementSignalMatch,
  right: GateEnforcementSignalMatch,
): GateEnforcementSignalMatch {
  const rank: Record<GateEnforcementSignalMatch, number> = {
    none: 0,
    foreign_app: 1,
    unknown_identity: 2,
    any_source: 3,
    exact_app: 4,
  };
  return rank[right] > rank[left] ? right : left;
}

function isActiveRequiredStatusCheck(value: unknown): value is RequiredStatusCheck {
  return isRecord(value) && typeof value.context === "string" &&
    (value.integration_id === undefined || value.integration_id === null ||
      Number.isInteger(value.integration_id));
}

function isBranchStatusCheck(value: unknown): value is BranchStatusCheck {
  return isRecord(value) && typeof value.context === "string" &&
    (value.app_id === undefined || value.app_id === null || Number.isInteger(value.app_id));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidBranchEvidence(error: string): {
  available: false;
  branchProtection: "unknown";
  requiredStatusChecksPresent: false;
  exactMatch: false;
  match: "none";
  error: string;
} {
  return {
    available: false,
    branchProtection: "unknown",
    requiredStatusChecksPresent: false,
    exactMatch: false,
    match: "none",
    error,
  };
}

function request(
  fetchImpl: FetchLike,
  url: string,
  token: string,
  signal: AbortSignal,
): Promise<Response> {
  return fetchImpl(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "postil-control-plane",
    },
    signal,
  });
}

function encodeRepositoryPath(repoFullName: string): string {
  const parts = repoFullName.split("/");
  if (parts.length !== 2 || parts.some((part) => part.length === 0)) {
    throw new Error("repository full name is invalid");
  }
  return parts.map(encodeURIComponent).join("/");
}

function hasNextPage(link: string | null): boolean {
  return link?.split(",").some((entry) => /rel="next"/.test(entry)) ?? false;
}
