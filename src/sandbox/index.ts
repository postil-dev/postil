import { env } from "@/lib/env";
import { DockerSandboxDriver } from "./docker";
import type { SandboxDriver } from "./driver";
import { E2BSandboxDriver } from "./e2b";
import { FlySandboxDriver } from "./fly";

let _driver: SandboxDriver | undefined;

export function getSandboxDriver(): SandboxDriver {
  if (_driver) return _driver;
  switch (env.SANDBOX_DRIVER) {
    case "fly":
      _driver = new FlySandboxDriver();
      break;
    case "e2b":
      _driver = new E2BSandboxDriver();
      break;
    case "docker":
      _driver = new DockerSandboxDriver();
      break;
  }
  return _driver;
}

export type { SandboxDriver, SandboxHandle, SandboxSpawnOptions } from "./driver";
