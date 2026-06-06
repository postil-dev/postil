import { defineConfig } from "@trigger.dev/sdk";

function taskProject(): string {
  const project = (
    process.env.TRIGGER_PROJECT_ID ??
    process.env.TRIGGER_PROJECT_REF ??
    process.env.JOBS_PROJECT_ID
  )?.trim();
  if (project) return project;

  // The deploy workflow validates the real project before invoking Trigger.
  // This placeholder only lets Trigger's managed Docker indexer import the config.
  return "proj_missing_indexer_context";
}

const project = taskProject();

const triggerProjectBuildEnv = {
  name: "trigger-project-build-env",
  onBuildStart(context: {
    addLayer(layer: {
      id: string;
      build: { env: Record<string, string> };
    }): void;
  }) {
    context.addLayer({
      id: "trigger-project-build-env",
      build: {
        env: {
          TRIGGER_PROJECT_ID: project,
        },
      },
    });
  },
};

export default defineConfig({
  project,
  runtime: "bun",
  dirs: ["./src/jobs"],
  build: {
    extensions: [triggerProjectBuildEnv],
  },
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
