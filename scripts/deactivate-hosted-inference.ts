import { closeDb, getPool } from "@/lib/db";
import { requireEnv } from "@/lib/env";
import { deactivateHostedInferenceRelease } from "@/lib/release-job-rollout";

async function main(): Promise<void> {
  try {
    const deactivated = await deactivateHostedInferenceRelease(
      getPool(),
      requireEnv("POSTIL_RELEASE_SHA"),
    );
    console.log(
      `managed hosted inference prepared dark: ${deactivated ? "prior activation removed" : "already dark"}`,
    );
  } finally {
    await closeDb();
  }
}

if (import.meta.main) await main();
