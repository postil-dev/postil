import { defineConfig } from "@trigger.dev/sdk";

const project = process.env.TRIGGER_PROJECT_ID?.trim() || "local-development";

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
