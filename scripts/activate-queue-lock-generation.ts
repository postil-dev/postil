import { closeDb, getPool } from "@/lib/db";
import { activateQueueLockGeneration } from "@/lib/release-job-rollout";

async function main(): Promise<void> {
  try {
    const released = await activateQueueLockGeneration(getPool());
    console.log(`queue lock-generation capability active; released ${released} job(s)`);
  } finally {
    await closeDb();
  }
}

if (import.meta.main) await main();
