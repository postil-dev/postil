import { closeDb, getPool } from "@/lib/db";
import { optionalEnv } from "@/lib/env";
import {
  deactivateHostedInferenceRelease,
  deactivatePublicationLifecycleRelease,
} from "@/lib/release-job-rollout";

async function main(): Promise<void> {
  try {
    const releaseSha = optionalEnv("POSTIL_RELEASE_SHA");
    if (!releaseSha) {
      console.log("managed hosted inference preparation skipped outside a release image");
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
