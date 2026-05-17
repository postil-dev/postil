# Postil Agent Roster & Operating Conventions

## Agent roles and GPG keys

Every commit on `main` must be GPG-signed. Set your per-role signing key in the worktree before committing:

| Role | `user.name` | Signing key | Fingerprint |
|---|---|---|---|
| Postil Agent: CEO | `Postil Agent: CEO` | ed25519 (2026–2028) | `B7DA2AF44360F73544910A3BE67B3ED28F912C39` |
| Postil Agent: Engineer | `Postil Agent: Engineer` | ed25519 (2026–2028) | `42FFD8002C23BE6E26645B583042E9D027D54A4D` |
| Postil Agent: Publisher | `Postil Agent: Publisher` | ed25519 (2026–2028) | `E886B5929E793E5F1028ECFFE34EBF666300F324` |
| Postil Agent: Designer | `Postil Agent: Designer` | ed25519 (2026–2028) | `EA90006C90DDC61167F1CD584DC74D29019640AD` |
| Postil Agent: Watcher | `Postil Agent: Watcher` | ed25519 (2026–2028) | `EF18DEECEA90356D69B4B62D194F4214FF5E4103` |
| Operator | `Mörgæsis` | ed25519 (2026–2029) | `02E45A9532C85D4432AA048151A8809EA950397A` |

**Fallback:** `~paperclip/.gitconfig` sets `signingkey=42FFD8002C23BE6E26645B583042E9D027D54A4D` (Engineer). Override per role in the worktree.

## Commit conventions

- **Format:** [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `perf:`, `refactor:`, `docs:`, `test:`, `build:`, `ci:`, `chore:`, `style:`, `revert:`).
- **Subject:** imperative, lowercase, ≤72 characters, no trailing period.
- **No ticket IDs in the subject.** Use trailers instead.
- **Required trailers on every commit:**
  ```
  Co-Authored-By: Paperclip <noreply@paperclip.ing>
  Paperclip-Id: POSA-NNN
  ```
- `Author`/`Committer` email is always `morgaesis+git@morgaes.is`.

## Branch and PR workflow

1. **Create a feature branch from `main`.** Naming: `<type>/<short-slug>` (e.g. `feat/ci-overhaul`, `fix/sitemap-robots`).
2. **Open a PR** — direct push to `main` is blocked by the ruleset.
3. **PR description** must follow `.github/pull_request_template.md` and include `<!-- paperclip-id: <uuid> -->`.
4. **PR title** must be in Conventional Commits format, because it becomes the single squash-merge commit subject on `main`.
5. **Squash-merge only.** The PR body becomes the squash commit message.

## Hard constraints

- No `.mailmap`.
- No history rewrites after the operator-driven cleanup — forward-only.
- Assets for brand work (POSA-81) must remain in the `brand/` directory.
