import { afterEach, describe, expect, it, vi } from "vitest";

describe("trigger config", () => {
  afterEach(() => {
    vi.resetModules();
    delete process.env.TRIGGER_DEPLOYMENT_ID;
    delete process.env.TRIGGER_PROJECT_REF;
    delete process.env.JOBS_PROJECT_ID;
  });

  it("uses an indexer placeholder when no task project is configured", async () => {
    const originalProjectId = process.env.TRIGGER_PROJECT_ID;
    delete process.env.TRIGGER_PROJECT_ID;

    try {
      const { default: config } = await import("../trigger.config");
      expect(config.project).toBe("proj_missing_indexer_context");
    } finally {
      if (originalProjectId === undefined) {
        delete process.env.TRIGGER_PROJECT_ID;
      } else {
        process.env.TRIGGER_PROJECT_ID = originalProjectId;
      }
    }
  });

  it("uses an indexer placeholder for a blank task project", async () => {
    const originalProjectId = process.env.TRIGGER_PROJECT_ID;
    process.env.TRIGGER_PROJECT_ID = "   ";

    try {
      const { default: config } = await import("../trigger.config");
      expect(config.project).toBe("proj_missing_indexer_context");
    } finally {
      if (originalProjectId === undefined) {
        delete process.env.TRIGGER_PROJECT_ID;
      } else {
        process.env.TRIGGER_PROJECT_ID = originalProjectId;
      }
    }
  });

  it("uses the configured trigger project id", async () => {
    const originalProjectId = process.env.TRIGGER_PROJECT_ID;
    process.env.TRIGGER_PROJECT_ID = " project_test_123 ";

    try {
      const { default: config } = await import("../trigger.config");
      expect(config.project).toBe("project_test_123");
    } finally {
      if (originalProjectId === undefined) {
        delete process.env.TRIGGER_PROJECT_ID;
      } else {
        process.env.TRIGGER_PROJECT_ID = originalProjectId;
      }
    }
  });

  it("falls back to the task project reference", async () => {
    const originalProjectId = process.env.TRIGGER_PROJECT_ID;
    delete process.env.TRIGGER_PROJECT_ID;
    process.env.TRIGGER_PROJECT_REF = " project_ref_123 ";

    try {
      const { default: config } = await import("../trigger.config");
      expect(config.project).toBe("project_ref_123");
    } finally {
      if (originalProjectId === undefined) {
        delete process.env.TRIGGER_PROJECT_ID;
      } else {
        process.env.TRIGGER_PROJECT_ID = originalProjectId;
      }
    }
  });

  it("allows the deployment indexer to import without project context", async () => {
    const originalProjectId = process.env.TRIGGER_PROJECT_ID;
    delete process.env.TRIGGER_PROJECT_ID;
    process.env.TRIGGER_DEPLOYMENT_ID = "deployment_test_123";

    try {
      const { default: config } = await import("../trigger.config");
      expect(config.project).toBe("proj_missing_indexer_context");
    } finally {
      if (originalProjectId === undefined) {
        delete process.env.TRIGGER_PROJECT_ID;
      } else {
        process.env.TRIGGER_PROJECT_ID = originalProjectId;
      }
    }
  });

  it("syncs required review task runtime secrets", async () => {
    const originalOpenRouterKey = process.env.OPENROUTER_API_KEY;
    const originalDatabaseUrl = process.env.NEON_CONNECTION_STRING;
    const originalTriggerSecret = process.env.TRIGGER_SECRET_KEY;
    const originalReviewTokenSecret = process.env.REVIEW_TOKEN_SECRET;
    const originalPostilCliPath = process.env.POSTIL_CLI_PATH;
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
    process.env.NEON_CONNECTION_STRING = "postgres://example.test/db";
    process.env.TRIGGER_SECRET_KEY = "test-trigger-secret";
    process.env.REVIEW_TOKEN_SECRET = "test-review-token-secret";
    process.env.POSTIL_CLI_PATH = "/home/bun/.cargo/bin/postil";

    try {
      const { default: config } = await import("../trigger.config");
      const layers: Array<{ id: string; deploy?: { env?: Record<string, string> } }> = [];
      const extension = config.build?.extensions?.find(
        (candidate: { name?: string }) => candidate.name === "SyncEnvVarsExtension",
      );

      await extension?.onBuildComplete?.(
        {
          target: "deploy",
          config,
          logger: { spinner: () => ({ message: vi.fn(), stop: vi.fn() }) },
          addLayer: (layer: { id: string; deploy?: { env?: Record<string, string> } }) => {
            layers.push(layer);
          },
        } as never,
        { deploy: { env: {} }, environment: "prod" } as never,
      );

      const syncedEnv = layers.find((layer) => layer.id === "sync-env-vars")?.deploy?.env;
      expect(syncedEnv).toMatchObject({
        OPENROUTER_API_KEY: "test-openrouter-key",
        NEON_CONNECTION_STRING: "postgres://example.test/db",
        REVIEW_TOKEN_SECRET: "test-review-token-secret",
        POSTIL_CLI_PATH: "/home/bun/.cargo/bin/postil",
      });
      expect(syncedEnv).not.toHaveProperty("TRIGGER_SECRET_KEY");
    } finally {
      if (originalOpenRouterKey === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = originalOpenRouterKey;
      }
      if (originalDatabaseUrl === undefined) {
        delete process.env.NEON_CONNECTION_STRING;
      } else {
        process.env.NEON_CONNECTION_STRING = originalDatabaseUrl;
      }
      if (originalTriggerSecret === undefined) {
        delete process.env.TRIGGER_SECRET_KEY;
      } else {
        process.env.TRIGGER_SECRET_KEY = originalTriggerSecret;
      }
      if (originalReviewTokenSecret === undefined) {
        delete process.env.REVIEW_TOKEN_SECRET;
      } else {
        process.env.REVIEW_TOKEN_SECRET = originalReviewTokenSecret;
      }
      if (originalPostilCliPath === undefined) {
        delete process.env.POSTIL_CLI_PATH;
      } else {
        process.env.POSTIL_CLI_PATH = originalPostilCliPath;
      }
    }
  });

  it("syncs the review token secret alias from the deployed Trigger secret fallback", async () => {
    const originalReviewTokenSecret = process.env.REVIEW_TOKEN_SECRET;
    const originalTriggerSecret = process.env.TRIGGER_SECRET_KEY;
    delete process.env.REVIEW_TOKEN_SECRET;
    process.env.TRIGGER_SECRET_KEY = "test-trigger-secret";

    try {
      const { default: config } = await import("../trigger.config");
      const layers: Array<{ id: string; deploy?: { env?: Record<string, string> } }> = [];
      const extension = config.build?.extensions?.find(
        (candidate: { name?: string }) => candidate.name === "SyncEnvVarsExtension",
      );

      await extension?.onBuildComplete?.(
        {
          target: "deploy",
          config,
          logger: { spinner: () => ({ message: vi.fn(), stop: vi.fn() }) },
          addLayer: (layer: { id: string; deploy?: { env?: Record<string, string> } }) => {
            layers.push(layer);
          },
        } as never,
        { deploy: { env: {} }, environment: "prod" } as never,
      );

      const syncedEnv = layers.find((layer) => layer.id === "sync-env-vars")?.deploy?.env;
      expect(syncedEnv).toMatchObject({
        REVIEW_TOKEN_SECRET: "test-trigger-secret",
      });
      expect(syncedEnv).not.toHaveProperty("TRIGGER_SECRET_KEY");
    } finally {
      if (originalReviewTokenSecret === undefined) {
        delete process.env.REVIEW_TOKEN_SECRET;
      } else {
        process.env.REVIEW_TOKEN_SECRET = originalReviewTokenSecret;
      }
      if (originalTriggerSecret === undefined) {
        delete process.env.TRIGGER_SECRET_KEY;
      } else {
        process.env.TRIGGER_SECRET_KEY = originalTriggerSecret;
      }
    }
  });

  it("installs the Postil CLI in the Trigger worker image", async () => {
    const { default: config } = await import("../trigger.config");
    const extension = config.build?.extensions?.find(
      (candidate: { name?: string }) => candidate.name === "postil-cli",
    );

    const layers: Array<{ id: string; image?: { pkgs?: string[] }; commands?: string[] }> = [];
    extension?.onBuildStart?.({
      addLayer: (layer: {
        id: string;
        image?: { pkgs?: string[] };
        commands?: string[];
      }) => {
        layers.push(layer);
      },
    } as never);

    expect(layers).toContainEqual(
      expect.objectContaining({
        id: "postil-cli",
        image: expect.objectContaining({
          pkgs: expect.arrayContaining(["curl", "git"]),
        }),
        commands: expect.arrayContaining([
          "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable",
          "$HOME/.cargo/bin/cargo install --git https://github.com/postil-dev/postil-cli --locked --force",
        ]),
      }),
    );
  });
});
