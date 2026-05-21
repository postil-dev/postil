import { describe, expect, it } from "vitest";
import { hashInstallationId } from "./posthog";

describe("hashInstallationId", () => {
  it("preserves the historical sha256 digest prefix", async () => {
    await expect(hashInstallationId(123)).resolves.toBe("035b49e07a4a1db9");
  });
});
