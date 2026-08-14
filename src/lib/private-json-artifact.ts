import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";

export interface PrivateJsonArtifactReadOptions {
  maximumBytes: number;
}

interface PrivateJsonArtifactIdentity {
  dev: bigint;
  ino: bigint;
  mode: bigint;
  uid: bigint;
}

/** The opened artifact is the same owner-only file observed at the path. */
export function privateJsonArtifactHandleMatches(
  initial: Pick<PrivateJsonArtifactIdentity, "dev" | "ino">,
  opened: PrivateJsonArtifactIdentity,
  processUid: number | undefined,
): boolean {
  return (
    initial.dev === opened.dev &&
    initial.ino === opened.ino &&
    (opened.mode & 0o077n) === 0n &&
    (processUid === undefined || opened.uid === BigInt(processUid))
  );
}

/**
 * Read one bounded JSON artifact without exposing its contents in failures.
 *
 * The opened file descriptor, rather than the path, remains authoritative
 * after the initial symlink and file-type check. Callers validate the returned
 * value against their own versioned contract.
 */
export async function readPrivateJsonArtifact(
  artifactPath: string,
  options: PrivateJsonArtifactReadOptions,
): Promise<unknown> {
  if (!Number.isSafeInteger(options.maximumBytes) || options.maximumBytes <= 0) {
    throw invalidArtifact();
  }

  let handle: FileHandle | undefined;
  try {
    const initial = await lstat(artifactPath, { bigint: true });
    if (!initial.isFile() || initial.isSymbolicLink()) throw invalidArtifact();

    handle = await open(artifactPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const beforeRead = await handle.stat({ bigint: true });
    const processUid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (
      !beforeRead.isFile() ||
      beforeRead.isSymbolicLink() ||
      !privateJsonArtifactHandleMatches(initial, beforeRead, processUid) ||
      beforeRead.size <= 0n ||
      beforeRead.size > BigInt(options.maximumBytes)
    ) {
      throw invalidArtifact();
    }

    const bytes = Buffer.alloc(Number(beforeRead.size));
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) throw invalidArtifact();
      offset += result.bytesRead;
    }
    const afterRead = await handle.stat({ bigint: true });
    if (
      !afterRead.isFile() ||
      afterRead.size !== beforeRead.size ||
      !privateJsonArtifactHandleMatches(initial, afterRead, processUid)
    ) {
      throw invalidArtifact();
    }

    let source: string;
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return JSON.parse(source);
    } catch {
      throw invalidArtifact();
    }
  } catch (error) {
    if (error instanceof Error && error.message === "private JSON artifact is invalid") {
      throw error;
    }
    throw invalidArtifact();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function invalidArtifact(): Error {
  return new Error("private JSON artifact is invalid");
}
