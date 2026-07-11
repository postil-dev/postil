import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();

describe("private dataset policy", () => {
  test("architecture documents the private 126-PR dataset policy", async () => {
    const architecture = await readFile(join(root, "ARCHITECTURE.md"), "utf8");

    expect(architecture).toContain("The 126-PR evaluation dataset is private");
    expect(architecture).toContain("Do not add scripts, routes, workflow steps, static files");
    expect(architecture).toContain("Public examples are separate from the private dataset");
  });

  test("private dataset artifacts are ignored", async () => {
    const gitignore = await readFile(join(root, ".gitignore"), "utf8");

    expect(gitignore).toContain("datasets/");
    expect(gitignore).toContain("measurements/");
    expect(gitignore).toContain("private-datasets/");
    expect(gitignore).toContain("private-data/");
    expect(gitignore).toContain("*.private.jsonl");
  });

  test("package scripts do not publish or export datasets", async () => {
    const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };

    for (const [name, command] of Object.entries(packageJson.scripts ?? {})) {
      expect(`${name} ${command}`).not.toMatch(/\b(dataset|datasets)\b.*\b(publish|export|release|upload)\b/i);
      expect(`${name} ${command}`).not.toMatch(/\b(publish|export|release|upload)\b.*\b(dataset|datasets)\b/i);
    }
  });

  test("public evidence examples are explicitly separate from the private dataset", async () => {
    const evidence = await readFile(join(root, "src/data/evidence/index.ts"), "utf8");

    expect(evidence).toContain("Public example data only");
    expect(evidence).toContain("separate from the private 126-PR");
    expect(evidence).toContain("must not import, summarize, or expose that dataset");
  });
});
