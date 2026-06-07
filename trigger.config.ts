import { defineConfig } from "@trigger.dev/sdk";
import { syncEnvVars } from "@trigger.dev/build/extensions/core";

const TASK_RUNTIME_ENV_VARS = [
  "APP_URL",
  "DATABASE_URL",
  "NEON_CONNECTION_STRING",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_PRIVATE_KEY_B64",
  "GITHUB_APP_SLUG",
  "OPENROUTER_API_KEY",
  "POSTHOG_HOST",
  "POSTHOG_PROJECT_TOKEN",
  "REVIEW_MODEL",
  "REVIEW_MODEL_CASCADE",
  "POSTIL_CLI_PATH",
  "TRIGGER_SECRET_KEY",
];

function triggerSecretKeyEnv(): Record<string, string> {
  const value = process.env.TRIGGER_SECRET_KEY?.trim();
  return value ? { TRIGGER_SECRET_KEY: value } : {};
}

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

const taskRuntimeEnv = syncEnvVars(() =>
  Object.fromEntries(
    TASK_RUNTIME_ENV_VARS.flatMap((name) => {
      if (name === "TRIGGER_SECRET_KEY") return [];
      const value = process.env[name]?.trim();
      return value ? [[name, value]] : [];
    }),
  ),
);

const taskRuntimeTriggerSecret = {
  name: "trigger-secret-runtime-env",
  onBuildComplete(context: {
    addLayer(layer: {
      id: string;
      deploy: { env: Record<string, string> };
    }): void;
  }) {
    context.addLayer({
      id: "trigger-secret-runtime-env",
      deploy: {
        env: triggerSecretKeyEnv(),
      },
    });
  },
};

const postilCli = {
  name: "postil-cli",
  onBuildStart(context: {
    addLayer(layer: {
      id: string;
      image?: { pkgs?: string[] };
      commands?: string[];
    }): void;
  }) {
    context.addLayer({
      id: "postil-cli",
      image: {
        pkgs: ["cargo", "git", "pkg-config", "libssl-dev"],
      },
      commands: ["cargo install --git https://github.com/postil-dev/postil-cli --locked --force"],
    });
  },
};

export default defineConfig({
  project,
  runtime: "bun",
  dirs: ["./src/jobs"],
  build: {
    extensions: [triggerProjectBuildEnv, taskRuntimeEnv, taskRuntimeTriggerSecret, postilCli],
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
