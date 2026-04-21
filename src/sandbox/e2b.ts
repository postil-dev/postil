import type { SandboxDriver, SandboxHandle, SandboxSpawnOptions } from "./driver";

// TODO(postil): implement E2B driver once we add the @e2b/sdk dep.
// Intentionally a stub so self-host users can pick it without code changes.
export class E2BSandboxDriver implements SandboxDriver {
  readonly name = "e2b" as const;

  async spawn(_opts: SandboxSpawnOptions): Promise<SandboxHandle> {
    throw new Error("E2B driver is not implemented yet. Set SANDBOX_DRIVER=fly or docker.");
  }

  async destroy(_handleId: string): Promise<void> {
    throw new Error("E2B driver is not implemented yet.");
  }
}
