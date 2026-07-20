import { closeDb, getPool } from "@/lib/db";
import { optionalEnv } from "@/lib/env";
import { prepareHostedInferenceRelease } from "@/lib/release-job-rollout";

async function main(): Promise<void> {
  try {
    const releaseSha = optionalEnv("POSTIL_RELEASE_SHA");
    if (!releaseSha) {
      console.log("managed hosted inference preparation skipped outside a release image");
      return;
    }
    const alreadyActive = await prepareHostedInferenceRelease(
      getPool(),
      releaseSha,
    );
    console.log(
      `managed hosted inference release prepared: ${alreadyActive ? "existing activation preserved" : "awaiting post-deploy activation"}`,
    );
  } finally {
    await closeDb();
  }
}

if (import.meta.main) await main();
