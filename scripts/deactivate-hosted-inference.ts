import { closeDb, getPool } from "@/lib/db";
import { optionalEnv } from "@/lib/env";
import {
  deactivateHostedInferenceRelease,
  deactivatePublicationLifecycleRelease,
} from "@/lib/release-job-rollout";
import { resolveDirectDatabaseUrl } from "./resolve-direct-database-url";

async function main(): Promise<void> {
  try {
    const releaseSha = optionalEnv("POSTIL_RELEASE_SHA");
    if (!releaseSha) {
      console.log("managed hosted inference preparation skipped outside a release image");
      return;
    }
    process.env.DATABASE_URL = resolveDirectDatabaseUrl({
      databaseUrl: process.env.DATABASE_URL ?? "",
      directDatabaseUrl: process.env.POSTIL_DIRECT_DATABASE_URL,
    });
    delete process.env.POSTIL_DIRECT_DATABASE_URL;
    const schemaReady = await getPool().query<{ ready: boolean }>(
      `SELECT to_regclass('public.deployment_capabilities') IS NOT NULL
          AND to_regclass('public.jobs') IS NOT NULL AS ready`,
    );
    if (schemaReady.rows[0]?.ready !== true) {
      console.log("managed release preparation skipped until the database schema exists");
      return;
    }
    const publicationLifecycle = await deactivatePublicationLifecycleRelease(
      getPool(),
    );
    const deactivated = await deactivateHostedInferenceRelease(
      getPool(),
      releaseSha,
    );
    console.log(
      `managed hosted inference prepared dark: ${deactivated ? "prior activation removed" : "already dark"}`,
    );
    console.log(
      `publication lifecycle prepared dark: ${publicationLifecycle.deactivated ? "prior activation removed" : "already dark"}; parked=${publicationLifecycle.parked}`,
    );
  } finally {
    await closeDb();
  }
}

if (import.meta.main) await main();
