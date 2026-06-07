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
  "REVIEW_TOKEN_SECRET",
];

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
      // Do not synthesize REVIEW_TOKEN_SECRET from TRIGGER_SECRET_KEY here.
      // Trigger strips TRIGGER_* envs from runtime sync, and the two secrets
      // have different purposes: dispatch auth vs installation-token crypto.
      const value = process.env[name]?.trim();
      return value ? [[name, value]] : [];
    }),
  ),
);

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
        pkgs: ["curl", "git", "pkg-config", "libssl-dev"],
      },
      commands: [
        "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable",
        "$HOME/.cargo/bin/cargo install --git https://github.com/postil-dev/postil-cli --locked --force",
      ],
    });
  },
};

export default defineConfig({
  project,
  runtime: "bun",
  dirs: ["./src/jobs"],
  build: {
    extensions: [triggerProjectBuildEnv, taskRuntimeEnv, postilCli],
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
