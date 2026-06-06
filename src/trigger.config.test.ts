import { afterEach, describe, expect, it, vi } from "vitest";

describe("trigger config", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("requires TRIGGER_PROJECT_ID before loading the deploy config", async () => {
    const originalProjectId = process.env.TRIGGER_PROJECT_ID;
    const originalProjectRef = process.env.TRIGGER_PROJECT_REF;
    const originalDeploymentId = process.env.TRIGGER_DEPLOYMENT_ID;
    delete process.env.TRIGGER_PROJECT_ID;
    delete process.env.TRIGGER_PROJECT_REF;
    delete process.env.TRIGGER_DEPLOYMENT_ID;

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
      if (originalProjectRef === undefined) {
        delete process.env.TRIGGER_PROJECT_REF;
      } else {
        process.env.TRIGGER_PROJECT_REF = originalProjectRef;
      }
      if (originalDeploymentId === undefined) {
        delete process.env.TRIGGER_DEPLOYMENT_ID;
      } else {
        process.env.TRIGGER_DEPLOYMENT_ID = originalDeploymentId;
      }
    }
  });

  it("falls back to the Trigger project ref", async () => {
    const originalProjectId = process.env.TRIGGER_PROJECT_ID;
    const originalProjectRef = process.env.TRIGGER_PROJECT_REF;
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
      if (originalProjectRef === undefined) {
        delete process.env.TRIGGER_PROJECT_REF;
      } else {
        process.env.TRIGGER_PROJECT_REF = originalProjectRef;
      }
    }
  });

  it("uses a placeholder only when Trigger imports config during Docker indexing", async () => {
    const originalProjectId = process.env.TRIGGER_PROJECT_ID;
    const originalProjectRef = process.env.TRIGGER_PROJECT_REF;
    const originalDeploymentId = process.env.TRIGGER_DEPLOYMENT_ID;
    delete process.env.TRIGGER_PROJECT_ID;
    delete process.env.TRIGGER_PROJECT_REF;
    process.env.TRIGGER_DEPLOYMENT_ID = "deployment_123";

    try {
      const { default: config } = await import("../trigger.config");
      expect(config.project).toBe("proj_missing_indexer_context");
    } finally {
      if (originalProjectId === undefined) {
        delete process.env.TRIGGER_PROJECT_ID;
      } else {
        process.env.TRIGGER_PROJECT_ID = originalProjectId;
      }
      if (originalProjectRef === undefined) {
        delete process.env.TRIGGER_PROJECT_REF;
      } else {
        process.env.TRIGGER_PROJECT_REF = originalProjectRef;
      }
      if (originalDeploymentId === undefined) {
        delete process.env.TRIGGER_DEPLOYMENT_ID;
      } else {
        process.env.TRIGGER_DEPLOYMENT_ID = originalDeploymentId;
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
});
