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
  if (process.getuid?.() === 0) {
    process.setgid?.(application.gid);
    process.setuid?.(application.uid);
  }
  if (process.getuid?.() === 0) {
    throw new Error("managed process refused to run as root");
  }

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

await main();
