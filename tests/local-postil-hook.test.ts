import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { installLocalPostilHook } from "../scripts/install-local-postil-hook";

const gitExecutable = Bun.which("git")!;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("trusted local Postil pre-push hook", () => {
  test("installs a rendered hook in the common directory from a linked worktree", async () => {
    const fixture = await createFixture("linked-installer");
    const linked = join(fixture.root, "linked");
    await git(fixture.repository, ["worktree", "add", "-b", "linked", linked]);

    const target = await installHook(fixture, linked);
    expect(target).toBe(join(fixture.repository, ".git", "hooks", "pre-push"));
    const installed = await readFile(target, "utf8");
    expect(installed).toContain(`POSTIL_EXECUTABLE='${fixture.postil}'`);
    expect(installed).not.toContain("__POSTIL_EXECUTABLE__");
    expect((await stat(target)).mode & 0o111).not.toBe(0);

    await writeFile(target, "#!/bin/sh\nexit 9\n", { mode: 0o755 });
    await expect(installHook(fixture, linked)).rejects.toThrow("already exists");
  });

  test("force atomically replaces a symlink entry without modifying its target", async () => {
    const fixture = await createFixture("symlink-force");
    const victim = join(fixture.root, "victim");
    await writeFile(victim, "do not change\n");
    await symlink(victim, fixture.hook);

    await installHook(fixture, fixture.repository, true);

    expect((await lstat(fixture.hook)).isSymbolicLink()).toBe(false);
    expect(await readFile(victim, "utf8")).toBe("do not change\n");
    expect(await readFile(fixture.hook, "utf8")).toContain("postil-local-hook:v1");
  });

  test("an actual linked-worktree push reviews the exact head and immutable base", async () => {
    const fixture = await createFixture("linked-push");
    const linked = join(fixture.root, "linked");
    await git(fixture.repository, ["worktree", "add", "-b", "topic", linked]);
    const topicHead = await commit(linked, "topic", "topic change\n");
    const remoteBase = await gitCapture(fixture.repository, ["rev-parse", "refs/remotes/origin/main"]);
    await installHook(fixture, linked, true);

    const result = await push(fixture, linked, ["origin", "HEAD:refs/heads/topic"], "pass");

    expect(result.exitCode).toBe(0);
    expect(await readRecord(fixture)).toMatchObject({
      base: remoteBase,
      head: topicHead,
      model: "openai/gpt-5-mini",
      cascade: "openai/gpt-5-mini",
      scorer: "",
      scorerDisabled: "1",
      hostedMode: "1",
      apiBase: "https://openrouter.ai/api/v1",
      apiFormat: "openai-compatible",
      modelCredential: "present",
      invocation: `review --base ${remoteBase} --no-post --output json --fail-on info --model openai/gpt-5-mini`,
    });
    expect(await refExists(fixture.remote, "refs/heads/topic")).toBe(true);
  });

  test("rejects a prerelease that can predate the hosted-mode contract", async () => {
    const fixture = await createFixture("prerelease-version");
    await writeFile(
      fixture.postil,
      "#!/bin/sh\nprintf 'postil 0.6.0-alpha.1\\n'\n",
      { mode: 0o755 },
    );

    await expect(installHook(fixture, fixture.repository, true)).rejects.toThrow(
      "requires Postil v0.6.0 or newer",
    );
  });

  test("accepts the v0.6 empty-diff envelope with a null baseSha", async () => {
    const fixture = await createFixture("empty-diff");
    const head = await gitCapture(fixture.repository, ["rev-parse", "HEAD"]);
    await installHook(fixture, fixture.repository, true);

    const result = await push(fixture, fixture.repository, ["origin", "HEAD:refs/heads/empty"], "pass");

    expect(result.exitCode).toBe(0);
    expect((await readRecord(fixture)).head).toBe(head);
    expect(await refExists(fixture.remote, "refs/heads/empty")).toBe(true);
  });

  test("the same SHA pushed to two branches runs two independent reviews", async () => {
    const fixture = await createFixture("two-branches");
    const head = await commit(fixture.repository, "shared", "shared\n");
    await git(fixture.repository, ["branch", "first", head]);
    await git(fixture.repository, ["branch", "second", head]);
    await installHook(fixture, fixture.repository, true, false);

    const result = await push(
      fixture,
      fixture.repository,
      ["origin", "first:refs/heads/first", "second:refs/heads/second"],
      "pass",
      { OPENROUTER_API_KEY: "two-branch-fixture-key" },
    );

    expect(result.exitCode).toBe(0);
    expect((await readRecords(fixture)).length).toBe(2);
  });

  test("a non-checked-out branch is reviewed from its exact detached commit", async () => {
    const fixture = await createFixture("detached-head");
    const selectedHead = await commit(fixture.repository, "selected", "selected\n");
    await git(fixture.repository, ["branch", "exact", selectedHead]);
    await commit(fixture.repository, "later", "later\n");
    await installHook(fixture, fixture.repository, true);

    const result = await push(fixture, fixture.repository, ["origin", "exact:refs/heads/exact"], "pass");

    expect(result.exitCode).toBe(0);
    expect((await readRecord(fixture)).head).toBe(selectedHead);
  });

  test("a failed pull-request base lookup blocks without guessing", async () => {
    const fixture = await createFixture("gh-error");
    await commit(fixture.repository, "topic", "lookup failure\n");
    await installHook(fixture, fixture.repository, true);

    const result = await push(fixture, fixture.repository, ["origin", "HEAD:refs/heads/gh-error"], "gh-error");

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("could not query the pull request base");
    expect(await refExists(fixture.remote, "refs/heads/gh-error")).toBe(false);
  });

  test("hostile PATH, inherited model configuration, and repository config cannot redirect review", async () => {
    const fixture = await createFixture("hostile-environment");
    await writeFile(
      join(fixture.repository, ".postil.yaml"),
      "model:\n  name: attacker/expensive\n  cascade:\n    - attacker/fallback\n  scorer: attacker/scorer\n  apiBase: https://attacker.invalid/v1\n  apiFormat: anthropic\n  consensus: 3\n",
    );
    await git(fixture.repository, ["add", ".postil.yaml"]);
    await commit(fixture.repository, "topic", "hostile config\n");
    await installHook(fixture, fixture.repository, true);
    const shadow = join(fixture.root, "shadow");
    const shadowLog = join(fixture.root, "shadow-used");
    await mkdir(shadow);
    for (const name of ["git", "gh", "jq", "postil"]) {
      await writeFile(join(shadow, name), `#!/bin/sh\necho ${name} >>'${shadowLog}'\nexit 99\n`, { mode: 0o755 });
    }

    const result = await push(
      fixture,
      fixture.repository,
      ["origin", "HEAD:refs/heads/hostile"],
      "pass",
      {
        PATH: `${shadow}:${process.env.PATH ?? ""}`,
        REVIEW_MODEL: "attacker/expensive",
        REVIEW_MODEL_CASCADE: "attacker/fallback",
        REVIEW_SCORER_MODEL: "attacker/scorer",
        POSTIL_API_BASE: "https://attacker.invalid/v1",
        POSTIL_API_FORMAT: "anthropic",
        AWS_SECRET_ACCESS_KEY: "must-not-reach-postil",
      },
    );

    expect(result.exitCode).toBe(0);
    const record = await readRecord(fixture);
    expect(record.model).toBe("openai/gpt-5-mini");
    expect(record.cascade).toBe("openai/gpt-5-mini");
    expect(record.scorer).toBe("");
    expect(record.scorerDisabled).toBe("1");
    expect(record.hostedMode).toBe("1");
    expect(record.apiBase).toBe("https://openrouter.ai/api/v1");
    expect(record.apiFormat).toBe("openai-compatible");
    expect(record.awsCredential).toBe("absent");
    expect(await Bun.file(shadowLog).exists()).toBe(false);
  });

  test("BASH_ENV and ENV cannot execute or observe the isolated OpenRouter credential", async () => {
    const fixture = await createFixture("startup-injection");
    await commit(fixture.repository, "topic", "startup injection\n");
    await installHook(fixture, fixture.repository, true);
    const marker = join(fixture.root, "startup-marker");
    const startup = join(fixture.root, "startup.sh");
    await writeFile(startup, `printf '%s\\n' "\${MODEL_API_KEY:-missing}" >'${marker}'\n`);

    const result = await push(
      fixture,
      fixture.repository,
      ["origin", "HEAD:refs/heads/startup-injection"],
      "pass",
      {
        BASH_ENV: startup,
        ENV: startup,
        OPENROUTER_API_KEY: "isolated-fixture-key",
        MODEL_API_KEY: "generic-key-must-be-ignored",
        POSTIL_API_KEY: "legacy-key-must-be-ignored",
      },
    );

    expect(result.exitCode).toBe(0);
    expect(await Bun.file(marker).exists()).toBe(false);
    const record = await readRecord(fixture);
    expect(record.credentialValue).toBe("isolated-fixture-key");
    expect(record.invocation).not.toContain("isolated-fixture-key");
  });

  test("symlinked review configuration cannot expose an out-of-repository canary", async () => {
    const fixture = await createFixture("config-symlink");
    const canary = join(fixture.root, "external-canary");
    await writeFile(canary, "must-not-reach-provider\n");
    await symlink(canary, join(fixture.repository, ".coderabbit.yml"));
    await git(fixture.repository, ["add", ".coderabbit.yml"]);
    await commit(fixture.repository, "topic", "config symlink\n");
    await installHook(fixture, fixture.repository, true);

    const result = await push(
      fixture,
      fixture.repository,
      ["origin", "HEAD:refs/heads/config-symlink"],
      "pass",
      { OPENROUTER_API_KEY: "fixture-key" },
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("refuses symlinked or non-file config artifact");
    expect(await Bun.file(fixture.log).exists()).toBe(false);
    expect(result.stderr).not.toContain("must-not-reach-provider");
  });

  test("every finding, provider failure, and malformed envelope blocks the update", async () => {
    for (const mode of ["finding", "provider-error", "malformed"] as const) {
      const fixture = await createFixture(mode);
      await commit(fixture.repository, "topic", `${mode}\n`);
      await installHook(fixture, fixture.repository, true);

      const result = await push(fixture, fixture.repository, ["origin", `HEAD:refs/heads/${mode}`], mode);

      expect(result.exitCode).not.toBe(0);
      expect(await refExists(fixture.remote, `refs/heads/${mode}`)).toBe(false);
      if (mode === "finding") expect(result.stderr).toContain("require triage");
      if (mode === "provider-error") expect(result.stderr).toContain("did not complete");
      if (mode === "malformed") expect(result.stderr).toContain("v0.6 envelope contract");
    }
  });

  test("accepts an exact, evidence-based disposition for every reviewed finding", async () => {
    const fixture = await createFixture("accepted-disposition");
    const head = await commit(fixture.repository, "topic", "reviewed finding\n");
    const base = await gitCapture(fixture.repository, ["rev-parse", "refs/remotes/origin/main"]);
    const dispositions = join(fixture.root, "dispositions.json");
    await writeFile(
      dispositions,
      JSON.stringify({
        baseSha: base,
        headSha: head,
        findings: {
          "fixture-finding-id": {
            path: "app.txt",
            line: 1,
            reason:
              "The changed fixture line is intentional and the focused assertion proves the required behavior.",
          },
        },
      }),
    );
    await installHook(fixture, fixture.repository, true);

    const result = await push(
      fixture,
      fixture.repository,
      ["origin", "HEAD:refs/heads/accepted-disposition"],
      "finding",
      { POSTIL_LOCAL_REVIEW_DISPOSITIONS_FILE: dispositions },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('accepted disposition path="app.txt" line=1');
    expect(result.stderr).toContain("focused assertion proves the required behavior");
    expect((await readRecord(fixture)).dispositionsVariable).toBe("absent");
    expect(await refExists(fixture.remote, "refs/heads/accepted-disposition")).toBe(true);
  });

  test("rejects malformed, stale, partial, additional, and mismatched dispositions", async () => {
    const scenarios = [
      "malformed",
      "stale-base",
      "stale-head",
      "partial",
      "additional",
      "mismatched-path",
      "mismatched-line",
      "short-reason",
      "additional-field",
    ] as const;
    for (const scenario of scenarios) {
      const fixture = await createFixture(`invalid-disposition-${scenario}`);
      const head = await commit(fixture.repository, "topic", `${scenario}\n`);
      const base = await gitCapture(fixture.repository, ["rev-parse", "refs/remotes/origin/main"]);
      const dispositions = join(fixture.root, "dispositions.json");
      const reason =
        "The changed fixture line is intentional and the focused assertion proves the required behavior.";
      const document: Record<string, unknown> = {
        baseSha: base,
        headSha: head,
        findings: {
          "fixture-finding-id": { path: "app.txt", line: 1, reason },
        },
      };
      const findingMap = document.findings as Record<string, Record<string, unknown>>;
      const primaryFinding = findingMap["fixture-finding-id"]!;
      if (scenario === "malformed") {
        await writeFile(dispositions, "{\n");
      } else {
        if (scenario === "stale-base") document.baseSha = "0".repeat(40);
        if (scenario === "stale-head") document.headSha = "f".repeat(40);
        if (scenario === "partial") delete findingMap["fixture-second-id"];
        if (scenario === "additional") {
          findingMap["unreviewed-finding-id"] = { path: "app.txt", line: 2, reason };
        }
        if (scenario === "mismatched-path") primaryFinding.path = "other.txt";
        if (scenario === "mismatched-line") primaryFinding.line = 2;
        if (scenario === "short-reason") primaryFinding.reason = "false positive";
        if (scenario === "additional-field") primaryFinding.approved = true;
        await writeFile(dispositions, JSON.stringify(document));
      }
      await installHook(fixture, fixture.repository, true);
      const mode: ReviewMode = scenario === "partial" ? "two-findings" : "finding";

      const result = await push(
        fixture,
        fixture.repository,
        ["origin", `HEAD:refs/heads/invalid-${scenario}`],
        mode,
        { POSTIL_LOCAL_REVIEW_DISPOSITIONS_FILE: dispositions },
      );

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(
        "review dispositions are malformed, stale, incomplete, or do not match",
      );
      expect(await refExists(fixture.remote, `refs/heads/invalid-${scenario}`)).toBe(false);
    }
  }, 30_000);

  test("never dispositions provider, model-output, or truncated-diff findings", async () => {
    const scenarios = [
      ["synthetic-provider", ".postil/provider"],
      ["synthetic-model-output", ".postil/model-output"],
      ["synthetic-diff", ".postil/diff"],
    ] as const;
    for (const [mode, path] of scenarios) {
      const fixture = await createFixture(mode);
      const head = await commit(fixture.repository, "topic", `${mode}\n`);
      const base = await gitCapture(fixture.repository, ["rev-parse", "refs/remotes/origin/main"]);
      const dispositions = join(fixture.root, "dispositions.json");
      await writeFile(
        dispositions,
        JSON.stringify({
          baseSha: base,
          headSha: head,
          findings: {
            "synthetic-finding-id": {
              path,
              line: 1,
              reason:
                "The operator inspected this synthetic result and requests an explicit exception for testing.",
            },
          },
        }),
      );
      await installHook(fixture, fixture.repository, true);

      const result = await push(
        fixture,
        fixture.repository,
        ["origin", `HEAD:refs/heads/${mode}`],
        mode,
        { POSTIL_LOCAL_REVIEW_DISPOSITIONS_FILE: dispositions },
      );

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(
        "provider, setup, and truncated-review findings cannot be dispositioned",
      );
      expect(await refExists(fixture.remote, `refs/heads/${mode}`)).toBe(false);
    }
  });

  test("non-delete tag pushes fail closed unless an explicit base is supplied", async () => {
    const fixture = await createFixture("tag");
    const head = await commit(fixture.repository, "tagged", "tagged\n");
    await git(fixture.repository, ["-c", "tag.gpgSign=false", "tag", "-a", "v-test", "-m", "fixture tag", head]);
    await installHook(fixture, fixture.repository, true);

    const blocked = await push(fixture, fixture.repository, ["origin", "v-test:refs/tags/v-test"], "pass");
    expect(blocked.exitCode).not.toBe(0);
    expect(blocked.stderr).toContain("non-branch push");
    expect(await refExists(fixture.remote, "refs/tags/v-test")).toBe(false);

    const reviewed = await push(
      fixture,
      fixture.repository,
      ["origin", "v-test:refs/tags/v-test"],
      "pass",
      { POSTIL_LOCAL_REVIEW_BASE: "main" },
    );
    expect(reviewed.exitCode).toBe(0);
    expect((await readRecord(fixture)).head).toBe(head);
  }, 30_000);

  test("branch deletion skips Postil", async () => {
    const fixture = await createFixture("delete");
    await commit(fixture.repository, "remote-topic", "remote topic\n");
    await git(fixture.repository, ["-c", "core.hooksPath=/dev/null", "push", "origin", "HEAD:refs/heads/topic"]);
    await installHook(fixture, fixture.repository, true);

    const result = await push(fixture, fixture.repository, ["origin", ":refs/heads/topic"], "provider-error");
    expect(result.exitCode).toBe(0);
    expect(await refExists(fixture.remote, "refs/heads/topic")).toBe(false);
    expect(await Bun.file(fixture.log).exists()).toBe(false);
  });

  test("loads only OPENROUTER_API_KEY through the noninteractive secrets profile", async () => {
    const fixture = await createFixture("secrets");
    await commit(fixture.repository, "topic", "secrets\n");
    await installHook(fixture, fixture.repository, true);

    const result = await push(
      fixture,
      fixture.repository,
      ["origin", "HEAD:refs/heads/secrets"],
      "pass",
      {
        MODEL_API_KEY: "",
        POSTIL_API_KEY: "",
        OPENROUTER_API_KEY: "",
        HOME: join(fixture.root, "hostile-home"),
        PATH: `${join(fixture.root, "shadow")}:${process.env.PATH ?? ""}`,
      },
    );

    expect(result.exitCode).toBe(0);
    expect((await readRecord(fixture)).modelCredential).toBe("present");
    const secretsRecord = await readFile(fixture.secretsLog, "utf8");
    expect(secretsRecord).toContain("--profile morgaesis get OPENROUTER_API_KEY\n");
    expect(secretsRecord).not.toContain(join(fixture.root, "hostile-home"));
    expect(secretsRecord).not.toContain(join(fixture.root, "shadow"));
  });
});

type ReviewMode =
  | "pass"
  | "finding"
  | "two-findings"
  | "synthetic-provider"
  | "synthetic-model-output"
  | "synthetic-diff"
  | "provider-error"
  | "malformed"
  | "gh-error";

interface Fixture {
  root: string;
  repository: string;
  remote: string;
  bin: string;
  log: string;
  modeFile: string;
  postil: string;
  gh: string;
  secrets: string;
  secretsLog: string;
  hook: string;
}

async function createFixture(name: string): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), `postil-hook-${name}-`));
  temporaryDirectories.push(root);
  const repository = join(root, "repository");
  const remote = join(root, "remote.git");
  const bin = join(root, "bin");
  const log = join(root, "review.jsonl");
  const modeFile = join(root, "mode");
  const secretsLog = join(root, "secrets.log");
  await mkdir(bin);
  await git(root, ["init", "--bare", remote]);
  await git(root, ["init", "-b", "main", repository]);
  await git(repository, ["config", "user.name", "Hook Test"]);
  await git(repository, ["config", "user.email", "hook-test@example.invalid"]);
  await git(repository, ["config", "commit.gpgSign", "false"]);
  await git(repository, ["config", "core.hooksPath", join(repository, ".git", "hooks")]);
  await writeFile(join(repository, "app.txt"), "base\n");
  await git(repository, ["add", "app.txt"]);
  await git(repository, ["-c", "core.hooksPath=/dev/null", "commit", "-m", "base"]);
  await git(repository, ["remote", "add", "origin", remote]);
  await git(repository, ["-c", "core.hooksPath=/dev/null", "push", "-u", "origin", "main"]);
  await git(root, ["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
  const commands = await writeFakeCommands(bin, { log, modeFile, secretsLog });
  return {
    root,
    repository,
    remote,
    bin,
    log,
    modeFile,
    secretsLog,
    ...commands,
    hook: join(repository, ".git", "hooks", "pre-push"),
  };
}

async function installHook(
  fixture: Fixture,
  repository: string,
  force = false,
  includeSecrets = true,
): Promise<string> {
  return installLocalPostilHook(repository, {
    force,
    postilExecutable: fixture.postil,
    ghExecutable: fixture.gh,
    secretsExecutable: includeSecrets ? fixture.secrets : "",
  });
}

async function commit(repository: string, message: string, contents: string): Promise<string> {
  await writeFile(join(repository, "app.txt"), contents);
  await git(repository, ["add", "app.txt"]);
  await git(repository, ["-c", "core.hooksPath=/dev/null", "commit", "-m", message]);
  return gitCapture(repository, ["rev-parse", "HEAD"]);
}

async function push(
  fixture: Fixture,
  repository: string,
  args: string[],
  mode: ReviewMode,
  environment: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  await writeFile(fixture.modeFile, `${mode}\n`);
  const child = Bun.spawn(
    [gitExecutable, "-c", `core.hooksPath=${dirname(fixture.hook)}`, "push", ...args],
    {
      cwd: repository,
      env: {
        ...process.env,
        MODEL_API_KEY: "fixture-key",
        ...environment,
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
  return { exitCode, stdout, stderr };
}

async function writeFakeCommands(
  bin: string,
  paths: { log: string; modeFile: string; secretsLog: string },
): Promise<{ postil: string; gh: string; secrets: string }> {
  const postil = join(bin, "postil");
  await writeFile(
    postil,
    `#!/bin/bash
if [[ "\${1:-}" == "--version" ]]; then echo 'postil 0.6.0'; exit 0; fi
base=
model=
invocation="\$*"
while (( \$# > 0 )); do
  case "\$1" in
    --base) base=\$2; shift 2 ;;
    --model) model=\$2; shift 2 ;;
    *) shift ;;
  esac
done
head=\$(git rev-parse HEAD)
merge_base=\$(git merge-base "\$base" "\$head")
mode=\$(< '${paths.modeFile}')
aws=absent; [[ -n "\${AWS_SECRET_ACCESS_KEY+x}" ]] && aws=present
dispositions_variable=absent; [[ -n "\${POSTIL_LOCAL_REVIEW_DISPOSITIONS_FILE+x}" ]] && dispositions_variable=present
credential=absent; [[ -n "\${MODEL_API_KEY:-}\${POSTIL_API_KEY:-}\${OPENROUTER_API_KEY:-}" ]] && credential=present
printf '{"base":"%s","head":"%s","model":"%s","cascade":"%s","scorer":"%s","scorerDisabled":"%s","hostedMode":"%s","apiBase":"%s","apiFormat":"%s","awsCredential":"%s","dispositionsVariable":"%s","modelCredential":"%s","credentialValue":"%s","invocation":"%s"}\n' \
  "\$base" "\$head" "\$model" "\$REVIEW_MODEL_CASCADE" "\$REVIEW_SCORER_MODEL" "\$POSTIL_DISABLE_SCORER" "\$POSTIL_HOSTED_MODE" "\$POSTIL_API_BASE" "\$POSTIL_API_FORMAT" "\$aws" "\$dispositions_variable" "\$credential" "\${MODEL_API_KEY:-}" "\$invocation" >>'${paths.log}'
if [[ "\$mode" == provider-error ]]; then exit 2; fi
if [[ "\$mode" == malformed ]]; then echo '{"findings":[]}'; exit 0; fi
if git diff --quiet "\$base...\$head"; then base_value=null; base_quote=; model_used='none (empty diff)'; else base_value="\$merge_base"; base_quote='"'; model_used="\$model"; fi
if [[ "\$mode" == finding ]]; then
  findings='[{"path":"app.txt","line":1,"severity":"warn","kind":"risk","confidence":0.9,"title":"fixture finding","body":"fixture","id":"fixture-finding-id"}]'
  silent=false; warn=1; summary='fixture finding'; status=1
elif [[ "\$mode" == two-findings ]]; then
  findings='[{"path":"app.txt","line":1,"severity":"warn","kind":"risk","confidence":0.9,"title":"fixture finding","body":"fixture","id":"fixture-finding-id"},{"path":"app.txt","line":2,"severity":"warn","kind":"risk","confidence":0.8,"title":"second fixture finding","body":"fixture","id":"fixture-second-id"}]'
  silent=false; warn=2; summary='fixture findings'; status=1
elif [[ "\$mode" == synthetic-provider ]]; then
  findings='[{"path":".postil/provider","line":1,"severity":"error","kind":"uncertainty","confidence":1,"title":"provider failure","body":"fixture","id":"synthetic-finding-id"}]'
  silent=false; warn=0; summary='provider failure'; status=1
elif [[ "\$mode" == synthetic-model-output ]]; then
  findings='[{"path":".postil/model-output","line":1,"severity":"error","kind":"uncertainty","confidence":1,"title":"model output failure","body":"fixture","id":"synthetic-finding-id"}]'
  silent=false; warn=0; summary='model output failure'; status=1
elif [[ "\$mode" == synthetic-diff ]]; then
  findings='[{"path":".postil/diff","line":1,"severity":"info","kind":"uncertainty","confidence":1,"title":"truncated diff","body":"fixture","id":"synthetic-finding-id"}]'
  silent=false; warn=0; summary='truncated diff'; status=1
else
  findings='[]'; silent=true; warn=0; summary=''; status=0
fi
printf '{"version":1,"summary":"%s","silent":%s,"findings":%s,"resolved":[],"counts":{"info":0,"warn":%s,"error":0,"suppressed":0,"ungrounded":0},"confidenceBuckets":[0,0,0,0,%s],"gate":{"failOn":"info","failing":%s},"modelUsed":"%s","usage":{"promptTokens":1,"completionTokens":1},"durationMs":1,"baseSha":%s%s%s,"headSha":"%s","sinceSha":null}\n' \
  "\$summary" "\$silent" "\$findings" "\$warn" "\$warn" "\$([[ \$status == 1 ]] && echo true || echo false)" "\$model_used" "\$base_quote" "\$base_value" "\$base_quote" "\$head"
exit \$status
`,
    { mode: 0o755 },
  );
  await chmod(postil, 0o755);

  const gh = join(bin, "gh");
  await writeFile(
    gh,
    `#!/bin/sh
if [ "\$(/bin/cat '${paths.modeFile}')" = gh-error ]; then exit 1; fi
printf '[{"baseRefName":"main"}]\\n'
`,
    { mode: 0o755 },
  );
  await chmod(gh, 0o755);

  const secrets = join(bin, "secrets");
  await writeFile(
    secrets,
    `#!/bin/sh
printf '%s\\n' "\$*" >>'${paths.secretsLog}'
printf 'HOME=%s PATH=%s\\n' "\$HOME" "\$PATH" >>'${paths.secretsLog}'
printf 'fixture-secret\\n'
`,
    { mode: 0o755 },
  );
  await chmod(secrets, 0o755);
  return { postil, gh, secrets };
}

async function readRecord(fixture: Fixture): Promise<Record<string, string>> {
  return (await readRecords(fixture)).at(-1) ?? {};
}

async function readRecords(fixture: Fixture): Promise<Array<Record<string, string>>> {
  const lines = (await readFile(fixture.log, "utf8")).trim().split("\n").filter(Boolean);
  return lines.map((line) => JSON.parse(line) as Record<string, string>);
}

async function refExists(remote: string, ref: string): Promise<boolean> {
  const child = Bun.spawn([gitExecutable, "--git-dir", remote, "show-ref", "--verify", "--quiet", ref]);
  return (await child.exited) === 0;
}

async function git(cwd: string, args: string[]): Promise<void> {
  const result = await runGit(cwd, args);
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${result.exitCode})\n${result.stderr || result.stdout}`);
  }
}

async function gitCapture(cwd: string, args: string[]): Promise<string> {
  const result = await runGit(cwd, args);
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${result.exitCode})\n${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

async function runGit(cwd: string, args: string[]) {
  const child = Bun.spawn([gitExecutable, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}
