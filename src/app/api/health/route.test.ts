import { afterEach, describe, expect, it } from "vitest";
import { GET } from "./route";

describe("health route", () => {
  const originalCommit = process.env.POSTIL_COMMIT_SHA;
  const originalBuildTime = process.env.POSTIL_BUILD_TIME;

  afterEach(() => {
    process.env.POSTIL_COMMIT_SHA = originalCommit;
    process.env.POSTIL_BUILD_TIME = originalBuildTime;
  });

  it("reports the deployed web build identity", async () => {
    process.env.POSTIL_COMMIT_SHA = "test-sha";
    process.env.POSTIL_BUILD_TIME = "2026-06-07T00:00:00Z";

    await expect(GET().json()).resolves.toEqual({
      ok: true,
      service: "postil-web",
      commit: "test-sha",
      buildTime: "2026-06-07T00:00:00Z",
    });
  });
});
