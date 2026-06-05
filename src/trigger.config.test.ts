import { afterEach, describe, expect, it, vi } from "vitest";

describe("trigger config", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("loads when the deploy command supplies the project ref override", async () => {
    const originalProjectId = process.env.TRIGGER_PROJECT_ID;
    const originalProjectRef = process.env.TRIGGER_PROJECT_REF;
    delete process.env.TRIGGER_PROJECT_ID;
    delete process.env.TRIGGER_PROJECT_REF;

    try {
      const { default: config } = await import("../trigger.config");
      expect(config.project).toBe("configured-by-trigger-deploy");
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

  it("uses TRIGGER_PROJECT_REF when TRIGGER_PROJECT_ID is blank", async () => {
    const originalProjectId = process.env.TRIGGER_PROJECT_ID;
    const originalProjectRef = process.env.TRIGGER_PROJECT_REF;
    process.env.TRIGGER_PROJECT_ID = "   ";
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
