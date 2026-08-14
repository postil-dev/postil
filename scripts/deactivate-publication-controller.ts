import { closeDb, getPool } from "@/lib/db";
import { optionalEnv } from "@/lib/env";
import { deactivatePublicationControllerRelease } from "@/lib/release-job-rollout";

async function main(): Promise<void> {
  try {
    const releaseSha = optionalEnv("POSTIL_RELEASE_SHA");
    if (!releaseSha) {
      console.log("publication-controller preparation skipped outside a release image");
      return;
    }
    const deactivated = await deactivatePublicationControllerRelease(
      getPool(),
      releaseSha,
    );
    console.log(
      `publication-controller prepared dark: ${deactivated ? "prior activation removed" : "already dark"}`,
    );
  } finally {
    await closeDb();
  }
}

if (import.meta.main) await main();
