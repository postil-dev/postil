import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { Client, Pool } from "pg";

import { hostedInferenceAvailable } from "@/lib/env";
import {
  activateHostedInferenceRelease,
  deactivateHostedInferenceRelease,
  hostedInferenceReleaseActivated,
} from "@/lib/release-job-rollout";

const TEST_URL = process.env.POSTIL_TEST_DATABASE_URL;
const describeDb = TEST_URL ? describe : describe.skip;

describeDb("managed hosted inference release activation", () => {
  const databaseName = `postil_hosted_activation_${process.pid}_${Date.now()}`;
  const releaseA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const releaseB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  let admin: Client;
  let pool: Pool;

  beforeAll(async () => {
    admin = new Client({ connectionString: TEST_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(TEST_URL!);
    url.pathname = `/${databaseName}`;
    const migration = new Client({ connectionString: url.toString() });
    await migration.connect();
    for (const file of (await readdir(join(import.meta.dir, "..", "drizzle")))
      .filter((name) => /^\d{4}_.*\.sql$/.test(name))
      .sort()) {
      const source = await readFile(join(import.meta.dir, "..", "drizzle", file), "utf8");
      for (const statement of source.split("--> statement-breakpoint")) {
        if (statement.trim()) await migration.query(statement);
      }
    }
    await migration.end();
    pool = new Pool({ connectionString: url.toString() });
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await admin?.end();
    delete process.env.POSTIL_RELEASE_SHA;
    delete process.env.POSTIL_HOSTED_INFERENCE_ENABLED;
  }, 30_000);

  test("deploys dark, activates only the exact release, and deactivates on rollback", async () => {
    process.env.POSTIL_HOSTED_INFERENCE_ENABLED = "1";
    process.env.POSTIL_RELEASE_SHA = releaseA;

    expect(await hostedInferenceAvailable(pool)).toBe(false);
    expect(await activateHostedInferenceRelease(pool, releaseA)).toBe(true);
    expect(await hostedInferenceAvailable(pool)).toBe(true);
    expect(await hostedInferenceReleaseActivated(pool, releaseB)).toBe(false);

    process.env.POSTIL_RELEASE_SHA = releaseB;
    expect(await hostedInferenceAvailable(pool)).toBe(false);
    expect(await activateHostedInferenceRelease(pool, releaseB)).toBe(true);
    expect(await hostedInferenceAvailable(pool)).toBe(true);
    expect(await deactivateHostedInferenceRelease(pool, releaseB)).toBe(true);
    expect(await hostedInferenceAvailable(pool)).toBe(false);

    process.env.POSTIL_RELEASE_SHA = releaseA;
    expect(await hostedInferenceAvailable(pool)).toBe(true);
    process.env.POSTIL_HOSTED_INFERENCE_ENABLED = "0";
    expect(await hostedInferenceAvailable(pool)).toBe(false);
  });
});
