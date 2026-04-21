import type { SandboxDriver, SandboxHandle, SandboxSpawnOptions } from "./driver";

// TODO(postil): implement local-docker driver for self-host users without Fly.
// Minimally: docker run --rm -d --cpus --memory <image> <cmd>, wait, capture logs.
export class DockerSandboxDriver implements SandboxDriver {
  readonly name = "docker" as const;

  async spawn(_opts: SandboxSpawnOptions): Promise<SandboxHandle> {
    throw new Error(
      "Docker driver is not implemented yet. For managed Postil use SANDBOX_DRIVER=fly.",
    );
  }

  async destroy(_handleId: string): Promise<void> {
    throw new Error("Docker driver is not implemented yet.");
  }
}
