/** Links from dashboard rows back to GitHub. */

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
