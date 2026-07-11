import { describe, expect, test } from "bun:test";

import {
  isVisibleConfigArtifact,
  resolveConfigArtifacts,
} from "@/app/orgs/[slug]/config-resolution";

describe("resolveConfigArtifacts", () => {
  test("reports repository root config candidates as the root config source", () => {
    expect(resolveConfigArtifacts([".postil.json"])[0]).toEqual({
      key: "root",
      label: ".postil.yaml",
      source: "repository",
      file: ".postil.json",
    });
  });

  test("resolves each config artifact independently", () => {
    expect(
      resolveConfigArtifacts([
        ".postil.yaml",
        "org:.postil/guardrails.md",
        ".postil/content-policy.md",
      ]),
    ).toEqual([
      {
        key: "root",
        label: ".postil.yaml",
        source: "repository",
        file: ".postil.yaml",
      },
      {
        key: "guardrails",
        label: ".postil/guardrails.md",
        source: "organization",
        file: ".postil/guardrails.md",
      },
      {
        key: "content-policy",
        label: ".postil/content-policy.md",
        source: "repository",
        file: ".postil/content-policy.md",
      },
    ]);
  });

  test("distinguishes no config from unknown review history", () => {
    expect(resolveConfigArtifacts([]).map((artifact) => artifact.source)).toEqual([
      "none",
      "none",
      "none",
    ]);
    expect(resolveConfigArtifacts(null).map((artifact) => artifact.source)).toEqual([
      "unknown",
      "unknown",
      "unknown",
    ]);
  });

  test("hides only resolved empty config artifacts from the settings list", () => {
    expect(resolveConfigArtifacts([]).filter(isVisibleConfigArtifact)).toEqual([]);
    expect(resolveConfigArtifacts(null).filter(isVisibleConfigArtifact)).toHaveLength(3);
    expect(
      resolveConfigArtifacts([".postil.yaml", "org:.postil/content-policy.md"])
        .filter(isVisibleConfigArtifact)
        .map((artifact) => artifact.source),
    ).toEqual(["repository", "organization"]);
  });
});
