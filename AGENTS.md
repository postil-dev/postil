# How We Work

## Getting started

```bash
npm install
cp .env.example .env.local   # fill in required values
npm run dev                   # starts at http://localhost:3000
```

## Branching and pull requests

- Branch naming: `feat/<slug>`, `fix/<slug>`, `chore/<slug>`, `docs/<slug>`, `ci/<slug>`
- Open a PR for every change — direct push to `main` is blocked
- PR title must be in [Conventional Commits](https://www.conventionalcommits.org/) format (it becomes the squash commit subject)
- All commits must be GPG-signed
- Squash-merge only

### PR body style

Write the PR body like a human would in 30 seconds — plain prose, 1-4 sentences.

- No markdown headings (`## Summary`, `## Changes`, `## Test plan`, etc.)
- No horizontal dividers
- No checkbox lists (`- [x] ...`)
- No "generated-by" footers
- Testing context, if worth mentioning, weaves into the same paragraph

Good example:
> Adds a metrics endpoint at /api/metrics so we can track review reliability and token spend without hitting the DB. Auth uses a bearer-token header set via fly secrets.

Bad example:
> ## Summary
> Adds a metrics endpoint.
> ## Changes
> - New route at /api/metrics
> - Auth guard for bearer token
> ## Test plan
> - [x] Hit /api/metrics with valid token
> - [x] Verify 401 without token

CI enforces this rule — `scripts/check-pr-body.sh` fails the build if the PR body contains `## ` headings or `- [x]` checkboxes.

## Commit conventions

- **Format**: `<type>: <description>`
- **Allowed types**: `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`, `chore`, `style`, `revert`
- Subject line: lowercase, imperative, ≤72 chars, no trailing period
- Do not put issue numbers in the subject line

## Code quality

| Gate | Command | When |
|------|---------|------|
| Lint | `npm run lint` | Every commit; enforced in CI |
| Format | `npm run format` | Before committing |
| Type-check | `npm run typecheck` | Before pushing |
| Unit tests | `npm test` | Before pushing; enforced in CI |
| E2E tests | `npm run test:e2e` | PRs touching UI paths |

## CI

CI runs on every PR via GitHub Actions (`.github/workflows/ci.yml`):

- **Lint** — Biome across the full project
- **Type-check** — `tsc --noEmit`
- **Unit tests** — Vitest
- **Leakage scan** — detects internal-only content in the working tree

Additional workflows:

- **commitlint** (`.github/workflows/commitlint.yml`) — enforces Conventional Commits format in PR titles

## Style

- TypeScript with strict mode
- Biome for linting and formatting (config in `biome.json`)
- Tailwind CSS + shadcn/ui components
- Server components by default; `"use client"` only when needed