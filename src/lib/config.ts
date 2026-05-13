/**
 * Load per-repo review config from the repo tree.
 *
 * Precedence (first hit wins):
 *   1. .postil.yaml / .postil.yml / .postil.json
 *   2. .coderabbit.yaml / .coderabbit.yml
 *   3. .kodo.yaml / .kodo.yml
 *   4. Built-in defaults
 *
 * Only the fields Postil understands are honoured — unknown fields from other
 * tools' schemas are ignored, not errored. This lets a repo keep a single
 * config that serves multiple reviewers.
 */

import { z } from "zod";
import type { Octokit } from "@octokit/rest";

const PostilConfig = z.object({
  enabled: z.boolean().default(true),
  ignore: z.array(z.string()).default([]), // globs
  severityThreshold: z.enum(["info", "warn", "error"]).default("info"),
  maxFindings: z.number().int().positive().default(25),
  reviewer: z
    .object({
      tone: z.enum(["terse", "neutral", "verbose"]).default("neutral"),
      focus: z.array(z.string()).default([]),
    })
    .default({ tone: "neutral", focus: [] }),
});

export type PostilConfig = z.infer<typeof PostilConfig>;

export const defaults: PostilConfig = PostilConfig.parse({});

type CoderabbitConfig = {
  reviews?: {
    profile?: string;
    path_filters?: string[];
    path_instructions?: { path: string; instructions: string }[];
  };
  chat?: { auto_reply?: boolean };
};

type KodoConfig = {
  include?: string[];
  exclude?: string[];
  severity?: "info" | "warn" | "error";
};

const CANDIDATES = [
  { name: ".postil.yaml", format: "yaml", kind: "postil" as const },
  { name: ".postil.yml", format: "yaml", kind: "postil" as const },
  { name: ".postil.json", format: "json", kind: "postil" as const },
  { name: ".coderabbit.yaml", format: "yaml", kind: "coderabbit" as const },
  { name: ".coderabbit.yml", format: "yaml", kind: "coderabbit" as const },
  { name: ".kodo.yaml", format: "yaml", kind: "kodo" as const },
  { name: ".kodo.yml", format: "yaml", kind: "kodo" as const },
];

async function fetchFile(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  path: string,
): Promise<string | undefined> {
  try {
    const res = await octokit.request(
      "GET /repos/{owner}/{repo}/contents/{path}",
      { owner, repo, path, ref, mediaType: { format: "raw" } },
    );
    // With mediaType.format=raw the SDK returns the raw string in data.
    return typeof res.data === "string" ? res.data : undefined;
  } catch (err) {
    if ((err as { status?: number }).status === 404) return undefined;
    throw err;
  }
}

async function parseYaml(text: string): Promise<unknown> {
  // Dynamic import so we don't require yaml as a dep at build time
  // for users who don't ship per-repo configs.
  const mod = (await import("yaml")) as typeof import("yaml");
  return mod.parse(text);
}

function fromCoderabbit(raw: CoderabbitConfig): Partial<PostilConfig> {
  return {
    ignore: raw.reviews?.path_filters?.filter((p) => p.startsWith("!")).map((p) => p.slice(1)) ?? [],
  };
}

function fromKodo(raw: KodoConfig): Partial<PostilConfig> {
  return {
    ignore: raw.exclude ?? [],
    severityThreshold: raw.severity ?? "info",
  };
}

/** Load the best-matching review config for a repo at a ref. */
export async function loadReviewConfig(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
): Promise<{ config: PostilConfig; source: string }> {
  for (const c of CANDIDATES) {
    const text = await fetchFile(octokit, owner, repo, ref, c.name);
    if (!text) continue;
    try {
      const parsed = c.format === "json" ? JSON.parse(text) : await parseYaml(text);
      if (c.kind === "postil") {
        return { config: PostilConfig.parse(parsed), source: c.name };
      }
      if (c.kind === "coderabbit") {
        return {
          config: PostilConfig.parse({ ...defaults, ...fromCoderabbit(parsed as CoderabbitConfig) }),
          source: c.name,
        };
      }
      if (c.kind === "kodo") {
        return {
          config: PostilConfig.parse({ ...defaults, ...fromKodo(parsed as KodoConfig) }),
          source: c.name,
        };
      }
    } catch {
      // Ignore parse/schema failures; try the next candidate.
    }
  }
  return { config: defaults, source: "built-in-defaults" };
}
