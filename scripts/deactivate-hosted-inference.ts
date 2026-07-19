import { closeDb, getPool } from "@/lib/db";
import { optionalEnv } from "@/lib/env";
import { deactivateHostedInferenceRelease } from "@/lib/release-job-rollout";

async function main(): Promise<void> {
  try {
    const releaseSha = optionalEnv("POSTIL_RELEASE_SHA");
    if (!releaseSha) {
      console.log("managed hosted inference preparation skipped outside a release image");
      return;
    }
    const deactivated = await deactivateHostedInferenceRelease(
      getPool(),
      releaseSha,
    );
    console.log(
      `managed hosted inference prepared dark: ${deactivated ? "prior activation removed" : "already dark"}`,
    );
  } finally {
    await closeDb();
  }
}

if (import.meta.main) await main();
