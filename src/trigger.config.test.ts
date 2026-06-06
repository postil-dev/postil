import { afterEach, describe, expect, it, vi } from "vitest";

describe("trigger config", () => {
  afterEach(() => {
    vi.resetModules();
    delete process.env.TRIGGER_DEPLOYMENT_ID;
    delete process.env.TRIGGER_PROJECT_REF;
    delete process.env.JOBS_PROJECT_ID;
  });

  it("requires TRIGGER_PROJECT_ID before loading the deploy config", async () => {
    const originalProjectId = process.env.TRIGGER_PROJECT_ID;
    delete process.env.TRIGGER_PROJECT_ID;

    try {
      await expect(import("../trigger.config")).rejects.toThrow(
        "TRIGGER_PROJECT_ID must be set before deploying review tasks",
      );
    } finally {
      if (originalProjectId === undefined) {
        delete process.env.TRIGGER_PROJECT_ID;
      } else {
        process.env.TRIGGER_PROJECT_ID = originalProjectId;
      }
    }
  });

  it("rejects a blank Trigger project id before loading the deploy config", async () => {
    const originalProjectId = process.env.TRIGGER_PROJECT_ID;
    process.env.TRIGGER_PROJECT_ID = "   ";

    try {
      await expect(import("../trigger.config")).rejects.toThrow(
        "TRIGGER_PROJECT_ID must be set before deploying review tasks",
      );
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
});
