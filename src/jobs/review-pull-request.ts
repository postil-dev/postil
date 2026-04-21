import { logger, task } from "@trigger.dev/sdk";
import { z } from "zod";
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

// TODO(postil): move to prompts/ once multiple prompt variants exist.
const REVIEW_PROMPT_STUB = `
You are Postil, an AI code reviewer. Review the diff at HEAD and produce
structured findings as JSON: { "summary": string, "findings": Finding[] }.
Finding = { "path": string, "line": number, "severity": "info"|"warn"|"error", "body": string }.
`.trim();

export const reviewPullRequest = task({
  id: "review-pull-request",
  maxDuration: 15 * 60,
  run: async (raw: unknown) => {
    const payload = reviewPullRequestPayload.parse(raw);
    logger.info("starting review", { payload });

    const token = await mintInstallationToken(payload.installationId);
    const driver = getSandboxDriver();

    // Spawn a sandbox that: clones the repo at headSha, runs the claude-code CLI
    // with the review prompt, and writes findings.json to stdout.
    const handle = await driver.spawn({
      image: "ghcr.io/postil-dev/reviewer:latest", // TODO(postil): publish this image
      command: [
        "/usr/local/bin/review.sh",
        payload.repoFullName,
        payload.headSha,
      ],
      env: {
        GITHUB_TOKEN: token,
        REVIEW_PROMPT: REVIEW_PROMPT_STUB,
        // ANTHROPIC_API_KEY is injected by the sandbox image via Fly secrets.
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
    // then post review via Octokit (pulls.createReview).
    const octokit = await installationOctokit(payload.installationId);
    logger.info("would post review via octokit", {
      repoFullName: payload.repoFullName,
      pullNumber: payload.pullNumber,
    });
    void octokit;

    return { ok: true };
  },
});
