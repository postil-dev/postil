import { env } from "@/lib/env";
import type { SandboxDriver, SandboxExecResult, SandboxHandle, SandboxSpawnOptions } from "./driver";

const FLY_API = "https://api.machines.dev/v1";

interface FlyMachine {
  id: string;
  state: string;
  region: string;
  image_ref?: { repository: string; tag: string };
}

async function flyRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!env.FLY_ORG_TOKEN) throw new Error("FLY_ORG_TOKEN is not set");
  const res = await fetch(`${FLY_API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${env.FLY_ORG_TOKEN}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`fly ${init.method ?? "GET"} ${path} -> ${res.status} ${body}`);
  }
  return (await res.json()) as T;
}

function getFlyApp(): string {
  if (!env.FLY_SANDBOX_APP) throw new Error("FLY_SANDBOX_APP is not set");
  return env.FLY_SANDBOX_APP;
}

export class FlySandboxDriver implements SandboxDriver {
  readonly name = "fly" as const;

  async spawn(opts: SandboxSpawnOptions): Promise<SandboxHandle> {
    const app = getFlyApp();
    const config = {
      image: opts.image,
      env: opts.env ?? {},
      init: { cmd: opts.command },
      auto_destroy: true,
      restart: { policy: "no" },
      guest: {
        cpu_kind: opts.cpuKind ?? "shared",
        cpus: opts.cpus ?? 2,
        memory_mb: opts.memoryMb ?? 1024,
      },
    };
    const machine = await flyRequest<FlyMachine>(`/apps/${app}/machines`, {
      method: "POST",
      body: JSON.stringify({ config, region: opts.region ?? "lhr" }),
    });

    return {
      id: machine.id,
      driver: "fly",
      wait: async () => this.wait(machine.id, opts.timeoutMs ?? 10 * 60 * 1000),
      destroy: async () => this.destroy(machine.id),
    };
  }

  private async wait(machineId: string, timeoutMs: number): Promise<SandboxExecResult> {
    const app = getFlyApp();
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const machine = await flyRequest<FlyMachine & { exit_event?: { exit_code?: number } }>(
        `/apps/${app}/machines/${machineId}`,
      );
      if (machine.state === "destroyed" || machine.state === "stopped") {
        return {
          exitCode: machine.exit_event?.exit_code ?? 0,
          stdout: "",
          stderr: "",
          durationMs: Date.now() - start,
        };
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error(`fly machine ${machineId} timed out after ${timeoutMs}ms`);
  }

  async destroy(handleId: string): Promise<void> {
    await flyRequest(`/apps/${getFlyApp()}/machines/${handleId}?force=true`, {
      method: "DELETE",
    });
  }
}
