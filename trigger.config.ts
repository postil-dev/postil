import { defineConfig } from "@trigger.dev/sdk";

function triggerProject(): string {
  const project = (process.env.TRIGGER_PROJECT_ID ?? process.env.TRIGGER_PROJECT_REF)?.trim();
  if (project) return project;

  if (process.env.TRIGGER_DEPLOYMENT_ID) {
    return "proj_missing_indexer_context";
  }

  throw new Error("TRIGGER_PROJECT_ID must be set before deploying review tasks");
}

const project = triggerProject();

export default defineConfig({
  project,
  runtime: "bun",
  dirs: ["./src/jobs"],
  logLevel: "info",
  maxDuration: 15 * 60,
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 10000,
      factor: 2,
      randomize: true,
    },
  },
});
