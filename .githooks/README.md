# Git Hooks

Hooks are managed by the development bootstrap and live outside the worktree at
`$POSTIL_HOOKS_DIR` (default: a user config directory).

This directory contains only the committed entry points. The bootstrap script
sets `core.hooksPath` to the configured local directory when it exists.

## External hooks

| Hook | Purpose |
|------|---------|
| `pre-push` | Blocks pushes with bad author, unsigned commits, secrets, forbidden tokens, and publish-time leakage checks |
| `commit-msg` | Validates Conventional Commits format and blocks forbidden tokens |
| `pre-commit` | Runs secret scanning on staged changes |
| `forbidden-tokens.env` | Regex for forbidden tokens, sourced locally and never committed |

## Adding a new hook

1. Write the hook at `$POSTIL_HOOKS_DIR/<hook-name>` (executable)
2. Source forbidden tokens from `forbidden-tokens.env` via `$POSTIL_HOOKS_DIR`
3. Never hardcode forbidden-token patterns in any committed file
