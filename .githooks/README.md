# Git Hooks — External Management

Hooks are managed by the workspace bootstrap and live OUTSIDE the worktree at
`$PAPERCLIP_HOOKS_DIR` (default: `~/.paperclip/hooks/`).

Agents cannot edit these hooks — they are owned by the system user,
not the workspace. This directory contains only the bootstrap entry
point (`install-hooks.ts`) that sets `core.hooksPath` to the external
directory.

## External hooks

| Hook | Purpose |
|------|---------|
| `pre-push` | Blocks pushes with bad author, unsigned commits, secrets, or forbidden tokens |
| `commit-msg` | Validates Conventional Commits format + blocks forbidden tokens |
| `pre-commit` | Runs infisical secret scan on staged changes |
| `publisher-push.sh` | Hard gate wrapper for the authorized publisher agent |
| `forbidden-tokens.env` | Regex for forbidden tokens (sourced, never committed) |

## Adding a new hook

1. Write the hook at `$PAPERCLIP_HOOKS_DIR/<hook-name>` (executable)
2. Source forbidden tokens from `forbidden-tokens.env` via `$PAPERCLIP_HOOKS_DIR`
3. Never hardcode forbidden-token patterns in any committed file