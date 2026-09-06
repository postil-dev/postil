# Postil repository rules

Use additive, backward-compatible changes and minimize deployment downtime.
Keep hosted reviews available while old and new processes coexist. Preserve
active release capabilities and stored data during rollout and rollback;
verify compatibility and health before shifting traffic. Introduce new schema,
APIs, and configuration alongside existing behavior, deprecate after consumers
migrate, and remove obsolete behavior in a separate verified change. Routine
deployments do not pause hosted reviews. Redesign an incompatible rollout
before deployment and explain any unavoidable interruption to the operator.

After focused tests, coding agents run the full completed diff through the
local hosted-review harness before handoff. Use the pull request's actual base:

```sh
POSTIL_API_BASE=https://openrouter.ai/api/v1 \
POSTIL_API_FORMAT=openai-compatible \
REVIEW_MODEL=z-ai/glm-5.2 \
REVIEW_MODEL_CASCADE=z-ai/glm-5.2,openai/gpt-5.6-luna,moonshotai/kimi-k2.7-code \
POSTIL_DISABLE_SCORER=1 \
POSTIL_LLM_REQUEST_TIMEOUT_SECS=120 \
POSTIL_LLM_TOTAL_TIMEOUT_SECS=300 \
bun run review:local -- --base origin/main --head HEAD --require-clean --keep-database --repo-path .
```

The review tries Luna, then Kimi, when GLM output fails
validation. GLM stays pinned as the primary model. Request and total provider
budgets are bounded at 120 and 300 seconds.

Replace `origin/main` when the pull request targets another branch. A missing
binary or credential, provider failure, malformed response, or any surviving
finding blocks handoff and push. Install the trusted common-directory hook with
`bun run review:install-hook`; review an existing hook before using `--force`.
When Git uses a global hook that delegates to the common Git directory, verify
that wrapper first and pass `--allow-delegated-hooks-path` during installation.
When no model key is exported, the harness and installed hook load only
`OPENROUTER_API_KEY` from the `morgaesis` secrets profile.

When a completed exact review has real findings, the hook writes a private
disposition template under the common Git directory and prints its path. Add
an evidence-based `reason` of at least 40 characters and six words for every
finding, then retry with `POSTIL_LOCAL_REVIEW_DISPOSITIONS_FILE` set to that
absolute path. The retry validates the mode-0600 template against a private
mode-0600 cache bound to the exact reviewed merge base, head, stable IDs,
locations, and digest; it does not rerun model inference. Stale, partial,
additional, tampered, or location-mismatched entries fail closed. Provider,
model-output, and truncated-diff findings cannot be dispositioned. Accepted
evidence creates a private marker bound to the reviewed SHAs, configured
remote, destination ref, and observed remote tip. A dry run or failed
transport leaves the handoff intact. The marker is claimed atomically and its
cache and generated template are removed only after the exact remote ref
reports the reviewed head. Unaccepted records contain only finding IDs and
locations and remain under `.git/postil-local-review` until the matching retry
succeeds or the repository owner removes them.
