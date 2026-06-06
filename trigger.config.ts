import { defineConfig } from "@trigger.dev/sdk";

const project = (process.env.TRIGGER_PROJECT_ID ?? process.env.TRIGGER_PROJECT_REF)?.trim();

if (!project) {
  throw new Error("TRIGGER_PROJECT_ID or TRIGGER_PROJECT_REF must be set before deploying review tasks");
}

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
