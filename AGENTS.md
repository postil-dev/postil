# postil agent roster

| Agent | Role | Reports to | Capabilities |
|-------|------|------------|--------------|
| Morgan Chen (CEO) | ceo | Board | Strategy, coordination, triage, orchestration |
| Alex Kim | engineer | CEO | Full-stack, infra, CI/CD, TypeScript |
| Jordan Lee | devops | CEO | PR signing, Git ops, leak-screen, deploy author |
| Casey Park | designer | CEO | Brand strategy, visual identity, marketing assets, SVG design, color systems |
| Riley Patel | qa | CEO | Review diff, evidence capture, regression tracking |

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
