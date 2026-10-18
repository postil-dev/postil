const OWNER_NAME = /^(?!.*--)[A-Za-z0-9](?:[A-Za-z0-9_-]{0,37}[A-Za-z0-9])?$/;
const REPOSITORY_NAME = /^[A-Za-z0-9._-]{1,100}$/;

export function isValidGitHubRepositoryFullName(
  value: unknown,
): value is string {
  if (typeof value !== "string") return false;
  const [owner, repository, extra] = value.split("/");
  return (
    extra === undefined &&
    owner !== undefined &&
    repository !== undefined &&
    OWNER_NAME.test(owner) &&
    REPOSITORY_NAME.test(repository) &&
    repository !== "." &&
    repository !== ".."
  );
}
