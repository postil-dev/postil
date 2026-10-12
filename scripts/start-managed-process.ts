import { chown, chmod, lstat, mkdir, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";

const commands = {
  web: ["bun", "scripts/start-web.ts"],
  worker: ["bun", "src/worker/index.ts"],
  monitor: ["bun", "src/monitor/index.ts"],
  release: ["bun", "run", "release:prepare"],
} as const;

type ManagedProcess = keyof typeof commands;

export function verifyManagedImageBinding(
  binding: Record<string, string> | null,
  environment: Record<string, string | undefined>,
): void {
  if (!binding) {
    if (environment.POSTIL_MANAGED_RELEASE === "1" || environment.FLY_APP_NAME) {
      throw new Error("managed process requires an image release binding");
    }
    return;
  }
  const managed = binding.POSTIL_MANAGED_RELEASE;
  if (managed !== "0" && managed !== "1") {
    throw new Error("image managed release marker must be 0 or 1");
  }
  if (environment.POSTIL_MANAGED_RELEASE !== managed) {
    throw new Error("runtime managed release marker differs from the image binding");
  }
  if (managed === "0") {
    return;
  }
  for (const name of ["POSTIL_RELEASE_SHA", "POSTIL_COMPATIBLE_SOURCE_RELEASE_SHA"]) {
    if (!/^[0-9a-f]{40}$/.test(binding[name] ?? "")) {
      throw new Error("managed image requires exact lowercase release SHAs");
    }
  }
  if (binding.POSTIL_RELEASE_PROTOCOL !== "additive-publication-hosted-v1") {
    throw new Error("managed image release protocol is incompatible");
  }
  for (const name of ["POSTIL_RELEASE_SHA", "POSTIL_COMPATIBLE_SOURCE_RELEASE_SHA", "POSTIL_RELEASE_PROTOCOL"]) {
    if (binding[name] !== environment[name]) {
      throw new Error("runtime release contract differs from the image binding");
    }
  }
}

async function main(): Promise<void> {
  const processName = process.argv[2] as ManagedProcess | undefined;
  if (!processName || !(processName in commands)) {
    throw new Error("managed process must be web, worker, monitor, or release");
  }
  let binding: Record<string, string> | null = null;
  try {
    binding = JSON.parse(await readFile("/etc/postil-release.json", "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  verifyManagedImageBinding(binding, process.env);
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

if (import.meta.main) await main();
