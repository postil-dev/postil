import { fetchRepoFile } from "@/lib/github/contents";

const PACKAGE_SCRIPT_PRIORITY = [
  "test",
  "lint",
  "typecheck",
  "type-check",
  "check",
  "format:check",
  "fmt:check",
] as const;
const MAKE_TARGET_PATTERN = /^(test|lint|typecheck|type-check|check|format-check|fmt-check)\s*:/m;
const MAX_COMMANDS = 3;

export interface TrustedReviewFiles {
  packageJson: string | null;
  cargoToml: string | null;
  goMod: string | null;
  makefile: string | null;
}

/**
 * Derive display-only preflight commands from bounded files on the trusted
 * default branch. The reviewer model never supplies or rewrites commands.
 */
export function commandsFromTrustedReviewFiles(files: TrustedReviewFiles): string[] {
  const commands: string[] = [];

  if (files.packageJson) {
    try {
      const value = JSON.parse(files.packageJson) as {
        packageManager?: unknown;
        scripts?: unknown;
      };
      const scripts =
        value.scripts && typeof value.scripts === "object"
          ? (value.scripts as Record<string, unknown>)
          : {};
      const manager = packageManagerCommand(value.packageManager);
      for (const script of PACKAGE_SCRIPT_PRIORITY) {
        if (typeof scripts[script] === "string") commands.push(`${manager} run ${script}`);
      }
    } catch {
      // A malformed manifest supplies no commands. Review execution continues.
    }
  }

  if (files.cargoToml) {
    commands.push("cargo test", "cargo clippy --all-targets -- -D warnings");
  }
  if (files.goMod) commands.push("go test ./...");
  if (files.makefile) {
    for (const line of files.makefile.split(/\r?\n/)) {
      const match = line.match(MAKE_TARGET_PATTERN);
      if (match?.[1]) commands.push(`make ${match[1]}`);
    }
  }

  return [...new Set(commands)].slice(0, MAX_COMMANDS);
}

/** Best-effort discovery. Missing or unreadable files simply yield no command. */
export async function discoverPreventionCommands(
  token: string,
  repoFullName: string,
  signal: AbortSignal = AbortSignal.timeout(5_000),
): Promise<string[]> {
  const paths = ["package.json", "Cargo.toml", "go.mod", "Makefile"] as const;
  const values = await Promise.all(
    paths.map((path) =>
      fetchRepoFile(token, repoFullName, path, signal).catch(() => null),
    ),
  );
  return commandsFromTrustedReviewFiles({
    packageJson: values[0] ?? null,
    cargoToml: values[1] ?? null,
    goMod: values[2] ?? null,
    makefile: values[3] ?? null,
  });
}

function packageManagerCommand(value: unknown): "bun" | "pnpm" | "yarn" | "npm" {
  if (typeof value !== "string") return "npm";
  const name = value.split("@", 1)[0];
  return name === "bun" || name === "pnpm" || name === "yarn" || name === "npm"
    ? name
    : "npm";
}
