export const CONFIG_ARTIFACTS = [
  {
    key: "root",
    label: ".postil.yaml",
    repoFiles: [".postil.yaml", ".postil.yml", ".postil.json"],
    orgFile: "org:.postil.yaml",
    sharedFile: "shared:.postil.yaml",
  },
  {
    key: "guardrails",
    label: ".postil/guardrails.md",
    repoFiles: [".postil/guardrails.md"],
    orgFile: "org:.postil/guardrails.md",
    sharedFile: "shared:.postil/guardrails.md",
  },
  {
    key: "content-policy",
    label: ".postil/content-policy.md",
    repoFiles: [".postil/content-policy.md"],
    orgFile: "org:.postil/content-policy.md",
    sharedFile: "shared:.postil/content-policy.md",
  },
] as const;

export type ConfigState = "active" | "pending" | "removed" | "absent" | "unverified";
export type ConfigOrigin = "repository" | "shared" | "organization" | "none";

export interface ConfigProbeSnapshot {
  ok: boolean;
  files: readonly string[];
}

export interface ResolvedConfigArtifact {
  key: (typeof CONFIG_ARTIFACTS)[number]["key"];
  label: string;
  state: ConfigState;
  /** The source on the default branch now. Null when GitHub could not be checked. */
  liveSource: ConfigOrigin | null;
  /** The source consumed by the latest completed review. */
  recordedSource: ConfigOrigin;
  /** The live path, or the last recorded path when the live probe failed. */
  file: string | null;
  /** Repository path from the last successful probe, only when this probe failed. */
  lastKnownLiveFile: string | null;
}

export interface VisibleConfigArtifact extends ResolvedConfigArtifact {
  state: Exclude<ConfigState, "absent">;
}

export function ownerConfigRepositoryFullName(accountLogin: string): string {
  return `${accountLogin}/.github`;
}

export function sharedConfigFilesAvailableToReviews(
  snapshotFiles: readonly string[] | null | undefined,
  enabled: boolean,
  sourceInstalled: boolean,
): string[] {
  if (!enabled || !sourceInstalled) return [];
  return (snapshotFiles ?? []).map((file) => `shared:${file}`);
}

export function isVisibleConfigArtifact(
  artifact: ResolvedConfigArtifact,
): artifact is VisibleConfigArtifact {
  return artifact.state !== "absent";
}

/**
 * Resolve live default-branch configuration against the latest completed
 * review. Organization paths use the same `org:` representation stored on a
 * review so callers can pass them without translating each artifact.
 */
export function resolveConfigArtifacts(
  recordedConfigFiles: readonly string[] | null | undefined,
  liveProbe: ConfigProbeSnapshot,
  liveOrgConfigFiles: readonly string[] = [],
  liveSharedConfigFiles: readonly string[] = [],
): ResolvedConfigArtifact[] {
  const hasCompletedReview = recordedConfigFiles != null;

  return CONFIG_ARTIFACTS.map((artifact) => {
    const recordedRepoFile = artifact.repoFiles.find((file) =>
      recordedConfigFiles?.includes(file),
    );
    const recordedSource: ConfigOrigin = recordedRepoFile
      ? "repository"
      : recordedConfigFiles?.includes(artifact.sharedFile)
        ? "shared"
      : recordedConfigFiles?.includes(artifact.orgFile)
        ? "organization"
        : "none";
    const recordedFile = recordedRepoFile ??
      (recordedSource === "shared"
        ? artifact.sharedFile.slice("shared:".length)
        : recordedSource === "organization"
          ? artifact.orgFile.slice(4)
          : null);

    if (!liveProbe.ok) {
      const lastKnownLiveFile = artifact.repoFiles.find((file) =>
        liveProbe.files.includes(file),
      );
      return {
        key: artifact.key,
        label: artifact.label,
        state: "unverified" as const,
        liveSource: null,
        recordedSource,
        file: recordedFile,
        lastKnownLiveFile: lastKnownLiveFile ?? null,
      };
    }

    const liveRepoFile = artifact.repoFiles.find((file) => liveProbe.files.includes(file));
    const hasLiveSharedFile = liveSharedConfigFiles.includes(artifact.sharedFile);
    const hasLiveOrgFile = liveOrgConfigFiles.includes(artifact.orgFile);
    const liveSource: ConfigOrigin = liveRepoFile
      ? "repository"
      : hasLiveSharedFile
        ? "shared"
        : hasLiveOrgFile
          ? "organization"
          : "none";
    const liveFile = liveRepoFile ??
      (liveSource === "shared"
        ? artifact.sharedFile.slice("shared:".length)
        : liveSource === "organization"
          ? artifact.orgFile.slice(4)
          : null);

    let state: ConfigState;
    if (liveSource === "none") {
      state = recordedSource === "none" ? "absent" : "removed";
    } else if (hasCompletedReview && liveSource === recordedSource) {
      state = "active";
    } else {
      state = "pending";
    }

    return {
      key: artifact.key,
      label: artifact.label,
      state,
      liveSource,
      recordedSource,
      file: liveFile ?? recordedFile,
      lastKnownLiveFile: null,
    };
  });
}
