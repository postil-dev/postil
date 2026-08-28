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
    const schema = await getPool().query<{
      hostedReady: boolean;
      publicationLifecycleReady: boolean;
    }>(
      `SELECT
         to_regclass('public.deployment_capabilities') IS NOT NULL AS "hostedReady",
         to_regclass('public.deployment_capabilities') IS NOT NULL
           AND to_regclass('public.jobs') IS NOT NULL
           AND EXISTS (
             SELECT 1
               FROM information_schema.columns
              WHERE table_schema = 'public'
                AND table_name = 'reviews'
                AND column_name = 'publication_lifecycle_required_at'
           ) AS "publicationLifecycleReady"`,
    );
    if (schema.rows[0]?.hostedReady !== true) {
      console.log("managed release preparation skipped until the database schema exists");
      return;
    }
    const publicationLifecycle = schema.rows[0].publicationLifecycleReady
      ? await deactivatePublicationLifecycleRelease(getPool())
      : { deactivated: false, parked: 0 };
    const publicationLifecycleState = !schema.rows[0].publicationLifecycleReady
      ? "schema not installed"
      : publicationLifecycle.deactivated
        ? "prior activation removed"
        : "already dark";
    const deactivated = await deactivateHostedInferenceRelease(
      getPool(),
      releaseSha,
    );
    console.log(
      `managed hosted inference prepared dark: ${deactivated ? "prior activation removed" : "already dark"}`,
    );
    console.log(
      `publication lifecycle prepared dark: ${publicationLifecycleState}; parked=${publicationLifecycle.parked}`,
    );
  } finally {
    await closeDb();
  }
}

if (import.meta.main) await main();
