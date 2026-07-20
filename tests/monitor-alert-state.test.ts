import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  loadMonitorAlertState,
  persistMonitorAlertState,
} from "@/lib/monitor-alert-state";
import {
  markMonitorPassAlertSent,
  recordMonitorPassFailure,
} from "@/lib/private-monitoring";

const NOW = new Date("2026-07-20T06:00:00.000Z");
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("monitor alert state", () => {
  test("deduplicates the same outage bucket after a process restart", async () => {
    const path = await statePath();
    let state = (await loadMonitorAlertState(path, NOW)).state;
    let failure = recordMonitorPassFailure(state, NOW);
    failure = recordMonitorPassFailure(
      failure.state,
      new Date(NOW.getTime() + 1_000),
    );
    expect(failure.shouldAlert).toBe(true);
    state = markMonitorPassAlertSent(failure.state);
    await persistMonitorAlertState(path, state, new Date(NOW.getTime() + 2_000));

    const restarted = await loadMonitorAlertState(
      path,
      new Date(NOW.getTime() + 30 * 60_000),
    );
    expect(restarted.status).toBe("loaded");
    failure = recordMonitorPassFailure(
      restarted.state,
      new Date(NOW.getTime() + 30 * 60_000),
    );
    failure = recordMonitorPassFailure(
      failure.state,
      new Date(NOW.getTime() + 30 * 60_000 + 1_000),
    );
    expect(failure.shouldAlert).toBe(false);
    expect((await readFile(path, "utf8")).length).toBeLessThan(4_096);
  });

  test("fails open when durable state is corrupt", async () => {
    const path = await statePath();
    await writeFile(path, "not-json", { mode: 0o600 });
    const loaded = await loadMonitorAlertState(path, NOW);
    expect(loaded.status).toBe("invalid");
    let failure = recordMonitorPassFailure(loaded.state, NOW);
    failure = recordMonitorPassFailure(
      failure.state,
      new Date(NOW.getTime() + 1_000),
    );
    expect(failure.shouldAlert).toBe(true);
  });

  test("expires old state and keeps one bounded record", async () => {
    const path = await statePath();
    let failure = recordMonitorPassFailure(
      { bucket: null, failuresInBucket: 0, lastAlertBucket: null },
      NOW,
      1,
    );
    await persistMonitorAlertState(
      path,
      markMonitorPassAlertSent(failure.state),
      NOW,
    );
    const expired = await loadMonitorAlertState(
      path,
      new Date(NOW.getTime() + 25 * 60 * 60_000),
    );
    expect(expired.status).toBe("expired");
    expect(expired.state.lastAlertBucket).toBeNull();
  });
});

async function statePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "postil-monitor-state-"));
  directories.push(directory);
  return join(directory, "alert-state.json");
}
