import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";

export interface PrivateJsonArtifactReadOptions {
  maximumBytes: number;
  /** Optional identity captured when the service created the artifact path. */
  expectedIdentity?: Pick<PrivateJsonArtifactIdentity, "dev" | "ino">;
}

export interface PrivateJsonArtifact {
  bytes: Uint8Array;
  value: unknown;
}

interface PrivateJsonArtifactIdentity {
  dev: bigint;
  ino: bigint;
  mode: bigint;
  nlink: bigint;
  uid: bigint;
}

interface PrivateJsonArtifactSnapshot extends PrivateJsonArtifactIdentity {
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
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
    opened.nlink === 1n &&
    (opened.mode & 0o077n) === 0n &&
    (processUid === undefined || opened.uid === BigInt(processUid))
  );
}

/** The opened artifact did not change while its exact bytes were read. */
export function privateJsonArtifactHandleUnchanged(
  before: PrivateJsonArtifactSnapshot,
  after: PrivateJsonArtifactSnapshot,
): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.nlink === 1n &&
    after.nlink === 1n &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
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
  return (await readPrivateJsonArtifactExact(artifactPath, options)).value;
}

/** Read one artifact while retaining the exact bytes that passed validation. */
export async function readPrivateJsonArtifactExact(
  artifactPath: string,
  options: PrivateJsonArtifactReadOptions,
): Promise<PrivateJsonArtifact> {
  if (!Number.isSafeInteger(options.maximumBytes) || options.maximumBytes <= 0) {
    throw invalidArtifact();
  }

  let handle: FileHandle | undefined;
  try {
    const initial = await lstat(artifactPath, { bigint: true });
    if (!initial.isFile() || initial.isSymbolicLink()) throw invalidArtifact();
    if (
      options.expectedIdentity !== undefined &&
      (initial.dev !== options.expectedIdentity.dev ||
        initial.ino !== options.expectedIdentity.ino)
    ) {
      throw invalidArtifact();
    }

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
      !privateJsonArtifactHandleMatches(initial, afterRead, processUid) ||
      !privateJsonArtifactHandleUnchanged(beforeRead, afterRead)
    ) {
      throw invalidArtifact();
    }

    let source: string;
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return { bytes, value: JSON.parse(source) };
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
