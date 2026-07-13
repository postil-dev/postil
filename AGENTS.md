# Postil repository rules

After focused tests, coding agents run the full completed diff through the
local hosted-review harness before handoff. Use the pull request's actual base:

```sh
POSTIL_API_BASE=https://openrouter.ai/api/v1 \
POSTIL_API_FORMAT=openai-compatible \
REVIEW_MODEL=openai/gpt-5-mini \
REVIEW_MODEL_CASCADE=openai/gpt-5-mini \
POSTIL_DISABLE_SCORER=1 \
bun run review:local -- --base origin/main --head HEAD --require-clean --repo-path .
```

The repeated model ID deliberately resolves to a one-model chain. An empty
cascade variable retains the CLI's embedded defaults.

Replace `origin/main` when the pull request targets another branch. A missing
binary or credential, provider failure, malformed response, or any surviving
finding blocks handoff and push. Install the trusted common-directory hook with
`bun run review:install-hook`; review an existing hook before using `--force`.
When Git uses a global hook that delegates to the common Git directory, verify
that wrapper first and pass `--allow-delegated-hooks-path` during installation.
When no model key is exported, the harness and installed hook load only
`OPENROUTER_API_KEY` from the `morgaesis` secrets profile.

An integrator may disposition verified false positives by setting
`POSTIL_LOCAL_REVIEW_DISPOSITIONS_FILE` to an absolute, non-symlink JSON file.
The document has exactly `baseSha`, `headSha`, and `findings`; `baseSha` is the
reviewed merge base, and `findings` maps every stable finding ID to its exact
`path`, `line`, and an evidence-based `reason` of at least 40 characters and
six words. Stale, partial, additional, or location-mismatched entries fail
closed. Provider, model-output, and truncated-diff findings cannot be
dispositioned.
