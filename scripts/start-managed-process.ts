import { chown, chmod, lstat, mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";

const commands = {
  web: ["bun", "scripts/start-web.ts"],
  worker: ["bun", "src/worker/index.ts"],
  monitor: ["bun", "src/monitor/index.ts"],
  release: ["bun", "run", "release:prepare"],
} as const;

type ManagedProcess = keyof typeof commands;

async function main(): Promise<void> {
  const processName = process.argv[2] as ManagedProcess | undefined;
  if (!processName || !(processName in commands)) {
    throw new Error("managed process must be web, worker, monitor, or release");
  }
  const application = await stat("/app");
  if (processName === "monitor") {
    const statePath = process.env.POSTIL_MONITOR_ALERT_STATE_PATH;
    if (!statePath) {
      throw new Error("POSTIL_MONITOR_ALERT_STATE_PATH is required for the monitor");
    }
    const directory = dirname(statePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("monitor alert state parent must be a regular directory");
    }
    await chown(directory, application.uid, application.gid);
    await chmod(directory, 0o700);
  }
  dropPrivileges(application.uid, application.gid);

  const child = Bun.spawn([...commands[processName]], {
    cwd: "/app",
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
  const exitCode = await child.exited;
  process.exit(exitCode);
}

function dropPrivileges(targetUid: number, targetGid: number): void {
  if (
    typeof process.getuid !== "function" ||
    typeof process.getgid !== "function" ||
    typeof process.getgroups !== "function" ||
    typeof process.setuid !== "function" ||
    typeof process.setgid !== "function" ||
    typeof process.setgroups !== "function"
  ) {
    throw new Error("managed process requires POSIX identity controls");
  }

  if (process.getuid() === 0) {
    process.setgroups([targetGid]);
    process.setgid(targetGid);
    process.setuid(targetUid);
  }

  const actualUid = process.getuid();
  const actualGid = process.getgid();
  const supplementaryGroups = process.getgroups();
  if (
    actualUid !== targetUid ||
    actualGid !== targetGid ||
    actualUid === 0 ||
    actualGid === 0 ||
    supplementaryGroups.includes(0) ||
    supplementaryGroups.some((group) => group !== targetGid)
  ) {
    throw new Error(
      "managed process did not assume the application UID and group set",
    );
  }
}

await main();
