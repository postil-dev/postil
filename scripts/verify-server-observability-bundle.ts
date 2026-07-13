const EDGE_ARTIFACT = /(^|\/)(edge|middleware)([^/]*)(\/|$)/i;
const NODE_ONLY_SENTINELS = [
  "POSTHOG_ERROR_CAPTURE",
  "postil_model_incident",
  "PostilOperationalError",
  "postil-operational",
  "job_permanently_failed",
] as const;

const files = Array.from(
  new Bun.Glob("**/*").scanSync({ cwd: ".next/server", onlyFiles: true }),
).filter((path) => EDGE_ARTIFACT.test(path) && /\.(?:js|json|map)$/.test(path));

for (const path of files) {
  const contents = await Bun.file(`.next/server/${path}`).text();
  for (const sentinel of NODE_ONLY_SENTINELS) {
    if (contents.includes(sentinel)) {
      throw new Error(
        `Node-only observability marker ${sentinel} leaked into Edge artifact ${path}`,
      );
    }
  }
}

console.log(`Verified ${files.length} Edge artifacts exclude Node-only observability code.`);

export {};
