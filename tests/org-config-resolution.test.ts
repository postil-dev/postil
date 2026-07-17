import { describe, expect, test } from "bun:test";

import {
  isVisibleConfigArtifact,
  ownerConfigRepositoryFullName,
  resolveConfigArtifacts,
  sharedConfigFilesAvailableToReviews,
} from "@/app/orgs/[slug]/config-resolution";

function root(
  recorded: readonly string[] | null | undefined,
  live: { ok: boolean; files: readonly string[] },
  org: readonly string[] = [],
) {
  return resolveConfigArtifacts(recorded, live, org)[0]!;
}

describe("resolveConfigArtifacts", () => {
  test("active: live and recorded origins match", () => {
    expect(root([".postil.json"], { ok: true, files: [".postil.yaml"] })).toMatchObject({
      state: "active",
      liveSource: "repository",
      recordedSource: "repository",
      file: ".postil.yaml",
    });
    expect(
      root(["org:.postil.yaml"], { ok: true, files: [] }, ["org:.postil.yaml"]),
    ).toMatchObject({
      state: "active",
      liveSource: "organization",
      recordedSource: "organization",
    });
  });

  test("pending: live config has not been exercised by a completed review", () => {
    expect(root(undefined, { ok: true, files: [".postil.yml"] })).toMatchObject({
      state: "pending",
      liveSource: "repository",
      recordedSource: "none",
      file: ".postil.yml",
    });
    expect(
      root([".postil.yaml"], { ok: true, files: [] }, ["org:.postil.yaml"]),
    ).toMatchObject({ state: "pending", liveSource: "organization" });
  });

  test("removed: recorded config is no longer live", () => {
    expect(root(["org:.postil.yaml"], { ok: true, files: [] })).toMatchObject({
      state: "removed",
      liveSource: "none",
      recordedSource: "organization",
      file: ".postil.yaml",
    });
  });

  test("absent: neither live state nor completed history has config", () => {
    const artifact = root(undefined, { ok: true, files: [] });
    expect(artifact).toMatchObject({
      state: "absent",
      liveSource: "none",
      recordedSource: "none",
    });
    expect(isVisibleConfigArtifact(artifact)).toBeFalse();
  });

  test("unverified: failed live probe retains the last recorded source", () => {
    expect(root([".postil.json"], { ok: false, files: [".postil.yaml"] })).toMatchObject({
      state: "unverified",
      liveSource: null,
      recordedSource: "repository",
      file: ".postil.json",
      lastKnownLiveFile: ".postil.yaml",
    });
  });

  test("resolves all three artifact slots independently", () => {
    expect(
      resolveConfigArtifacts(
        [".postil.yaml", "org:.postil/guardrails.md"],
        { ok: true, files: [".postil.yaml", ".postil/content-policy.md"] },
        ["org:.postil/guardrails.md"],
      ).map(({ state, liveSource }) => ({ state, liveSource })),
    ).toEqual([
      { state: "active", liveSource: "repository" },
      { state: "active", liveSource: "organization" },
      { state: "pending", liveSource: "repository" },
    ]);
  });

  test("reports a shared owner artifact as the active source", () => {
    expect(
      resolveConfigArtifacts(
        ["shared:.postil.yaml"],
        { ok: true, files: [] },
        ["org:.postil.yaml"],
        ["shared:.postil.yaml"],
      )[0],
    ).toMatchObject({
      state: "active",
      liveSource: "shared",
      recordedSource: "shared",
      file: ".postil.yaml",
    });
  });
});

test("builds the shared repository name from the canonical GitHub account login", () => {
  expect(ownerConfigRepositoryFullName("Acme-Engineering")).toBe(
    "Acme-Engineering/.github",
  );
});

test("excludes a retained snapshot after its source repository is removed", () => {
  const files = [".postil.yaml", ".postil/guardrails.md"];
  expect(sharedConfigFilesAvailableToReviews(files, true, false)).toEqual([]);
  expect(sharedConfigFilesAvailableToReviews(files, false, true)).toEqual([]);
  expect(sharedConfigFilesAvailableToReviews(files, true, true)).toEqual([
    "shared:.postil.yaml",
    "shared:.postil/guardrails.md",
  ]);
});
