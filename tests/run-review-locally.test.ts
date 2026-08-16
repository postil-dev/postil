import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import release from "@/data/public-cli-release.json";
import {
  downloadHostedPostilExecutable,
  paginateLocalPullFiles,
  pullFilesFromDiff,
} from "../scripts/run-review-locally";

import "./quiet-console";

test("derives the immutable GitHub file manifest from a local diff", () => {
  expect(
    pullFilesFromDiff(`diff --git a/old.ts b/new.ts
similarity index 90%
rename from old.ts
rename to new.ts
--- a/old.ts
+++ b/new.ts
@@ -1 +1 @@
-old
+new
diff --git a/added.ts b/added.ts
new file mode 100644
--- /dev/null
+++ b/added.ts
@@ -0,0 +1 @@
+added
diff --git a/removed.ts b/removed.ts
deleted file mode 100644
--- a/removed.ts
+++ /dev/null
@@ -1 +0,0 @@
-removed
`),
  ).toEqual([
    {
      filename: "new.ts",
      status: "renamed",
      previous_filename: "old.ts",
      changes: 2,
    },
    { filename: "added.ts", status: "added", changes: 1 },
    { filename: "removed.ts", status: "removed", changes: 1 },
  ]);
});

test("paginates the local GitHub file manifest at the requested page size", () => {
  const pullFiles = Array.from({ length: 205 }, (_, index) => ({
    filename: `file-${index}.ts`,
    status: "modified" as const,
    changes: 1,
  }));

  expect(paginateLocalPullFiles(pullFiles, "100", "1")).toHaveLength(100);
  expect(paginateLocalPullFiles(pullFiles, "100", "2")).toHaveLength(100);
  expect(paginateLocalPullFiles(pullFiles, "100", "3")).toEqual(
    pullFiles.slice(200),
  );
  expect(paginateLocalPullFiles(pullFiles, "100", "4")).toEqual([]);
  expect(paginateLocalPullFiles(pullFiles, null, null)).toEqual(
    pullFiles.slice(0, 30),
  );
  expect(paginateLocalPullFiles(pullFiles, "500", "1")).toEqual(
    pullFiles.slice(0, 100),
  );
  expect(paginateLocalPullFiles(pullFiles, "invalid", "invalid")).toEqual(
    pullFiles.slice(0, 30),
  );
});

test("downloads, verifies, and cleans up the authoritative local-review CLI", async () => {
  const directory = await mkdtemp(join(tmpdir(), "postil-cli-download-test-"));
  const payload = join(directory, "payload");
  const downloads = join(directory, "downloads");
  await mkdir(payload);
  await mkdir(downloads);
  await writeFile(
    join(payload, "postil"),
    `#!/bin/sh\nprintf 'postil ${release.hostedCliRelease.slice(1)}\\n'\n`,
    { mode: 0o755 },
  );
  const archive = join(directory, "postil.tar.gz");
  await run(["tar", "-czf", archive, "-C", payload, "postil"]);
  const archiveBytes = await readFile(archive);
  const checksum = createHash("sha256").update(archiveBytes).digest("hex");
  let status = 200;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return status === 200
        ? new Response(archiveBytes)
        : new Response("unavailable", { status });
    },
  });
  const url = `http://127.0.0.1:${server.port}/postil.tar.gz`;
  try {
    const downloaded = await downloadHostedPostilExecutable({
      url,
      expectedSha256: checksum,
      temporaryRoot: downloads,
      attempts: 1,
    });
    expect(await Bun.file(downloaded.executable).exists()).toBe(true);
    await downloaded.cleanup();
    expect(await readdir(downloads)).toEqual([]);

    await expect(
      downloadHostedPostilExecutable({
        url,
        expectedSha256: "0".repeat(64),
        temporaryRoot: downloads,
        attempts: 1,
      }),
    ).rejects.toThrow("checksum verification");
    expect(await readdir(downloads)).toEqual([]);

    status = 503;
    await expect(
      downloadHostedPostilExecutable({
        url,
        expectedSha256: checksum,
        temporaryRoot: downloads,
        attempts: 1,
      }),
    ).rejects.toThrow(`could not download the pinned hosted CLI`);
    expect(await readdir(downloads)).toEqual([]);
  } finally {
    server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});

const canRunHarness =
  Boolean(process.env.POSTIL_TEST_DATABASE_URL) ||
  (await commandSucceeds(["docker", "--version"])) ||
  (await commandSucceeds(["podman", "--version"]));
const describeHarness = canRunHarness ? describe : describe.skip;

describeHarness("scripts/run-review-locally.ts", () => {
  let dir: string;
  let fakePostil: string;
  let fakeSecrets: string;
  let invocationMarker: string;
  let secretsInvocationMarker: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "postil-local-review-test-"));
    fakePostil = join(dir, "fake-postil");
    await writeFile(fakePostil, fakePostilSource(), { mode: 0o755 });
    await chmod(fakePostil, 0o755);
    fakeSecrets = join(dir, "secrets");
    secretsInvocationMarker = join(dir, "secrets-invocation.json");
    await writeFile(fakeSecrets, `#!/usr/bin/env bun
await Bun.write(${JSON.stringify(join(dir, "secrets-invocation.json"))}, JSON.stringify(process.argv.slice(2)));
console.log("fixture-key");
`, {
      mode: 0o755,
    });
    await chmod(fakeSecrets, 0o755);
    invocationMarker = join(dir, "postil-invocation.json");
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
    expect(result.stdout).toMatch(
      /postil\/gate head=[^\s]+ details=http:\/\/127\.0\.0\.1:\d+\/orgs\/local\/runs\/[0-9a-f-]+/,
    );
    expect(result.stdout).toMatch(
      /#1001 success: Merge gate passed\n\s+details=http:\/\/127\.0\.0\.1:\d+\/orgs\/local\/runs\/[0-9a-f-]+/,
    );
    expect(result.stdout).toContain("Review findings:\n  none");
    expect(result.stdout).not.toContain("https://api.github.com");
    const invocation = JSON.parse(await readFile(invocationMarker, "utf8"));
    expect(invocation).toEqual({
      args: [
        "review",
        "--forge",
        "github",
        "--publish",
        "--defer-gate-check",
        "--repo",
        "local/postil-local",
        "--pr",
        "1",
        "--sha",
        "1".repeat(40),
        "--check-run-id",
        "1000",
        "--gate-check-run-id",
        "1001",
        "--bounded",
        "--output",
        "json",
      ],
      credential: "fixture-key",
      legacyCredentialPresent: true,
      legacyCredential: "fixture-key",
      openRouterCredentialPresent: false,
      apiBase: expect.stringMatching(
        /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f-]{36}$/,
      ),
      apiFormat: "openai-compatible",
      model: "z-ai/glm-5.2",
      cascade: "z-ai/glm-5.2",
      scorerDisabled: "1",
      hostedMode: "0",
      expectedGithubRepoId: "990002",
      endpointAuthPresent: false,
      configApiBaseAllowed: false,
      privateApiBaseAllowed: true,
      planEndpoint: expect.stringMatching(
        /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f-]{36}\/large-review-plan$/,
      ),
      planTokenPresent: true,
    });
  }, 120_000);

  test("accepts an explicit local-review model override", async () => {
    const repo = await createFixtureRepo("model-override");

    await runLocalReview(repo, "0", 0, {
      env: { POSTIL_LOCAL_REVIEW_MODEL: "openai/gpt-5-mini" },
    });

    const invocation = JSON.parse(await readFile(invocationMarker, "utf8"));
    expect(invocation.model).toBe("openai/gpt-5-mini");
    expect(invocation.cascade).toBe("openai/gpt-5-mini");
  }, 120_000);

  test("accepts the repository-approved local review fallback chain", async () => {
    const repo = await createFixtureRepo("approved-model-cascade");

    await runLocalReview(repo, "0", 0, {
      env: {
        REVIEW_MODEL_CASCADE: "z-ai/glm-5.2,moonshotai/kimi-k2.7-code",
      },
    });

    const invocation = JSON.parse(await readFile(invocationMarker, "utf8"));
    expect(invocation.model).toBe("z-ai/glm-5.2");
    expect(invocation.cascade).toBe("moonshotai/kimi-k2.7-code");
  }, 120_000);

  test("rejects an installed CLI older than the hosted release", async () => {
    const repo = await createFixtureRepo("stale-version");
    const stalePostil = join(dir, "stale-postil");
    await writeFile(stalePostil, "#!/bin/sh\nprintf 'postil 0.7.6\\n'\n", {
      mode: 0o755,
    });

    const result = await runLocalReview(repo, "0", 2, {
      env: { POSTIL_BIN: stalePostil },
    });
    expect(result.stderr).toContain(
      `requires ${release.hostedCliRelease}`,
    );
    expect(result.stderr).toContain('reported "postil 0.7.6"');
  }, 120_000);

  test("loads only the local OpenRouter credential when no key is exported", async () => {
    const repo = await createFixtureRepo("credential-fallback");
    const shadowDirectory = join(dir, "shadow-secrets-path");
    const shadowMarker = join(dir, "shadow-secrets-used");
    await mkdir(shadowDirectory, { recursive: true });
    await writeFile(
      join(shadowDirectory, "secrets"),
      `#!/bin/sh\nprintf '%s' "\${MODEL_API_KEY:-missing}" >'${shadowMarker}'\nexit 99\n`,
      { mode: 0o755 },
    );

    const result = await runLocalReview(repo, "0", 0, {
      env: {
        MODEL_API_KEY: "",
        POSTIL_API_KEY: "",
        OPENROUTER_API_KEY: "",
        PATH: `${shadowDirectory}:${process.env.PATH ?? ""}`,
      },
    });

    expect(result.stdout).toContain("Gate: passed");
    expect(JSON.parse(await readFile(secretsInvocationMarker, "utf8"))).toEqual([
      "--profile",
      "morgaesis",
      "get",
      "OPENROUTER_API_KEY",
    ]);
    expect(await Bun.file(shadowMarker).exists()).toBe(false);
    const invocation = JSON.parse(await readFile(invocationMarker, "utf8"));
    expect(invocation).toMatchObject({
      credential: "fixture-key",
      legacyCredentialPresent: true,
      legacyCredential: "fixture-key",
      openRouterCredentialPresent: false,
      apiFormat: "openai-compatible",
    });
    expect(invocation.apiBase).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f-]{36}$/,
    );
  }, 120_000);

  test("ignores a PATH-shadowed Postil binary before any credential is loaded", async () => {
    const shadowDirectory = join(dir, "shadow-path");
    const shadowMarker = join(dir, "shadow-command-key");
    const trustedHome = join(dir, "trusted-home");
    await mkdir(shadowDirectory, { recursive: true });
    await mkdir(join(trustedHome, ".local", "bin"), { recursive: true });
    await symlink(fakePostil, join(trustedHome, ".local", "bin", "postil"));
    await writeFile(
      join(shadowDirectory, "postil"),
      `#!/bin/sh\nprintf '%s' "\${MODEL_API_KEY:-missing}" >'${shadowMarker}'\nexit 99\n`,
      { mode: 0o755 },
    );
    for (const name of ["git", "secrets"]) {
      await writeFile(
        join(shadowDirectory, name),
        `#!/bin/sh\nprintf '%s:%s' '${name}' "\${MODEL_API_KEY:-missing}" >'${shadowMarker}'\nexit 99\n`,
        { mode: 0o755 },
      );
    }

    const result = await runLocalReview(join(dir, "missing-repository"), "0", 2, {
      includePostilBin: false,
      env: {
        HOME: trustedHome,
        OPENROUTER_API_KEY: "must-not-reach-shadow",
        PATH: `${shadowDirectory}:${process.env.PATH ?? ""}`,
      },
    });

    expect(result.stderr).toMatch(/git|Postil (?:binary|v0\.6)/i);
    expect(await Bun.file(shadowMarker).exists()).toBe(false);
  }, 120_000);

  test("clears external-diff and injected Git configuration before loading a key", async () => {
    const repo = await createFixtureRepo("external-diff");
    const marker = join(dir, "external-diff-used");
    const externalDiff = join(dir, "external-diff-command");
    const injectedConfig = join(dir, "external-diff.gitconfig");
    await writeFile(
      externalDiff,
      `#!/bin/sh\nprintf '%s' "\${MODEL_API_KEY:-missing}" >'${marker}'\nexit 99\n`,
      { mode: 0o755 },
    );
    await writeFile(injectedConfig, `[diff]\n\texternal = ${externalDiff}\n`);

    const result = await runLocalReview(repo, "0", 0, {
      env: {
        GIT_EXTERNAL_DIFF: externalDiff,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "diff.external",
        GIT_CONFIG_VALUE_0: externalDiff,
        GIT_CONFIG_GLOBAL: injectedConfig,
        GIT_CONFIG_SYSTEM: injectedConfig,
      },
    });

    expect(result.stdout).toContain("Gate: passed");
    expect(await Bun.file(marker).exists()).toBe(false);
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

  test("require-clean rejects a comment-only finding that passes the merge gate", async () => {
    const repo = await createFixtureRepo("comment-only");

    const result = await runLocalReview(repo, "0", 1, {
      args: ["--require-clean"],
      env: { POSTIL_FAKE_FINDING: "1" },
    });

    expect(result.stdout).toContain("Gate: passed");
    expect(result.stdout).toContain("warn/risk");
    expect(result.stdout).toContain("Local fixture finding");
  }, 120_000);

  test("preserves an operational finding when the local review check fails", async () => {
    const repo = await createFixtureRepo("failed-review-check");

    const result = await runLocalReview(repo, "0", 1, {
      args: ["--require-clean"],
      env: { POSTIL_FAKE_ADVISORY_NEUTRAL: "1" },
    });

    expect(result.stdout).toContain(
      "would complete check-run #1000 as failure",
    );
    expect(result.stdout).toContain("Review findings:");
    expect(result.stdout).toContain(".postil/provider:1");
    expect(result.stdout).toContain("Local provider unavailable");
    expect(result.stdout).toContain("PR reviews posted to local fake GitHub:\n  none");
    expect(result.stdout).toContain("Gate: passed");
  }, 120_000);

  test("persists a model-output sentinel omitted from the GitHub receipt", async () => {
    const repo = await createFixtureRepo("model-output-sentinel");

    const result = await runLocalReview(repo, "1", 1, {
      args: ["--require-clean"],
      env: {
        POSTIL_FAKE_ADVISORY_NEUTRAL: "1",
        POSTIL_FAKE_OPERATIONAL_PATH: ".postil/model-output",
      },
    });

    expect(result.stdout).toContain("would complete check-run #1000 as failure");
    expect(result.stdout).toContain(".postil/model-output:1");
    expect(result.stdout).toContain("PR reviews posted to local fake GitHub:\n  none");
    expect(result.stdout).toContain("Gate: failed");
  }, 120_000);

  test("base mode uses the exact selected head and serves files from its tree", async () => {
    const repo = await createCommittedFixtureRepo("exact-head");
    const base = await runCapture(["git", "rev-parse", "HEAD"], repo);
    await writeFile(join(repo, "app.txt"), "selected-head\n");
    await run(["git", "add", "app.txt"], repo);
    const head = await commitIndex(repo, base);
    await writeFile(join(repo, "app.txt"), "dirty-worktree\n");

    const result = await runLocalReview(repo, "0", 0, {
      args: ["--base", base, "--head", head],
      env: { POSTIL_FAKE_READ_PATH: "app.txt", POSTIL_FAKE_READ_PR_TITLE: "1" },
      includeTarget: false,
    });

    expect(result.stdout).toContain(`head=${head}`);
    expect(result.stdout).toContain("served_content=selected-head");
    expect(result.stdout).toContain("served_pr_title=fixture");
    expect(result.stdout).not.toContain("dirty-worktree");
  }, 120_000);

  test("diff-file mode continues to serve repository context from the working tree", async () => {
    const repo = await createFixtureRepo("diff-file-working-tree");
    await writeFile(join(repo, "app.txt"), "working-tree-context\n");
    await writeFile(join(repo, "change.diff"), "diff --git a/app.txt b/app.txt\n");

    const result = await runLocalReview(repo, "0", 0, {
      args: ["--diff-file", "change.diff"],
      env: { POSTIL_FAKE_READ_PATH: "app.txt" },
      includeTarget: false,
    });

    expect(result.stdout).toContain("served_content=working-tree-context");
  }, 120_000);

  test("serves every pull-request file across bounded GitHub pages", async () => {
    const repo = await createFixtureRepo("pull-file-pagination");
    await Promise.all(
      Array.from({ length: 204 }, (_, index) =>
        writeFile(join(repo, `file-${index.toString().padStart(3, "0")}.txt`), "changed\n"),
      ),
    );
    await run(["git", "add", "."], repo);

    const result = await runLocalReview(repo, "0", 0, {
      env: { POSTIL_FAKE_READ_PR_FILES: "1" },
    });

    expect(result.stdout).toContain("served_pr_files=205");
    expect(result.stdout).toContain("served_pr_file_pages=4");
  }, 120_000);

  test("diff-file mode does not serve a working-tree symlink outside the repository", async () => {
    const repo = await createFixtureRepo("diff-file-outside-symlink");
    const outside = join(dir, "outside-secret.txt");
    await writeFile(outside, "must-not-leave-the-host\n");
    await symlink(outside, join(repo, "outside-link.txt"));
    await writeFile(join(repo, "change.diff"), "diff --git a/app.txt b/app.txt\n");

    const result = await runLocalReview(repo, "0", 0, {
      args: ["--diff-file", "change.diff"],
      env: { POSTIL_FAKE_READ_PATH: "outside-link.txt" },
      includeTarget: false,
    });

    expect(result.stdout).toContain('served_content={"message":"Not Found"}');
    expect(result.stdout).not.toContain("must-not-leave-the-host");
  }, 120_000);

  test("setup failure remains operational exit 2", async () => {
    const repo = await createFixtureRepo("setup-failure");
    const child = Bun.spawn(
      [
        "bun",
        "run",
        "scripts/run-review-locally.ts",
        "--staged",
        "--repo-path",
        repo,
      ],
      {
        cwd: join(import.meta.dir, ".."),
        env: {
          ...process.env,
          OPENROUTER_API_KEY: "fixture-key",
          POSTIL_BIN: join(dir, "missing-postil"),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const stderr = await new Response(child.stderr).text();
    await new Response(child.stdout).text();
    expect(await child.exited).toBe(2);
    expect(stderr).toContain("Postil binary");
  }, 120_000);

  async function createFixtureRepo(name: string): Promise<string> {
    const repo = join(dir, name);
    await run(["git", "init", repo]);
    await writeFile(join(repo, "app.txt"), "stable\nchanged\n");
    await run(["git", "add", "app.txt"], repo);
    return repo;
  }

  async function createCommittedFixtureRepo(name: string): Promise<string> {
    const repo = await createFixtureRepo(name);
    const commit = await commitIndex(repo);
    await run(["git", "update-ref", "refs/heads/main", commit], repo);
    await run(["git", "symbolic-ref", "HEAD", "refs/heads/main"], repo);
    return repo;
  }

  async function commitIndex(repo: string, parent?: string): Promise<string> {
    const tree = await runCapture(["git", "write-tree"], repo);
    const args = ["git", "commit-tree", tree, "-m", "fixture"];
    if (parent) args.push("-p", parent);
    const commit = await runCapture(args, repo, {
      GIT_AUTHOR_NAME: "Postil test",
      GIT_AUTHOR_EMAIL: "postil-test@example.invalid",
      GIT_COMMITTER_NAME: "Postil test",
      GIT_COMMITTER_EMAIL: "postil-test@example.invalid",
    });
    await run(["git", "update-ref", "HEAD", commit], repo);
    return commit;
  }

  async function runLocalReview(
    repo: string,
    gateFailing: "0" | "1",
    expectedExit: number,
    options: {
      args?: string[];
      env?: Record<string, string>;
      includeTarget?: boolean;
      includePostilBin?: boolean;
    } = {},
  ): Promise<{ stdout: string; stderr: string }> {
    await rm(invocationMarker, { force: true });
    await rm(secretsInvocationMarker, { force: true });
    const targetArgs = options.includeTarget === false ? [] : ["--staged"];
    const child = Bun.spawn(
      [
        "bun",
        "run",
        "scripts/run-review-locally.ts",
        ...targetArgs,
        "--repo-path",
        repo,
        "--repo",
        "local/postil-local",
        ...(options.args ?? []),
      ],
      {
        cwd: join(import.meta.dir, ".."),
        env: {
          ...process.env,
          MODEL_API_KEY: "generic-key-must-be-ignored",
          POSTIL_API_KEY: "legacy-key-must-be-ignored",
          OPENROUTER_API_KEY: "fixture-key",
          POSTIL_LOCAL_SECRETS_BIN: fakeSecrets,
          REVIEW_MODEL: "attacker/expensive",
          REVIEW_MODEL_CASCADE: "attacker/fallback",
          REVIEW_SCORER_MODEL: "attacker/scorer",
          POSTIL_ENDPOINT_AUTH_HEADER: "X-Private-Auth",
          POSTIL_ENDPOINT_AUTH_VALUE: "must-not-reach-openrouter",
          POSTIL_ALLOW_CONFIG_API_BASE: "1",
          ...(options.includePostilBin === false ? {} : { POSTIL_BIN: fakePostil }),
          POSTIL_FAKE_INVOCATION_MARKER: invocationMarker,
          POSTIL_FAKE_GATE_FAILING: gateFailing,
          ...options.env,
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
    expect(exitCode, stderr).toBe(expectedExit);
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

async function runCapture(
  command: string[],
  cwd?: string,
  env?: Record<string, string>,
): Promise<string> {
  const child = Bun.spawn(command, {
    cwd,
    env: env ? { ...process.env, ...env } : undefined,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`${command.join(" ")} failed (${exitCode})\n${stderr}`);
  return stdout.trim();
}

async function commandSucceeds(command: string[]): Promise<boolean> {
  const child = Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
  return (await child.exited) === 0;
}

function fakePostilSource(): string {
  return `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--version") {
  console.log("postil ${release.hostedCliRelease.slice(1)}");
  process.exit(0);
}
if (process.env.POSTIL_FAKE_INVOCATION_MARKER) {
  await Bun.write(process.env.POSTIL_FAKE_INVOCATION_MARKER, JSON.stringify({
    args,
    credential: process.env.MODEL_API_KEY,
    legacyCredentialPresent: Boolean(process.env.POSTIL_API_KEY),
    legacyCredential: process.env.POSTIL_API_KEY,
    openRouterCredentialPresent: Boolean(process.env.OPENROUTER_API_KEY),
    apiBase: process.env.POSTIL_API_BASE,
    apiFormat: process.env.POSTIL_API_FORMAT,
    model: process.env.REVIEW_MODEL,
    cascade: process.env.REVIEW_MODEL_CASCADE,
    scorer: process.env.REVIEW_SCORER_MODEL,
    scorerDisabled: process.env.POSTIL_DISABLE_SCORER,
    hostedMode: process.env.POSTIL_HOSTED_MODE,
    expectedGithubRepoId: process.env.POSTIL_EXPECTED_GITHUB_REPO_ID,
    endpointAuthPresent: Boolean(process.env.POSTIL_ENDPOINT_AUTH_HEADER || process.env.POSTIL_ENDPOINT_AUTH_VALUE),
    configApiBaseAllowed: Boolean(process.env.POSTIL_ALLOW_CONFIG_API_BASE),
    privateApiBaseAllowed: process.env.POSTIL_ALLOW_PRIVATE_API_BASE === "1",
    planEndpoint: process.env.POSTIL_LARGE_REVIEW_PLAN_ENDPOINT,
    planTokenPresent: Boolean(process.env.POSTIL_LARGE_REVIEW_PLAN_TOKEN),
  }));
}
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
const operational = process.env.POSTIL_FAKE_ADVISORY_NEUTRAL === "1";
const operationalPath = process.env.POSTIL_FAKE_OPERATIONAL_PATH ?? ".postil/provider";
const hasFinding = failing || operational || process.env.POSTIL_FAKE_FINDING === "1";
let servedContent;
if (process.env.POSTIL_FAKE_READ_PATH) {
  const response = await fetch(\`\${process.env.GITHUB_API_URL}/repos/\${repo}/contents/\${process.env.POSTIL_FAKE_READ_PATH}?ref=\${sha}\`);
  servedContent = (await response.text()).trim();
}
let servedPrTitle;
if (process.env.POSTIL_FAKE_READ_PR_TITLE === "1") {
  const response = await fetch(\`\${process.env.GITHUB_API_URL}/repos/\${repo}/pulls/\${pr}\`);
  servedPrTitle = (await response.json()).title;
}
let servedPrFiles;
let servedPrFilePages;
if (process.env.POSTIL_FAKE_READ_PR_FILES === "1") {
  servedPrFiles = 0;
  servedPrFilePages = 0;
  while (true) {
    servedPrFilePages += 1;
    const response = await fetch(
      \`\${process.env.GITHUB_API_URL}/repos/\${repo}/pulls/\${pr}/files?per_page=100&page=\${servedPrFilePages}\`,
    );
    const files = await response.json();
    if (!Array.isArray(files)) throw new Error("pull-request files response is not an array");
    servedPrFiles += files.length;
    if (files.length === 0) break;
  }
}
const finding = {
  id: "local-finding-1",
  path: operational ? operationalPath : "app.txt",
  line: operational ? 1 : 2,
  severity: failing || operational ? "error" : "warn",
  kind: operational ? "uncertainty" : "risk",
  confidence: 0.9,
  generatorConfidence: 0.95,
  scorerConfidence: 0.9,
  generatorKind: operational ? "uncertainty" : "risk",
  scorerKind: operational ? "uncertainty" : "risk",
  scorerReason: "confirmed by fake scorer",
  title: operational ? "Local provider unavailable" : "Local fixture finding",
  body: operational
    ? "The local fixture simulates an unavailable model provider."
    : "The local fixture intentionally fails the gate."
};
const findings = hasFinding ? [finding] : [];
const observations = [];
if (servedContent !== undefined) observations.push(\`served_content=\${servedContent}\`);
if (servedPrTitle !== undefined) observations.push(\`served_pr_title=\${servedPrTitle}\`);
if (servedPrFiles !== undefined) observations.push(\`served_pr_files=\${servedPrFiles}\`);
if (servedPrFilePages !== undefined) observations.push(\`served_pr_file_pages=\${servedPrFilePages}\`);
const summary = observations.length > 0
  ? observations.join("\\n")
  : (hasFinding ? "Local fixture found an issue." : "Local fixture passed.");
const envelope = {
  version: 1,
  summary,
  silent: !hasFinding,
  findings,
  resolved: [],
  counts: { info: 0, warn: hasFinding && !failing && !operational ? 1 : 0, error: failing || operational ? 1 : 0, suppressed: 0, ungrounded: 0 },
  confidenceBuckets: hasFinding ? [0, 0, 0, 0, 1] : [0, 0, 0, 0, 0],
  gate: { failOn: "error", failing },
  modelUsed: "fake/test",
  scorerModel: hasFinding ? "scorer/test" : undefined,
  scorerDisagreements: hasFinding ? 0 : undefined,
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
      details_url: process.env.POSTIL_DETAILS_URL,
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
await patchCheck(advisory, operational ? "failure" : "success", failing || operational ? "1 error, 0 warn, 0 info" : "No merge-relevant findings", envelope.summary);
await patchCheck(gate, failing ? "failure" : "success", failing ? "Merge gate failed" : "Merge gate passed", envelope.summary);
if (hasFinding && !operational) {
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
