import { closeDb, getPool } from "@/lib/db";
import { quiesceQueueForLockGeneration } from "@/lib/release-job-rollout";

async function main(): Promise<void> {
  try {
    await quiesceQueueForLockGeneration(getPool(), {
      onWait: (running) => {
        console.log(`waiting for ${running} pre-generation queue claim(s)`);
      },
    });
    console.log("queue lock-generation fence is quiescent");
  } finally {
    await closeDb();
  }
}

if (import.meta.main) await main();
