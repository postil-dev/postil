/** Links from dashboard rows back to GitHub. */

const VIRTUAL_FINDING_PATHS = new Set([
  ".postil/diff",
  ".postil/model-output",
  ".postil/operational",
  ".postil/pr-description",
  ".postil/provider",
]);

export function githubPrUrl(
  repoFullName: string,
  prNumber: number,
  webBase = "https://github.com",
): string {
  return `${webBase.replace(/\/$/, "")}/${repoFullName}/pull/${prNumber}`;
}

/**
 * Permalink to a file at the reviewed head commit, pinned by sha so the link
 * still shows the reviewed line after the branch moves on. A multi-line
 * finding gets GitHub's range anchor.
 */
export function githubFileUrl(
  repoFullName: string,
  sha: string,
  path: string,
  line: number,
  endLine?: number,
): string {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const anchor = endLine && endLine > line ? `#L${line}-L${endLine}` : `#L${line}`;
  return `https://github.com/${repoFullName}/blob/${sha}/${encodedPath}${anchor}`;
}

/** Virtual review anchors describe review inputs or failures, not repository files. */
export function githubFindingLocationUrl(
  repoFullName: string,
  sha: string,
  path: string,
  line: number,
  endLine?: number,
): string | null {
  if (VIRTUAL_FINDING_PATHS.has(path)) return null;
  return githubFileUrl(repoFullName, sha, path, line, endLine);
}
