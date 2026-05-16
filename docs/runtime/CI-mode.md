# Proposal: CI-Mode Execution

Run the Postil review bot entirely inside the consumer's GitHub Actions workflow — no central server, no webhook infrastructure, zero ongoing infra cost for us.

## Concept

The bot becomes a reusable GitHub workflow:

```yaml
uses: postil-dev/postil-action/.github/workflows/review.yml@v1
with:
  model: moonshotai/kimi-k2.6
```

The workflow:
1. Checks out the PR head.
2. Fetches the diff.
3. Calls the Postil CLI (a thin wrapper around `runReview()` logic).
4. Posts review comments + check-run via the built-in `GITHUB_TOKEN`.

## API Key Sourcing

- The consumer provides their own `OPENROUTER_API_KEY` (or equivalent) as a repository secret.
- We do not hold any API keys.
- Each run is billed to the consumer's OpenRouter account.

## Threat Model

| Risk | Mitigation |
|------|-----------|
| LLM payload leaks in public CI logs | Use GitHub Actions `::add-mask::` on the raw diff before logging; never log the LLM prompt. |
| Token exfiltration from a compromised dependency | Pin every `uses:` reference to a SHA; no floating tags. |
| Unlimited spend on a high-activity repo | Consumer sets OpenRouter spend caps; we document recommended limits. |
| Prompt injection via malicious PR content | The same input-sanitization logic used in hosted mode (diff truncation, no file-system access) applies. |

## Feature Parity vs Hosted Bot

| Feature | Hosted | CI-Mode |
|---------|--------|---------|
| Webhook speed | ~2-5s (cold start) | ~5s (GHA runner boot + checkout) |
| Concurrency | Serial per machine | Parallel per runner |
| Config file (`postil.config.json`) | ✅ | ✅ (read from PR head) |
| Inline comments | ✅ | ✅ |
| Check-runs | ✅ | ✅ |
| Observability (PostHog) | ✅ | ❌ (consumer sees GHA logs only) |
| Persistence / history | ✅ (Neon DB) | ❌ |
| Superseded-review suppression | ✅ (DB debounce) | ✅ (GitHub-native check-run state) |
| Cost to us | LLM + Fly | $0 |

## Recommended Architecture

- Extract `runReview()` into a standalone package (`@postil/core`).
- Build `@postil/cli` that accepts `--diff`, `--config`, `--model`, `--token`.
- The GHA workflow simply `npm i -g @postil/cli && postil-review --pr ${{ github.event.pull_request.number }}`.
- The CLI uses the `GITHUB_TOKEN` environment variable (auto-supplied by GHA) to post comments and update check-runs.

## Open Questions

1. Should the CLI be distributed as a pre-built binary (via GitHub Releases + `curl | sh`) to avoid `npm install` latency?
2. How do we handle consumers who want both CI-mode and a hosted fallback?
3. versioning strategy: semver on the workflow repo, or a monorepo tag?
