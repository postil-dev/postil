export const CONFIG_ARTIFACTS = [
  {
    key: "root",
    label: ".postil.yaml",
    repoFiles: [".postil.yaml", ".postil.yml", ".postil.json"],
    orgFile: "org:.postil.yaml",
  },
  {
    key: "guardrails",
    label: ".postil/guardrails.md",
    repoFiles: [".postil/guardrails.md"],
    orgFile: "org:.postil/guardrails.md",
  },
  {
    key: "content-policy",
    label: ".postil/content-policy.md",
    repoFiles: [".postil/content-policy.md"],
    orgFile: "org:.postil/content-policy.md",
  },
] as const;

export type ConfigSource = "repository" | "organization" | "none" | "unknown";
export type VisibleConfigSource = Exclude<ConfigSource, "none">;

export interface ResolvedConfigArtifact {
  key: (typeof CONFIG_ARTIFACTS)[number]["key"];
  label: string;
  source: ConfigSource;
  file: string | null;
}

export interface VisibleConfigArtifact extends ResolvedConfigArtifact {
  source: VisibleConfigSource;
}

export function isVisibleConfigArtifact(
  artifact: ResolvedConfigArtifact,
): artifact is VisibleConfigArtifact {
  return artifact.source !== "none";
}

export function resolveConfigArtifacts(
  configFiles: readonly string[] | null | undefined,
): ResolvedConfigArtifact[] {
  return CONFIG_ARTIFACTS.map((artifact) => {
    if (configFiles == null) {
      return {
        key: artifact.key,
        label: artifact.label,
        source: "unknown",
        file: null,
      };
    }

    const repoFile = artifact.repoFiles.find((file) => configFiles.includes(file));
    if (repoFile) {
      return {
        key: artifact.key,
        label: artifact.label,
        source: "repository",
        file: repoFile,
      };
    }

    if (configFiles.includes(artifact.orgFile)) {
      return {
        key: artifact.key,
        label: artifact.label,
        source: "organization",
        file: artifact.orgFile.slice(4),
      };
    }

    return {
      key: artifact.key,
      label: artifact.label,
      source: "none",
      file: null,
    };
  });
}
