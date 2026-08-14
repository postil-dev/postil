import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";

export interface PrivateJsonArtifactReadOptions {
  maximumBytes: number;
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
    const initial = await lstat(artifactPath);
    if (!initial.isFile() || initial.isSymbolicLink()) throw invalidArtifact();

    handle = await open(artifactPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const beforeRead = await handle.stat();
    if (
      !beforeRead.isFile() ||
      beforeRead.isSymbolicLink() ||
      beforeRead.size <= 0 ||
      beforeRead.size > options.maximumBytes
    ) {
      throw invalidArtifact();
    }

    const bytes = Buffer.alloc(beforeRead.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) throw invalidArtifact();
      offset += result.bytesRead;
    }
    const afterRead = await handle.stat();
    if (!afterRead.isFile() || afterRead.size !== beforeRead.size) throw invalidArtifact();

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
