import { defineConfig } from "@trigger.dev/sdk";

function taskProject(): string {
  const project = (
    process.env.TRIGGER_PROJECT_ID ??
    process.env.TRIGGER_PROJECT_REF ??
    process.env.JOBS_PROJECT_ID
  )?.trim();
  if (project) return project;

  if (process.env.TRIGGER_DEPLOYMENT_ID) {
    return "proj_missing_indexer_context";
  }

  throw new Error("TRIGGER_PROJECT_ID must be set before deploying review tasks");
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
