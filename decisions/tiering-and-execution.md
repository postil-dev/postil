# Tiering and Execution Provider Proposal

## Free tier: GitHub Actions runner

### End-to-end flow

1. Customer installs the Postil GitHub App and grants repository access.
2. Customer adds `.github/workflows/postil-review.yml` to their repo.
3. On every PR, the workflow checks out the code, calls our action, and the action:
   - Fetches the diff via GitHub API.
   - Sends the diff to OpenRouter.
   - Posts inline comments and updates the `postil/review` check-run.

### Ownership boundaries

| Concern | Postil | Customer |
|---|---|---|
| Compute | — | GitHub Actions runner (their existing quota) |
| Code access | Diff only via GitHub API | Full repo checkout in their runner |
| Secrets | GitHub App credentials, OpenRouter key | `GITHUB_TOKEN` (auto-injected) |
| Network egress | OpenRouter API call | GitHub API + OpenRouter API |
| Logs | None (action stdout only) | Their CI logs |

### Where secrets sit

- `GITHUB_TOKEN` — auto-injected by GitHub Actions, scoped to the repo.
- Postil’s OpenRouter key — lives in our backend, never exposed to the customer runner.
- GitHub App private key — lives in our backend, used to mint installation tokens.

## Paid tier: isolated managed execution

### Problem the free tier cannot solve

- Customers running on self-hosted or shared GitHub Actions runners may not want to send their full diff to a third-party LLM from an environment they don’t fully control.
- Heavy reviews (large diffs, many files) can exhaust the customer’s GitHub Actions minute quota.
- No centralized audit log or retry logic across many repos.

### Candidate providers

| Provider | Ephemeral by default | Pull-based | Egress controls | Per-tenant isolation | Billing model | OSS-friendly pricing |
|---|---|---|---|---|---|---|
| **trigger.dev** | Yes (tasks spin up, run, die) | Yes (we enqueue a job, their worker pulls) | Yes (custom egress rules per env) | Yes (project-scoped) | Pay-per-run + small monthly platform fee | Yes (generous free tier, OSS sponsorship) |
| **Modal** | Yes (functions are cold-started) | No (push-invoked) | Limited | Yes (workspace isolation) | Pay-per-second | Moderate (no free tier for sustained use) |
| **Fly Machines** | Yes ( Machines start/stop fast) | No (direct API call) | Yes (private networking) | Yes (per-app) | Pay-per-second, no monthly minimum | Yes (free allowances) |
| **Daytona** | Yes (dev environments are ephemeral) | No (SSH/API driven) | Limited | Yes (workspace per repo) | Seat-based + usage | No (enterprise focus, no OSS tier) |

### Recommendation: trigger.dev

trigger.dev is the best fit because it is the only provider that combines **pull-based execution** (we enqueue a review job, their worker pulls it, eliminating the need for us to maintain outbound network reachability into customer infrastructure) with **true ephemeral-by-default tasks** and **OSS-friendly pricing**. The project-scoped isolation maps naturally to a one-project-per-customer model, and the small platform fee is offset by the per-run pricing being competitive with raw compute. Fly Machines is a close second but requires us to build our own queue and worker fleet; Modal is push-based which complicates retries and backoff; Daytona is over-built and seat-priced for this use case.

## Migration path: free ↔ paid

### Design principle

A single configuration switch, not a fork of the action.

### Code changes

1. **Action input**
   Add an optional input to `.github/workflows/postil-review.yml`:
   ```yaml
   with:
     execution_mode: ${{ vars.POSTIL_EXECUTION_MODE || 'inline' }}
   ```
   Values: `inline` (default, free) or `managed` (paid).

2. **Action logic**
   - `inline`: the action runs the review directly in the GitHub Actions runner (today’s behavior).
   - `managed`: the action sends the diff metadata to Postil’s backend, which enqueues a trigger.dev job. The job runs in our isolated environment, posts the check-run and comments via the GitHub App, and returns.

3. **Backend endpoint**
   A new `POST /api/review/enqueue` endpoint that:
   - Validates the installation.
   - Creates a `reviews` row with `status: "queued"`.
   - Enqueues a trigger.dev task with the diff URL, repo metadata, and head SHA.

4. **No workflow fork**
   The same workflow file works for both tiers; only the `execution_mode` input changes.

## Cost model

### Assumptions

- Average review diff: ~50 kB of text.
- Average LLM output: ~500 tokens.
- OpenRouter cost (moonshotai/kimi-k2.6): ~$0.30 / 1M input tokens, ~$0.60 / 1M output tokens.
- Average input tokens per review: ~15k tokens (diff + system prompt).

### Math

| Cost component | Calculation | Per-review cost |
|---|---|---|
| OpenRouter input | 15,000 × $0.30 / 1M | $0.0045 |
| OpenRouter output | 500 × $0.60 / 1M | $0.0003 |
| **Total LLM** | | **$0.0048** |
| trigger.dev run (compute) | ~5s × shared-cpu-1x @ ~$0.0002/s | $0.0010 |
| trigger.dev platform fee | amortized over runs | $0.0005 |
| **Total execution** | | **$0.0015** |
| **Combined cost** | $0.0048 + $0.0015 | **$0.0063** |

### Margin target

We choose **N = 3×** as the margin cap. This means the price per review must stay below:

$0.0063 × 3 = **$0.0189 per review**

At this price point:
- A team doing 100 reviews/month pays ~$1.89.
- A team doing 1,000 reviews/month pays ~$18.90.
- We retain a 66 % gross margin before support and infrastructure overhead.

This is conservative enough to absorb model price increases or compute cost spikes, while remaining a trivial line item compared to the engineering time saved.
