import { existsSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";

if (!existsSync(".git")) {
  console.log("Not a git repository — skipping hook install");
  process.exit(0);
}

// Hooks live outside the worktree so agents cannot edit them.
// The real hooks are at ~/.paperclip/hooks/ (owned by the host system).
const hooksDir = process.env.PAPERCLIP_HOOKS_DIR || join(homedir(), ".paperclip", "hooks");

if (!existsSync(hooksDir)) {
  console.warn(`External hooks directory not found at ${hooksDir} — skipping`);
  process.exit(0);
}

try {
  execSync(`git config core.hooksPath "${hooksDir}"`, { stdio: "pipe" });
  console.log(`Git hooks path configured to external directory: ${hooksDir}`);
} catch {
  console.warn("Failed to configure git hooks path — skipping");
  process.exit(0);
}