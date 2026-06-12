import { and, eq } from "drizzle-orm";

import { getDb, schema } from "@/lib/db";
import { getInstallationToken } from "@/lib/github/app-auth";
import type { RespondJobPayload } from "@/lib/queue";
import { resolveLlmConfig, runCli } from "./review";

/**
 * Run one interactive bot reply: an @postil mention on a PR or issue.
 *
 * Like the review job, the worker stays thin — mint a token, set the LLM
 * environment, and let the CLI fetch context, generate the answer, and post
 * the reply. Postil only reviews and answers; it never opens PRs or pushes.
 */
export async function runRespondJob(payload: RespondJobPayload): Promise<void> {
  // A malformed row must fail loudly, not spawn the CLI with "undefined" argv.
  if (
    typeof payload.installationId !== "number" ||
    typeof payload.repoFullName !== "string" ||
    typeof payload.number !== "number" ||
    typeof payload.comment !== "string" ||
    payload.comment.trim() === ""
  ) {
    throw new Error(`respond job payload malformed: ${JSON.stringify(Object.keys(payload))}`);
  }
  const db = getDb();

  const installation = (
    await db
      .select()
      .from(schema.installations)
      .where(eq(schema.installations.githubInstallationId, payload.installationId))
      .limit(1)
  )[0];
  if (!installation || installation.suspended) {
    console.warn(`respond job skipped: installation ${payload.installationId} missing/suspended`);
    return;
  }

  const repository = (
    await db
      .select()
      .from(schema.repositories)
      .where(
        and(
          eq(schema.repositories.installationId, installation.id),
          eq(schema.repositories.fullName, payload.repoFullName),
        ),
      )
      .limit(1)
  )[0];
  if (!repository || !repository.enabled) {
    console.warn(`respond job skipped: repository ${payload.repoFullName} missing or disabled`);
    return;
  }

  const token = await getInstallationToken(payload.installationId);
  const args = [
    "respond",
    "--forge",
    "github",
    "--repo",
    payload.repoFullName,
    payload.isPr ? "--pr" : "--issue",
    String(payload.number),
  ];

  // The mention text travels via env, not argv: argv is visible in `ps` and
  // can collide with flag parsing. Review-comment mentions carry their
  // file:line anchor so the bot knows which code the question is about.
  const comment = payload.commentAnchor
    ? `(asked on \`${payload.commentAnchor}\`)\n\n${payload.comment}`
    : payload.comment;

  const llm = await resolveLlmConfig(installation.orgId);
  const cliEnv: Record<string, string> = {
    GITHUB_TOKEN: token,
    POSTIL_COMMENT: comment,
    POSTIL_API_BASE: llm.apiBase,
  };
  if (llm.apiKey) cliEnv.POSTIL_API_KEY = llm.apiKey;
  if (llm.model) cliEnv.REVIEW_MODEL = llm.model;
  if (llm.modelCascade) cliEnv.REVIEW_MODEL_CASCADE = llm.modelCascade;

  const result = await runCli(args, cliEnv);
  if (result.timedOut) {
    throw new Error("respond exceeded the CLI deadline");
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `postil respond exited with code ${result.exitCode}: ${result.stderr.slice(0, 500)}`,
    );
  }
}
