import { closeDb, getPool } from "@/lib/db";
import type { Pool } from "pg";

type FeedbackMode = "inherit" | "enabled" | "disabled";

function feedbackMode(value: string | undefined): FeedbackMode {
  if (value === "inherit" || value === "enabled" || value === "disabled") return value;
  throw new Error("feedback mode must be inherit, enabled, or disabled");
}

function parseArguments(args: string[]): { expected: FeedbackMode; next: FeedbackMode; apply: boolean } {
  if ((args.length !== 4 && args.length !== 5) || args[0] !== "--expect" ||
      args[2] !== "--set" || (args.length === 5 && args[4] !== "--apply")) {
    throw new Error("usage: bun scripts/control-review-feedback.ts --expect MODE --set MODE [--apply]");
  }
  const expected = feedbackMode(args[1]);
  const next = feedbackMode(args[3]);
  if (expected === next) throw new Error("feedback mode must change");
  return { expected, next, apply: args.length === 5 };
}

export async function controlReviewFeedbackMode(
  pool: Pick<Pool, "query">,
  expected: FeedbackMode,
  next: FeedbackMode,
  apply: boolean,
): Promise<"dry-run" | "confirmed"> {
  const current = await pool.query<{ mode: FeedbackMode }>(
    "SELECT mode FROM review_feedback_control WHERE id = 1",
  );
  if (current.rows.length !== 1 || current.rows[0]?.mode !== expected) {
    throw new Error("feedback control state does not match the expected mode");
  }
  if (!apply) {
    return "dry-run";
  }
  const changed = await pool.query<{ mode: FeedbackMode }>(
    "UPDATE review_feedback_control SET mode = $1 WHERE id = 1 AND mode = $2 RETURNING mode",
    [next, expected],
  );
  if (changed.rows.length !== 1 || changed.rows[0]?.mode !== next) {
    throw new Error("feedback control changed concurrently; no mode transition confirmed");
  }
  const verified = await pool.query<{ mode: FeedbackMode }>(
    "SELECT mode FROM review_feedback_control WHERE id = 1",
  );
  if (verified.rows.length !== 1 || verified.rows[0]?.mode !== next) {
    throw new Error("feedback control readback did not confirm the mode transition");
  }
  return "confirmed";
}

async function main(): Promise<void> {
  const { expected, next, apply } = parseArguments(process.argv.slice(2));
  try {
    const result = await controlReviewFeedbackMode(getPool(), expected, next, apply);
    console.log(`${result} feedback mode ${expected} -> ${next}`);
  } finally {
    await closeDb();
  }
}

if (import.meta.main) {
  main().catch(() => {
    console.error("feedback control command failed; inspect the database mode before retrying");
    process.exitCode = 1;
  });
}
