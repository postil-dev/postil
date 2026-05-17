# postil agent roster

| Agent | Role | Reports to | Capabilities |
|-------|------|------------|--------------|
| Morgan Chen (CEO) | ceo | Board | Strategy, coordination, triage, orchestration |
| Alex Kim | engineer | CEO | Full-stack, infra, CI/CD, TypeScript |
| Jordan Lee | devops | CEO | PR signing, Git ops, leak-screen, deploy author |
| Casey Park | designer | CEO | Brand strategy, visual identity, marketing assets, SVG design, color systems |
| Riley Patel | qa | CEO | Review diff, evidence capture, regression tracking |

## Model policy

> When hiring a new agent or changing an existing agent's model, default to an **open-weight** model from OpenRouter. Do not select an Anthropic, OpenAI, or Google-closed model unless the operator explicitly approves that choice in the hire/change request.

### Reasonable defaults by role

| Role | Suggested default | Rationale |
|------|-------------------|-----------|
| ceo | `meta-llama/llama-4-maverick` | Broad-capable; closest match to Sonnet for strategy/review |
| engineer | `qwen/qwen3-coder` | Specialist in code/CSS; cheaper; good for infra work |
| devops | `deepseek/deepseek-v3.1-terminus` | Strong general model; very cost-efficient; good fallback |
| designer | `meta-llama/llama-4-maverick` | Versatile for visual/UI tasks and asset generation |
| qa | `google/gemma-4-26b-a4b-it` | Lightweight, open, sufficient for review and diff analysis |

When creating or updating an agent via the Paperclip API, always set `adapterConfig.model` to the open-weight slug above (or a newer verified open-weight equivalent).

## Commit conventions

All commits must follow [Conventional Commits](https://www.conventionalcommits.org/):

- **Format**: `<type>: <description>` (lowercase, imperative, ≤72 chars, no trailing period)
- **Allowed types**: `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`, `chore`, `style`, `revert`
- **Never** put `(POSA-N)` or `(#NN)` in the subject line. Ticket references belong in `Paperclip-Id` trailers.
- **Required trailers** on every commit you create:
  ```
  Co-Authored-By: Paperclip <noreply@paperclip.ing>
  Paperclip-Id: POSA-NNN
  ```

## GPG signing keys

| Role | GNUPGHOME | Fingerprint |
|------|-----------|-------------|
| CEO | `/home/paperclip/.gnupg` | `B7DA2AF44360F73544910A3BE67B3ED28F912C39` |
| Engineer | `/home/paperclip/.gnupg` | `42FFD8002C23BE6E26645B583042E9D027D54A4D` |
| Publisher | `/home/paperclip/.gnupg` | `E886B5929E793E5F1028ECFFE34EBF666300F324` |
| Designer | `/home/paperclip/.gnupg` | `EA90006C90DDC61167F1CD584DC74D29019640AD` |
| Watcher | `/home/paperclip/.gnupg` | `EF18DEECEA90356D69B4B62D194F4214FF5E4103` |

Each worktree must set:

```ini
[user]
    name = Postil Agent: <Role>
    email = morgaesis+git@morgaes.is
    signingkey = <role fingerprint>
[commit]
    gpgsign = true
[tag]
    gpgsign = true
```

## Model policy

Open-weight models are the default for all agents. Closed (frontier-vendor) models are only used when the operator explicitly approves that choice.

> When hiring a new agent or changing an existing agent's model, default to an **open-weight** model from OpenRouter. Do not select an Anthropic, OpenAI, or Google-closed model unless the operator explicitly approves that choice in the hire/change request.

Current roster:

| Agent | Role | Model |
|---|---|---|
| Morgan Chen | CEO | `meta-llama/llama-4-maverick` |
| Alex Kim | Engineer | `qwen/qwen3-coder` |
| Jordan Lee | DevOps | `deepseek/deepseek-v3.1-terminus` |
| Casey Park | Designer | `meta-llama/llama-4-maverick` |
| Riley Patel | QA | `google/gemma-4-26b-a4b-it` |

## Branch and PR workflow

1. **Branch naming**: `feat/<short-slug>`, `fix/<short-slug>`, `ci/<short-slug>`, etc. Avoid embedding ticket IDs in branch names.
2. **Always open a PR** — direct push to `main` is blocked by the ruleset.
3. **PR title** must already be in Conventional Commits format (it becomes the squash commit subject).
4. **PR body** should include:
   ```markdown
   ## Summary
   <what changed and why>

   ## Test plan
   - [ ] ...

   <!-- paperclip-id: <issue-uuid> -->
   ```
5. **Squash-merge only.** The PR title becomes the single commit subject; the PR body becomes the squash message.
6. Author/email is always `morgaesis+git@morgaes.is`; display name may vary by role.

## Designer engagement

**Scope:** postil brand identity (POSA-81). Deliverables: brand voice document, logo system, color palette (WCAG AA verified), typography stack, GitHub App avatar, and example marketing card layouts.

**Hard constraints:**
- All assets land in `brand/` directory.
- PNG avatar must be 280x280 with transparency.
- SVGs must be viewBox-consistent and optimized.
- Never mention paperclip/hermes/morgaesis in any committed metadata.
- All work published via a single PR titled `brand: initial visual identity`.

**Workflow:**
1. CEO scopes and opens the child issue.
2. Designer works in a feature branch and opens the PR.
3. Publisher signs and pushes.
4. Watcher verifies no leaks.
5. CEO accepts or requests revision.
