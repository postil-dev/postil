import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { spawn, spawnSync } from "node:child_process";

// Only generated homes and local assets are visible to installer children.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "postil-install-"));
  const tools = join(root, "tools");
  const bin = join(root, "bin with spaces");
  const payload = join(root, "payload");
  const temporary = join(root, "tmp");
  for (const path of [tools, bin, payload, temporary]) mkdirSync(path);
  const executable = (path: string, body: string) => { writeFileSync(path, body); chmodSync(path, 0o755); };
  const real = (name: string) => {
    const result = Bun.which(name);
    if (!result) throw new Error(`Missing fixture tool: ${name}`);
    return result;
  };
  for (const name of ["awk", "chmod", "cp", "grep", "gzip", "head", "ls", "mkdir", "mktemp", "mv", "rm", "sh", "tar", "uname"]) symlinkSync(real(name), join(tools, name));
  if (process.platform === "linux") symlinkSync(real("ldd"), join(tools, "ldd"));
  const hashTool = Bun.which("sha256sum") ? "sha256sum" : "shasum";
  symlinkSync(real(hashTool), join(tools, hashTool));
  const override = (name: string, body: string) => {
    if (existsSync(join(tools, name))) rmSync(join(tools, name));
    executable(join(tools, name), `#!/bin/sh\n${body}\n`);
  };
  const target = `${process.arch === "arm64" ? "aarch64" : "x86_64"}-${process.platform === "darwin" ? "apple-darwin" : "unknown-linux-gnu"}`;
  const archiveName = `postil-${target}.tar.gz`;
  const archive = join(root, archiveName);
  const candidate = `#!/bin/sh\necho new-${randomUUID()}\n`;
  executable(join(payload, "postil"), candidate);
  expect(spawnSync(real("tar"), ["-czf", archive, "-C", payload, "postil"]).status).toBe(0);
  writeFileSync(`${archive}.sha256`, `${createHash("sha256").update(readFileSync(archive)).digest("hex")}  ${archiveName}\n`);
  override("curl", `case "$2" in
    "https://github.com/postil-dev/postil-cli/releases/download/v-test/${archiveName}") cp "$FIXTURE_ARCHIVE" "$4" ;;
    "https://github.com/postil-dev/postil-cli/releases/download/v-test/${archiveName}.sha256") cp "$FIXTURE_ARCHIVE.sha256" "$4" ;;
    *) exit 91 ;;
  esac`);
  const old = `#!/bin/sh\necho old-${randomUUID()}\n`;
  executable(join(bin, "postil"), old);
  chmodSync(join(bin, "postil"), 0o555);
  mkdirSync(join(bin, ".postil.unrelated"));
  writeFileSync(join(bin, ".postil.unrelated", "sentinel"), old);
  const environment = { PATH: tools, HOME: root, TMPDIR: temporary, FIXTURE_ARCHIVE: archive };
  const cleanStage = () => {
    expect(readdirSync(bin).filter((name) => name.startsWith(".postil.")).sort()).toEqual([".postil.unrelated"]);
    expect(readFileSync(join(bin, ".postil.unrelated", "sentinel"), "utf8")).toBe(old);
  };
  const preserved = () => {
    expect(readFileSync(join(bin, "postil"), "utf8")).toBe(old);
    expect(lstatSync(join(bin, "postil")).mode & 0o777).toBe(0o555);
    expect(spawnSync(join(bin, "postil"), [], { env: environment }).stdout.toString()).toBe(old.split("echo ")[1]);
    cleanStage();
  };
  const run = (mask = "022") => spawnSync("/bin/sh", ["-c", 'umask "$1"; shift; exec sh "$@"', "fixture", mask, resolve("public/install.sh"), "--version", "v-test", "--bin-dir", bin], { env: environment, timeout: 5000 });
  return { root, tools, bin, real, override, run, old, candidate, preserved, cleanStage, environment, close: () => rmSync(root, { recursive: true }) };
}

for (const fault of ["transfer", "commit", "source-empty", "source-mode", "stage-empty", "stage-mode", "chmod", "mktemp", "download", "checksum", "extract"]) {
  test(`failed ${fault} preserves the runnable CLI`, () => {
    const f = fixture();
    try {
      if (["transfer", "commit", "stage-empty", "stage-mode"].includes(fault)) {
        f.override("mv", `if [ "$1" = -f ]; then
          ${fault === "commit" ? "exit 72" : ":"}
        else
          ${fault === "transfer" ? 'rm -f "$2" || exit; printf partial > "$2"; exit 73' : `'${f.real("mv")}' "$@" || exit
          ${fault === "stage-empty" ? ': > "$2"' : fault === "stage-mode" ? `'${f.real("chmod")}' a-x "$2"` : ":"}
          exit 0`}
        fi
        exec '${f.real("mv")}' "$@"`);
      } else if (["source-empty", "source-mode", "chmod"].includes(fault)) {
        f.override("chmod", fault === "chmod" ? "exit 74" : fault === "source-empty" ? `'${f.real("chmod")}' "$@" || exit; : > "$2"` : `'${f.real("chmod")}' a-x "$2"`);
      } else if (fault === "mktemp") {
        f.override("mktemp", `case "$*" in *.postil.*) exit 75;; esac\nexec '${f.real("mktemp")}' "$@"`);
      } else if (fault === "download") f.override("curl", "exit 76");
      else if (fault === "checksum") f.override(Bun.which("sha256sum") ? "sha256sum" : "shasum", "echo invalid-checksum");
      else f.override("tar", "exit 77");
      const result = f.run();
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      f.preserved();
    } finally { f.close(); }
  });
}

for (const mask of ["022", "077"]) {
  test(`complete upgrade preserves the prepared mode under umask ${mask}`, () => {
    const f = fixture();
    try {
      expect(f.run(mask).status).toBe(0);
      expect(readFileSync(join(f.bin, "postil"), "utf8")).toBe(f.candidate);
      expect(lstatSync(join(f.bin, "postil")).mode & 0o777).toBe(mask === "077" ? 0o700 : 0o755);
      f.cleanStage();
    } finally { f.close(); }
  });
}

test("file symlink replacement leaves its target intact", () => {
  const f = fixture();
  try {
    const target = join(f.root, "old-target");
    writeFileSync(target, f.old);
    rmSync(join(f.bin, "postil"));
    symlinkSync(target, join(f.bin, "postil"));
    expect(f.run().status).toBe(0);
    expect(lstatSync(join(f.bin, "postil")).isSymbolicLink()).toBe(false);
    expect(readFileSync(target, "utf8")).toBe(f.old);
    f.cleanStage();
  } finally { f.close(); }
});

test("directory symlink rejects replacement without changing its target", () => {
  const f = fixture();
  try {
    const target = join(f.root, "directory-target");
    mkdirSync(target);
    writeFileSync(join(target, "sentinel"), f.old);
    rmSync(join(f.bin, "postil"));
    symlinkSync(target, join(f.bin, "postil"));
    expect(f.run().status).not.toBe(0);
    expect(readdirSync(target)).toEqual(["sentinel"]);
    expect(readFileSync(join(target, "sentinel"), "utf8")).toBe(f.old);
    f.cleanStage();
  } finally { f.close(); }
});

for (const order of [[0, 1], [1, 0]]) {
  for (const succeeds of [[false, false], [false, true], [true, false], [true, true]]) {
    test(`concurrent order ${order} outcomes ${succeeds} retains the last complete commit`, async () => {
      const fixtures = [fixture(), fixture()];
      const children: ReturnType<typeof spawn>[] = [];
      try {
        const attempts = fixtures.map((f, index) => {
          f.override("mv", `if [ "$1" = -f ]; then
            echo READY
            read -r release || exit 78
            ${succeeds[index] ? ":" : "exit 79"}
          fi
          exec '${f.real("mv")}' "$@"`);
          const child = spawn("/bin/sh", [resolve("public/install.sh"), "--version", "v-test", "--bin-dir", fixtures[0].bin], { env: f.environment, stdio: "pipe", timeout: 5000 });
          children.push(child);
          child.stderr.resume();
          const done = once(child, "close");
          const lines = createInterface({ input: child.stdout });
          const ready = (async () => {
            for await (const line of lines) if (line === "READY") return;
            throw new Error("Installer exits before commit boundary");
          })();
          return { child, done, ready };
        });
        await Promise.all(attempts.map((attempt) => attempt.ready));
        let expected = fixtures[0].old;
        for (const index of order) {
          attempts[index].child.stdin.end("commit\n");
          const [code] = await attempts[index].done;
          expect(code === 0).toBe(succeeds[index]);
          if (succeeds[index]) expected = fixtures[index].candidate;
          expect(readFileSync(join(fixtures[0].bin, "postil"), "utf8")).toBe(expected);
          expect(spawnSync(join(fixtures[0].bin, "postil"), [], { env: fixtures[0].environment }).status).toBe(0);
        }
        fixtures[0].cleanStage();
      } finally {
        for (const child of children) if (child.exitCode === null && child.signalCode === null) { child.stdin?.end(); child.kill(); }
        for (const f of fixtures) f.close();
      }
    });
  }
}
