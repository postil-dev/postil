# Postil Bot Runtime

Where the bot lives, how it receives webhooks, and how it executes reviews.

## Current Deployment

| Property | Value |
|----------|-------|
| App name | `postil-web` |
| Provider | Fly.io |
| Region | `lhr` |
| URL | `https://postil.dev` |
| Platform | Next.js 15 (standalone build) on Bun |
| VM | `shared-cpu-1x` / 512 MB / auto-stop enabled |
| DB | Neon PostgreSQL (pooled connection) |

## Webhook Delivery Path

GitHub App → `https://postil.dev/api/webhooks/github` → Next.js Route Handler (`src/app/api/webhooks/github/route.ts`):

1. **Signature verification:** HMAC-SHA256 with `GITHUB_WEBHOOK_SECRET`.
2. **Deduplication:** Delivery ID stored in `webhookDeliveries`; 23505 collisions return 200 immediately.
3. **Event routing:** Only `pull_request` events (`opened`, `reopened`, `synchronize`, `ready_for_review`) trigger a review.
4. **Debounce:** `synchronize` events are ignored if a review for the same PR started within 30 seconds.
5. **Check-run creation:** An `in_progress` check-run called `postil/review` is created immediately so the PR UI shows pending status.
6. **Async review:** `after()` schedules `runReview()` asynchronously so the webhook response returns well under the 10-second GitHub timeout.

## Review Execution

`src/jobs/run-review.ts` performs the actual review:

1. Loads repo-specific config (`postil.config.json`) via the GitHub API.
2. Fetches the PR diff via GitHub API (`mediaType: { format: "diff" }`).
3. Truncates diffs > 120,000 chars.
4. Calls OpenRouter (`REVIEW_MODEL`, default `moonshotai/kimi-k2.6`) with a structured JSON schema prompt.
5. Posts inline review comments and updates the check-run with `success`, `neutral`, or `failure`.

All LLM traffic exits through Fly's edge in `lhr` to OpenRouter.

## Secrets / Tokens

Required env vars (see `docs/DEPLOY.md` for full list):

- `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY_B64`, `GITHUB_WEBHOOK_SECRET` — GitHub App identity & webhooks.
- `OPENROUTER_API_KEY`, `REVIEW_MODEL` — LLM provider.
- `NEON_CONNECTION_STRING` — persistence layer.

## Observability

- **Fly logs:** `fly logs --app postil-web` streams stdout/stderr from running machines.
- **PostHog:** Events (`review_enqueued`, `review_completed`, `update_check_run`) + `captureException` on caught errors.
- **Database:** `reviews` and `webhookDeliveries` tables record every review lifecycle.

## Scaling Characteristics

- Single machine, auto-stop. Cold-start latency on webhook wake is ~2-5s until Bun/Next.js boots.
- Reviews are processed one-at-a-time per webhook because the route is synchronous and `after()` is serial within the process.
- Long LLM calls (tens of seconds) block the review loop; no queue/worker model exists today.
