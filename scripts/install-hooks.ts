import { existsSync } from "node:fs";
import { execSync } from "node:child_process";

if (!existsSync(".git")) {
  console.log("Not a git repository — skipping hook install");
  process.exit(0);
}

try {
  execSync("git config core.hooksPath .githooks", { stdio: "pipe" });
  console.log("Git hooks path configured to .githooks");
} catch {
  console.warn("Failed to configure git hooks path — skipping");
  process.exit(0);
}
