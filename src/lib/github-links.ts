/** Links from dashboard rows back to GitHub. */

export function githubPrUrl(repoFullName: string, prNumber: number): string {
  return `https://github.com/${repoFullName}/pull/${prNumber}`;
}

/**
 * Permalink to a file at the reviewed head commit, pinned by sha so the link
 * still shows the reviewed line after the branch moves on.
 */
export function githubFileUrl(
  repoFullName: string,
  sha: string,
  path: string,
  line: number,
): string {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${repoFullName}/blob/${sha}/${encodedPath}#L${line}`;
}
