import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import {
  privateJsonArtifactHandleUnchanged,
  privateJsonArtifactHandleMatches,
  readPrivateJsonArtifact,
} from "@/lib/private-json-artifact";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

const MAXIMUM_BYTES = 1_024;

async function artifact(name: string, source: string | Uint8Array): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "postil-private-json-artifact-"));
  directories.push(directory);
  const path = join(directory, name);
  await writeFile(path, source, { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

describe("private JSON artifact reader", () => {
  test("accepts valid absolute and relative regular files", async () => {
    const absolute = await artifact("absolute.json", '{"version":1}');
    const relativePath = relative(process.cwd(), absolute);

    await expect(readPrivateJsonArtifact(absolute, { maximumBytes: MAXIMUM_BYTES })).resolves.toEqual({
      version: 1,
    });
    await expect(readPrivateJsonArtifact(relativePath, { maximumBytes: MAXIMUM_BYTES })).resolves.toEqual({
      version: 1,
    });
  });

  test("rejects symlinks and directories", async () => {
    const target = await artifact("target.json", '{"version":1}');
    const directory = await mkdtemp(join(tmpdir(), "postil-private-json-artifact-"));
    directories.push(directory);
    const link = join(directory, "artifact.json");
    await symlink(target, link);
    const nested = join(directory, "directory");
    await mkdir(nested);

    await expect(readPrivateJsonArtifact(link, { maximumBytes: MAXIMUM_BYTES })).rejects.toThrow(
      "private JSON artifact is invalid",
    );
    await expect(readPrivateJsonArtifact(nested, { maximumBytes: MAXIMUM_BYTES })).rejects.toThrow(
      "private JSON artifact is invalid",
    );
  });

  test.each([0o640, 0o604, 0o666])("rejects mode %o", async (mode) => {
    const path = await artifact("permissive.json", '{"version":1}');
    await chmod(path, mode);

    await expect(readPrivateJsonArtifact(path, { maximumBytes: MAXIMUM_BYTES })).rejects.toThrow(
      "private JSON artifact is invalid",
    );
  });

  test("requires the opened handle to match the initial file and process owner", () => {
    const initial = { dev: 10n, ino: 20n };
    const ownerOnly = {
      ...initial,
      mode: 0o100600n,
      nlink: 1n,
      uid: 1_000n,
    };

    expect(privateJsonArtifactHandleMatches(initial, ownerOnly, 1_000)).toBe(true);
    expect(privateJsonArtifactHandleMatches(initial, { ...ownerOnly, dev: 11n }, 1_000)).toBe(
      false,
    );
    expect(privateJsonArtifactHandleMatches(initial, { ...ownerOnly, ino: 21n }, 1_000)).toBe(
      false,
    );
    expect(privateJsonArtifactHandleMatches(initial, { ...ownerOnly, mode: 0o100640n }, 1_000)).toBe(
      false,
    );
    expect(privateJsonArtifactHandleMatches(initial, ownerOnly, 1_001)).toBe(false);
    expect(privateJsonArtifactHandleMatches(initial, ownerOnly, undefined)).toBe(true);
    expect(
      privateJsonArtifactHandleMatches(
        initial,
        { ...ownerOnly, nlink: 2n },
        1_000,
      ),
    ).toBe(false);
  });

  test("requires unchanged size and nanosecond timestamps across the read", () => {
    const before = {
      dev: 10n,
      ino: 20n,
      mode: 0o100600n,
      nlink: 1n,
      uid: 1_000n,
      size: 100n,
      mtimeNs: 200n,
      ctimeNs: 300n,
    };

    expect(privateJsonArtifactHandleUnchanged(before, before)).toBe(true);
    for (const changed of [
      { ...before, size: 101n },
      { ...before, mtimeNs: 201n },
      { ...before, ctimeNs: 301n },
      { ...before, nlink: 0n },
      { ...before, ino: 21n },
    ]) {
      expect(privateJsonArtifactHandleUnchanged(before, changed)).toBe(false);
    }
  });

  test("rejects artifacts with another hard-link name", async () => {
    const path = await artifact("linked.json", '{"version":1}');
    await link(path, join(dirname(path), "alias.json"));

    await expect(
      readPrivateJsonArtifact(path, { maximumBytes: MAXIMUM_BYTES }),
    ).rejects.toThrow("private JSON artifact is invalid");
  });

  test("rejects oversized, truncated, malformed, and invalid UTF-8 sources", async () => {
    const oversized = await artifact("oversized.json", Buffer.alloc(MAXIMUM_BYTES + 1, 0x20));
    const truncated = await artifact("truncated.json", '{"version":');
    const malformed = await artifact("malformed.json", '{"version":1,}');
    const invalidUtf8 = await artifact("invalid-utf8.json", Buffer.from([0xff, 0xfe]));

    for (const path of [oversized, truncated, malformed, invalidUtf8]) {
      await expect(readPrivateJsonArtifact(path, { maximumBytes: MAXIMUM_BYTES })).rejects.toThrow(
        "private JSON artifact is invalid",
      );
    }
  });

  test("returns one complete value or rejects a replacement race", async () => {
    const source = await artifact("artifact.json", '{"source":"initial"}');
    const next = join(dirname(source), "replacement.json");
    await writeFile(next, '{"source":"replacement"}', { mode: 0o600 });
    await chmod(next, 0o600);

    const read = readPrivateJsonArtifact(source, { maximumBytes: MAXIMUM_BYTES });
    await rename(next, source);
    const outcome = await read.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    if ("value" in outcome) {
      expect(outcome.value).toSatisfy((value: unknown) =>
        value !== null &&
        typeof value === "object" &&
        ["initial", "replacement"].includes((value as { source?: unknown }).source as string),
      );
    } else {
      expect(String(outcome.error)).toContain("private JSON artifact is invalid");
    }
    expect((await lstat(source)).isFile()).toBe(true);
  });

  test("never includes artifact payloads in errors", async () => {
    const payload = "private-marker-that-must-not-appear";
    const path = await artifact("leak.json", `{\"payload\":\"${payload}\",}`);

    await expect(readPrivateJsonArtifact(path, { maximumBytes: MAXIMUM_BYTES })).rejects.toThrow(
      "private JSON artifact is invalid",
    );
    await readPrivateJsonArtifact(path, { maximumBytes: MAXIMUM_BYTES }).catch((error: unknown) => {
      expect(String(error)).not.toContain(payload);
    });
  });
});
