import { afterEach, describe, expect, it, vi } from "vitest";

describe("trigger config", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("falls back to a local project ref when TRIGGER_PROJECT_ID is missing", async () => {
    const originalProjectId = process.env.TRIGGER_PROJECT_ID;
    delete process.env.TRIGGER_PROJECT_ID;

    try {
      const { default: config } = await import("../trigger.config");
      expect(config.project).toBe("local-development");
    } finally {
      if (originalProjectId === undefined) {
        delete process.env.TRIGGER_PROJECT_ID;
      } else {
        process.env.TRIGGER_PROJECT_ID = originalProjectId;
      }
    }
  });
});
