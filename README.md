<p align="center">
  <img src="brand/assets/postil_logo_horizontal_lockup_tagline_ivory.svg" width="480" alt="Postil: Trust the merge, not the speed">
</p>

# Postil

Postil is a quiet AI code review gate for pull requests. It publishes findings that can change a merge decision, stays silent on clean changes, and reports gate status separately from advisory review comments.

This repository contains the hosted service at [postil.dev](https://postil.dev): the Next.js dashboard, webhook receiver, review worker, billing controls, and deployment configuration. The review engine lives in the [`postil` CLI](https://github.com/postil-dev/postil-cli), so the same review path runs locally, in CI, and through the hosted GitHub App.

## Start here

- [Install the GitHub App](https://postil.dev/install) for hosted reviews.
- [Use the CLI](https://postil.dev/docs/cli) with GitHub, GitLab, Bitbucket, or Azure DevOps.
- [Configure review policy](https://postil.dev/docs/config) in the repository.
- [Read the security model](https://postil.dev/security) before self-hosting or granting repository access.

## Repository map

| Path | Purpose |
| --- | --- |
| `src/app` | Public site, authentication, dashboard, and API routes |
| `src/worker` | Durable review and notification jobs |
| `src/monitor` | Private production monitoring and incident delivery |
| `src/lib` | GitHub, billing, policy, and persistence boundaries |
| `drizzle` | PostgreSQL schema migrations |
| `scripts` | Release, billing, verification, and operations commands |
| `tests` | Unit, integration, database, and dashboard coverage |

## Development

Postil uses Bun, Next.js, and PostgreSQL. Copy `.env.example` to `.env`, point `DATABASE_URL` at a reachable PostgreSQL database, and provide the credentials required for the path you are exercising. Then run:

```sh
bun install
bun run db:migrate
bun run operational:indexes
bun run jobs:activate-release
bun run dev
```

Run focused tests with `bun test <path>`. A production build is `bun run build`.

Operational and self-hosting requirements are documented at [postil.dev/docs/self-hosted](https://postil.dev/docs/self-hosted).

## Related repositories

- [`postil-cli`](https://github.com/postil-dev/postil-cli): review engine and local CLI
- [`postil-action`](https://github.com/postil-dev/postil-action): GitHub Action wrapper
- [`postil-sandbox`](https://github.com/postil-dev/postil-sandbox): small review fixture

Security reports belong in [GitHub private vulnerability reporting](https://github.com/postil-dev/postil/security/advisories/new), not in a public issue.
