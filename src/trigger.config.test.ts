import { afterEach, describe, expect, it, vi } from "vitest";

describe("trigger config", () => {
  afterEach(() => {
    vi.resetModules();
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
});
