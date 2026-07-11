import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import "./quiet-console";

const canRunHarness =
  Boolean(process.env.POSTIL_TEST_DATABASE_URL) || (await commandSucceeds(["podman", "--version"]));
const describeHarness = canRunHarness ? describe : describe.skip;

describeHarness("scripts/run-review-locally.ts", () => {
  let dir: string;
  let fakePostil: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "postil-local-review-test-"));
    fakePostil = join(dir, "fake-postil");
    await writeFile(fakePostil, fakePostilSource(), { mode: 0o755 });
    await chmod(fakePostil, 0o755);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("reports a passing local hosted review without posting to GitHub", async () => {
    const repo = await createFixtureRepo("passing");

    const result = await runLocalReview(repo, "0", 0);

    expect(result.stdout).toContain("Gate: passed");
    expect(result.stdout).toContain("[local github] would create check-run");
    expect(result.stdout).toContain("[local github] would complete check-run");
    expect(result.stdout).toContain("Review findings:\n  none");
    expect(result.stdout).not.toContain("https://api.github.com");
  }, 120_000);

  test("reports a failing local hosted review with scorer fields", async () => {
    const repo = await createFixtureRepo("failing");

    const result = await runLocalReview(repo, "1", 1);

    expect(result.stdout).toContain("Gate: failed");
    expect(result.stdout).toContain("error/risk");
    expect(result.stdout).toContain("generator=95%");
    expect(result.stdout).toContain("scorer=90%");
    expect(result.stdout).toContain("scorer_kind=risk");
    expect(result.stdout).toContain("Scorer: scorer/test");
  }, 120_000);

  async function createFixtureRepo(name: string): Promise<string> {
    const repo = join(dir, name);
    await run(["git", "init", repo]);
    await writeFile(join(repo, "app.txt"), "stable\nchanged\n");
    await run(["git", "add", "app.txt"], repo);
    return repo;
  }

  async function runLocalReview(
    repo: string,
    gateFailing: "0" | "1",
    expectedExit: number,
  ): Promise<{ stdout: string; stderr: string }> {
    const child = Bun.spawn(
      [
        "bun",
        "run",
        "scripts/run-review-locally.ts",
        "--staged",
        "--repo-path",
        repo,
        "--repo",
        "local/postil-local",
      ],
      {
        cwd: join(import.meta.dir, ".."),
        env: {
          ...process.env,
          POSTIL_BIN: fakePostil,
          POSTIL_FAKE_GATE_FAILING: gateFailing,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(expectedExit);
    return { stdout, stderr };
  }
});

async function run(command: string[], cwd?: string): Promise<void> {
  const child = Bun.spawn(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed (${exitCode})\n${stderr || stdout}`);
  }
}

async function commandSucceeds(command: string[]): Promise<boolean> {
  const child = Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
  return (await child.exited) === 0;
}

function fakePostilSource(): string {
  return `#!/usr/bin/env bun
const args = process.argv.slice(2);
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};
const repo = valueAfter("--repo");
const pr = valueAfter("--pr");
const sha = valueAfter("--sha") ?? "1".repeat(40);
const advisory = valueAfter("--check-run-id");
const gate = valueAfter("--gate-check-run-id");
const failing = process.env.POSTIL_FAKE_GATE_FAILING === "1";
const finding = {
  id: "local-finding-1",
  path: "app.txt",
  line: 2,
  severity: "error",
  kind: "risk",
  confidence: 0.9,
  generatorConfidence: 0.95,
  scorerConfidence: 0.9,
  generatorKind: "risk",
  scorerKind: "risk",
  scorerReason: "confirmed by fake scorer",
  title: "Local fixture finding",
  body: "The local fixture intentionally fails the gate."
};
const findings = failing ? [finding] : [];
const envelope = {
  version: 1,
  summary: failing ? "Local fixture failed." : "Local fixture passed.",
  silent: !failing,
  findings,
  resolved: [],
  counts: { info: 0, warn: 0, error: findings.length, suppressed: 0, ungrounded: 0 },
  confidenceBuckets: failing ? [0, 0, 0, 0, 1] : [0, 0, 0, 0, 0],
  gate: { failOn: "error", failing },
  modelUsed: "fake/test",
  scorerModel: failing ? "scorer/test" : undefined,
  scorerDisagreements: failing ? 0 : undefined,
  usage: { promptTokens: 1, completionTokens: 1 },
  durationMs: 1,
  baseSha: "0".repeat(40),
  headSha: sha,
  sinceSha: null
};
async function patchCheck(id, conclusion, title, summary) {
  if (!id) return;
  await fetch(\`\${process.env.GITHUB_API_URL}/repos/\${repo}/check-runs/\${id}\`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      status: "completed",
      conclusion,
      output: {
        title,
        summary,
        annotations: failing && id === advisory ? [{
          path: "app.txt",
          start_line: 2,
          end_line: 2,
          annotation_level: "failure",
          title: finding.title,
          message: finding.body
        }] : []
      }
    })
  });
}
await patchCheck(advisory, "success", failing ? "1 error, 0 warn, 0 info" : "No merge-relevant findings", envelope.summary);
await patchCheck(gate, failing ? "failure" : "success", failing ? "Merge gate failed" : "Merge gate passed", envelope.summary);
if (failing) {
  await fetch(\`\${process.env.GITHUB_API_URL}/repos/\${repo}/pulls/\${pr}/reviews\`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      commit_id: sha,
      event: "COMMENT",
      body: envelope.summary,
      comments: [{ path: "app.txt", line: 2, side: "RIGHT", body: finding.body }]
    })
  });
}
console.log(JSON.stringify(envelope));
process.exit(failing ? 1 : 0);
`;
}
