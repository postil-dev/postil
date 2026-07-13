import { closeDb, getPool } from "@/lib/db";
import {
  finalizeEscalationEmailRetirement,
  quiesceEscalationEmailJobs,
} from "@/lib/escalation-email-retirement";

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode !== "--quiesce" && mode !== "--finalize") {
    throw new Error("choose --quiesce or --finalize");
  }
  try {
    const result =
      mode === "--quiesce"
        ? await quiesceEscalationEmailJobs(getPool(), {
            onWait: (running) =>
              console.log(`waiting for ${running} in-flight escalation email job(s)`),
          })
        : await finalizeEscalationEmailRetirement(getPool());
    console.log(
      `escalation email retirement ${mode.slice(2)}: running=${result.running} ` +
        `terminalized=${result.terminalized} redacted=${result.redacted} ` +
        `cleared_organizations=${result.clearedOrganizations}`,
    );
  } finally {
    await closeDb();
  }
}

if (import.meta.main) await main();
