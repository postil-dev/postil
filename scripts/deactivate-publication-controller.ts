import { closeDb, getPool } from "@/lib/db";
import { optionalEnv } from "@/lib/env";
import {
  deactivatePublicationControllerRelease,
  type PublicationControllerRecoveryStateReader,
  readProductionPublicationControllerRecoveryState,
} from "@/lib/release-job-rollout";

async function main(): Promise<void> {
  try {
    const releaseSha = optionalEnv("POSTIL_RELEASE_SHA");
    if (!releaseSha) {
      console.log("publication-controller preparation skipped outside a release image");
      return;
    }
    const deactivated = await preparePublicationControllerDarkRelease(
      releaseSha,
      readProductionPublicationControllerRecoveryState,
    );
    if (deactivated.state === "recovery") {
      throw new Error(
        "publication-controller routing is disabled, but recovery remains " +
          "fail-closed because durable generations are not bound to an exact " +
          "controller release and source queue job",
      );
    }
    const routing = deactivated.routingRemoved
      ? "prior routing removed"
      : "already dark";
    console.log(
      `publication-controller prepared dark: ${routing}; ` +
        `restored_legacy_jobs=${deactivated.restoredLegacyJobs}`,
    );
  } finally {
    await closeDb();
  }
}

export async function preparePublicationControllerDarkRelease(
  releaseSha: string,
  recoveryStateReader: PublicationControllerRecoveryStateReader =
    readProductionPublicationControllerRecoveryState,
) {
  return deactivatePublicationControllerRelease(
    getPool(),
    releaseSha,
    recoveryStateReader,
  );
}

if (import.meta.main) await main();
