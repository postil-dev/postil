import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Pool } from "pg";

import {
  REVIEW_LOG_MAX_LINES,
  ReviewLogWriter,
  postilCliVersionLogLine,
  probePostilCliVersion,
  runCli,
} from "@/worker/review";

const TEST_URL = process.env.POSTIL_TEST_DATABASE_URL;
const describeDb = TEST_URL ? describe : describe.skip;

describe("runCli log observation", () => {
  test("streams stderr by line without exposing envelope stdout to the observer", async () => {
    const oldBin = process.env.POSTIL_BIN;
    process.env.POSTIL_BIN = process.execPath;
    const lines: string[] = [];
    try {
      const result = await runCli(
        [
          "-e",
          'process.stdout.write("large-envelope-json"); process.stderr.write("phase one\\nphase two");',
        ],
        {},
        undefined,
        { onStderrLine: (line) => lines.push(line) },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("large-envelope-json");
      expect(lines).toEqual(["phase one", "phase two"]);
      expect(lines.join("\n")).not.toContain("large-envelope-json");
    } finally {
      if (oldBin === undefined) delete process.env.POSTIL_BIN;
      else process.env.POSTIL_BIN = oldBin;
    }
  });
});

async function versionFixture(source: string): Promise<{ directory: string; executable: string }> {
  const directory = await mkdtemp(join(tmpdir(), "postil-version-"));
  const executable = join(directory, "postil");
  await writeFile(executable, `#!/usr/bin/env bun\n${source}\n`, "utf8");
  await chmod(executable, 0o755);
  return { directory, executable };
}

describe("postil CLI version logging", () => {
  test("normalizes and caches the exact version log line", async () => {
    const fixture = await versionFixture('console.log("postil 0.5.7");');
    const previousExecutable = process.env.POSTIL_BIN;
    process.env.POSTIL_BIN = fixture.executable;
    try {
      expect(await postilCliVersionLogLine()).toBe("postil CLI version 0.5.7");
      await writeFile(
        fixture.executable,
        '#!/usr/bin/env bun\nconsole.log("postil 0.5.8");\n',
        "utf8",
      );
      expect(await postilCliVersionLogLine()).toBe("postil CLI version 0.5.7");
    } finally {
      if (previousExecutable === undefined) delete process.env.POSTIL_BIN;
      else process.env.POSTIL_BIN = previousExecutable;
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  test("bounds a hung probe", async () => {
    const fixture = await versionFixture(
      'await Bun.sleep(250); console.log("postil 0.5.7");',
    );
    try {
      await expect(probePostilCliVersion(fixture.executable, 20)).rejects.toThrow(
        "postil CLI version probe timed out after 20ms",
      );
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  test("degrades safely and nonblockingly when version output is unrecognized", async () => {
    const fixture = await versionFixture(
      'console.log("postil credential-value-must-not-leak");',
    );
    const previousExecutable = process.env.POSTIL_BIN;
    process.env.POSTIL_BIN = fixture.executable;
    try {
      const error = await probePostilCliVersion(fixture.executable).catch((cause) => cause);
      expect(String(error)).toContain("returned unrecognized output");
      expect(String(error)).not.toContain("credential-value-must-not-leak");
      expect(await postilCliVersionLogLine()).toBe("postil CLI version unavailable");
    } finally {
      if (previousExecutable === undefined) delete process.env.POSTIL_BIN;
      else process.env.POSTIL_BIN = previousExecutable;
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });
});

describeDb("review log persistence", () => {
  let pool: Pool;
  let reviewId: number;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_URL;
    pool = new Pool({ connectionString: TEST_URL, max: 4 });
    const dir = join(import.meta.dir, "..", "drizzle");
    const files = (await readdir(dir)).filter((file) => file.endsWith(".sql")).sort();
    for (const file of files) {
      const sqlText = await readFile(join(dir, file), "utf8");
      for (const statement of sqlText.split("--> statement-breakpoint")) {
        const trimmed = statement.trim();
        if (!trimmed) continue;
        try {
          await pool.query(trimmed);
        } catch (err) {
          const code = (err as { code?: string }).code;
          if (code !== "42P07" && code !== "42710" && code !== "42701") throw err;
        }
      }
    }
  });

  beforeEach(async () => {
    await pool.query(
      "TRUNCATE review_logs, reviews, repositories, installations, organizations RESTART IDENTITY CASCADE",
    );
    const org = await pool.query<{ id: string }>(
      "INSERT INTO organizations (slug, name) VALUES ('logs', 'Logs') RETURNING id",
    );
    const installation = await pool.query<{ id: string }>(
      `INSERT INTO installations
         (github_installation_id, org_id, account_login, account_type)
       VALUES (800, $1, 'logs', 'Organization') RETURNING id`,
      [org.rows[0]!.id],
    );
    const repository = await pool.query<{ id: string }>(
      `INSERT INTO repositories
         (installation_id, github_repo_id, full_name)
       VALUES ($1, 801, 'logs/repo') RETURNING id`,
      [installation.rows[0]!.id],
    );
    const review = await pool.query<{ id: string }>(
      `INSERT INTO reviews (repository_id, pr_number, head_sha, base_sha, status, started_at)
       VALUES ($1, 1, 'head', 'base', 'running', now()) RETURNING id`,
      [repository.rows[0]!.id],
    );
    reviewId = Number(review.rows[0]!.id);
  });

  afterAll(async () => {
    await pool?.end();
  });

  test("redacts before batching lines into storage", async () => {
    const secret = "ghs_abcdefghijklmnopqrstuvwxyz123456";
    const writer = new ReviewLogWriter(reviewId);
    writer.setSensitiveValues([secret]);
    writer.line(`token ${secret}`);
    writer.line("next milestone");
    await writer.close();

    const stored = await pool.query<{ seq: number; line: string }>(
      "SELECT seq, line FROM review_logs WHERE review_id = $1 ORDER BY seq",
      [reviewId],
    );
    expect(stored.rows).toEqual([
      { seq: 1, line: "token [redacted]" },
      { seq: 2, line: "next milestone" },
    ]);
  });

  test("caps each review at the truncation marker", async () => {
    const writer = new ReviewLogWriter(reviewId);
    for (let index = 0; index < REVIEW_LOG_MAX_LINES + 20; index += 1) {
      writer.line(`line ${index + 1}`);
    }
    await writer.close();

    const stored = await pool.query<{ count: number; max_seq: number; last_line: string }>(
      `SELECT count(*)::int AS count, max(seq)::int AS max_seq,
              (array_agg(line ORDER BY seq DESC))[1] AS last_line
       FROM review_logs WHERE review_id = $1`,
      [reviewId],
    );
    expect(stored.rows[0]).toEqual({
      count: REVIEW_LOG_MAX_LINES,
      max_seq: REVIEW_LOG_MAX_LINES,
      last_line: `[log truncated after ${REVIEW_LOG_MAX_LINES - 1} lines]`,
    });
  });
});
