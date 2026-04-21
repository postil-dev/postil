/**
 * SandboxDriver: interface for executing Postil review work in an isolated
 * machine. Managed Postil uses the Fly driver by default; self-host users
 * can select Docker or E2B.
 */

export interface SandboxSpawnOptions {
  image: string;
  command: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
  cpuKind?: "shared" | "performance";
  cpus?: number;
  memoryMb?: number;
  region?: string;
  // Optional git material to preload
  git?: {
    url: string;
    ref: string;
    token?: string; // short-lived, e.g. installation token
  };
}

export interface SandboxExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface SandboxHandle {
  id: string;
  driver: "fly" | "e2b" | "docker";
  wait(): Promise<SandboxExecResult>;
  destroy(): Promise<void>;
}

export interface SandboxDriver {
  readonly name: "fly" | "e2b" | "docker";
  spawn(opts: SandboxSpawnOptions): Promise<SandboxHandle>;
  destroy(handleId: string): Promise<void>;
}
