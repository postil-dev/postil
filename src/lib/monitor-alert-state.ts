import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { dirname } from "node:path";

import {
  monitorPassAlertBucket,
  type MonitorPassFailureState,
} from "@/lib/private-monitoring";

const MAX_STATE_BYTES = 4_096;
const STATE_RETENTION_MS = 24 * 60 * 60 * 1_000;

interface MonitorAlertStateDocument {
  version: 1;
  lastAlertBucket: string;
  sentAt: string;
}

export interface LoadedMonitorAlertState {
  state: MonitorPassFailureState;
  status: "loaded" | "missing" | "expired" | "invalid";
}

export async function loadMonitorAlertState(
  path: string,
  now = new Date(),
): Promise<LoadedMonitorAlertState> {
  const empty = (): MonitorPassFailureState => ({
    bucket: null,
    failuresInBucket: 0,
    lastAlertBucket: null,
  });
  try {
    const metadata = await lstat(path);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size > MAX_STATE_BYTES
    ) {
      return { state: empty(), status: "invalid" };
    }
    const document = parseStateDocument(await readFile(path, "utf8"));
    if (!document) return { state: empty(), status: "invalid" };
    const sentAt = new Date(document.sentAt);
    if (now.getTime() - sentAt.getTime() > STATE_RETENTION_MS) {
      await rm(path, { force: true }).catch(() => undefined);
      return { state: empty(), status: "expired" };
    }
    return {
      state: {
        bucket: null,
        failuresInBucket: 0,
        lastAlertBucket: new Date(document.lastAlertBucket),
      },
      status: "loaded",
    };
  } catch (error) {
    if (isMissingFile(error)) return { state: empty(), status: "missing" };
    return { state: empty(), status: "invalid" };
  }
}

export async function persistMonitorAlertState(
  path: string,
  state: MonitorPassFailureState,
  sentAt = new Date(),
): Promise<void> {
  if (!state.lastAlertBucket) {
    throw new Error("monitor alert state requires a sent alert bucket");
  }
  const bucket = monitorPassAlertBucket(state.lastAlertBucket);
  if (bucket.getTime() !== state.lastAlertBucket.getTime()) {
    throw new Error("monitor alert state bucket is not aligned");
  }
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const document: MonitorAlertStateDocument = {
    version: 1,
    lastAlertBucket: state.lastAlertBucket.toISOString(),
    sentAt: sentAt.toISOString(),
  };
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(document)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
    const directoryHandle = await open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function parseStateDocument(source: string): MonitorAlertStateDocument | null {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.lastAlertBucket !== "string" ||
    typeof record.sentAt !== "string" ||
    Object.keys(record).sort().join(",") !==
      "lastAlertBucket,sentAt,version"
  ) {
    return null;
  }
  const bucket = new Date(record.lastAlertBucket);
  const sentAt = new Date(record.sentAt);
  if (
    !Number.isFinite(bucket.getTime()) ||
    !Number.isFinite(sentAt.getTime()) ||
    monitorPassAlertBucket(bucket).getTime() !== bucket.getTime() ||
    sentAt.getTime() < bucket.getTime()
  ) {
    return null;
  }
  return value as MonitorAlertStateDocument;
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
