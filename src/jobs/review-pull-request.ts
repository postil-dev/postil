import { logger, task } from "@trigger.dev/sdk";
import { z } from "zod";
import { env } from "@/lib/env";
import { installationOctokit, mintInstallationToken } from "@/lib/github";
import { getSandboxDriver } from "@/sandbox";

export const reviewPullRequestPayload = z.object({
  installationId: z.number().int(),
  organizationId: z.string().uuid(),
  repoFullName: z.string(),
  pullNumber: z.number().int(),
  headSha: z.string(),
});

export type ReviewPullRequestPayload = z.infer<typeof reviewPullRequestPayload>;

// Prompt passed to opencode inside the sandbox. The sandbox image
// (ghcr.io/postil-dev/reviewer) is expected to ship with opencode pre-installed
// and its OpenRouter credential provisioned via OPENROUTER_API_KEY env var.
// TODO(postil): move to prompts/review.md with versioning once stable.
const REVIEW_PROMPT = `
You are Postil, an AI code reviewer. The sandbox has already cloned the repo
at the PR head. Read the diff against the PR base and produce structured
findings as a single JSON object, written to stdout:

{
  "summary": "one paragraph summary of the PR",
  "findings": [
    { "path": "src/foo.ts", "line": 42, "severity": "info"|"warn"|"error", "body": "..." }
  ]
}

Focus on correctness, security, and obvious bugs. Do not nitpick style.
`.trim();

export const reviewPullRequest = task({
  id: "review-pull-request",
  maxDuration: 15 * 60,
  run: async (raw: unknown) => {
    const payload = reviewPullRequestPayload.parse(raw);
    logger.info("starting review", { payload, model: env.REVIEW_MODEL });

    if (!env.OPENROUTER_API_KEY) {
      throw new Error("OPENROUTER_API_KEY is not set");
    }

    const token = await mintInstallationToken(payload.installationId);
    const driver = getSandboxDriver();

    // Spawn the reviewer sandbox. Entrypoint /usr/local/bin/review.sh runs
    // inside: clones repo, checks out HEAD_SHA, invokes:
    //   opencode run -m openrouter/$REVIEW_MODEL --format json "$REVIEW_PROMPT"
    // and writes the resulting JSON envelope to stdout for us to consume.
    const handle = await driver.spawn({
      image: "ghcr.io/postil-dev/reviewer:latest", // TODO(postil): publish this image
      command: ["/usr/local/bin/review.sh"],
      env: {
        GITHUB_TOKEN: token,
        REPO_FULL_NAME: payload.repoFullName,
        HEAD_SHA: payload.headSha,
        PULL_NUMBER: String(payload.pullNumber),
        REVIEW_PROMPT,
        OPENROUTER_API_KEY: env.OPENROUTER_API_KEY,
        REVIEW_MODEL: env.REVIEW_MODEL,
      },
      timeoutMs: 12 * 60 * 1000,
      memoryMb: 2048,
    });

    const result = await handle.wait();
    logger.info("sandbox finished", { exitCode: result.exitCode });

    if (result.exitCode !== 0) {
      throw new Error(`review sandbox failed: exit=${result.exitCode}`);
    }

    // TODO(postil): parse result.stdout as the structured findings envelope,
    // then post review via Octokit (pulls.createReview) with inline comments.
    const octokit = await installationOctokit(payload.installationId);
    logger.info("would post review via octokit", {
      repoFullName: payload.repoFullName,
      pullNumber: payload.pullNumber,
    });
    void octokit;

    return { ok: true, model: env.REVIEW_MODEL };
  },
});
