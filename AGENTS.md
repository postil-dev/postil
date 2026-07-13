# Postil repository rules

After focused tests, coding agents run the full completed diff through the
local hosted-review harness before handoff. Use the pull request's actual base:

```sh
POSTIL_API_BASE=https://openrouter.ai/api/v1 \
POSTIL_API_FORMAT=openai-compatible \
REVIEW_MODEL=mistralai/mistral-small-3.2-24b-instruct \
REVIEW_MODEL_CASCADE=google/gemma-3-27b-it \
REVIEW_SCORER_MODEL=anthropic/claude-haiku-4.5 \
bun run review:local -- --base origin/main --head HEAD --require-clean --repo-path .
```

Replace `origin/main` when the pull request targets another branch. A missing
binary or credential, provider failure, malformed response, or any surviving
finding blocks handoff and push. Install the trusted common-directory hook with
`bun run review:install-hook`; review an existing hook before using `--force`.
When Git uses a global hook that delegates to the common Git directory, verify
that wrapper first and pass `--allow-delegated-hooks-path` during installation.
When no model key is exported, the harness and installed hook load only
`OPENROUTER_API_KEY` from the `morgaesis` secrets profile.
