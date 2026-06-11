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
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
    process.env.NEON_CONNECTION_STRING = "postgres://example.test/db";

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
      });
      expect(syncedEnv).not.toHaveProperty("TRIGGER_SECRET_KEY");
      expect(syncedEnv).not.toHaveProperty("REVIEW_TOKEN_SECRET");
      expect(syncedEnv).not.toHaveProperty("POSTIL_CLI_PATH");
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
    }
  });

  it("does not install the Postil CLI in the Trigger worker image", async () => {
    const { default: config } = await import("../trigger.config");
    const extension = config.build?.extensions?.find(
      (candidate: { name?: string }) => candidate.name === "postil-cli",
    );
    expect(extension).toBeUndefined();
  });
});
