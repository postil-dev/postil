import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";

if (!existsSync(".git")) {
  console.log("Not a git repository — skipping hook install");
  process.exit(0);
}

const hooksDir = process.env.POSTIL_HOOKS_DIR || join(homedir(), ".config", "postil", "hooks");

if (!existsSync(hooksDir)) {
  console.warn("External hooks directory not found; skipping hook install");
  process.exit(0);
}

try {
  execSync(`git config core.hooksPath "${hooksDir}"`, { stdio: "pipe" });
  console.log("Git hooks path configured to external directory");
} catch {
  console.warn("Failed to configure git hooks path — skipping");
  process.exit(0);
}
