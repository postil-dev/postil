import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

const hasDocker = () => {
  try {
    execSync("docker info", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

describe("Docker build", () => {
  it("builds the production image without errors", { timeout: 300_000 }, () => {
    if (!hasDocker()) {
      console.warn("Docker not available — skipping docker-build regression test");
      return;
    }

    // Build and assert success
    const result = execSync(
      "docker build --no-cache --tag postil-web:test-regression .",
      { stdio: "pipe", encoding: "utf-8" },
    );

    // If we get here, the build succeeded
    expect(result).toBeDefined();

    // Verify the image was created
    const inspect = execSync("docker image inspect postil-web:test-regression", {
      stdio: "pipe",
      encoding: "utf-8",
    });
    const images = JSON.parse(inspect);
    expect(images.length).toBeGreaterThan(0);

    // Cleanup
    execSync("docker rmi postil-web:test-regression --force", {
      stdio: "ignore",
    });
  });
});
