<p align="center">
  <img src="brand/assets/postil_logo_horizontal_lockup_tagline_ivory.svg" width="480" alt="Postil: Trust the merge, not the speed">
</p>

# Postil

Postil is a code review gate for pull requests. It publishes findings that can change a merge decision, stays silent on clean changes, and reports gate status separately from advisory review comments.

This repository contains the hosted Postil service: the dashboard, webhook receiver, review worker, billing controls, and deployment configuration. The review engine is the [Postil CLI](https://github.com/postil-dev/postil-cli).

## Start here

- [Install the GitHub App](https://postil.dev/install) for hosted reviews.
- [Use the CLI](https://postil.dev/docs/cli) with GitHub, GitLab, Bitbucket, or Azure DevOps.
- [View model benchmark results](https://postil.dev/bench) and the raw report.
- [Configure review policy](https://postil.dev/docs/config) for a repository.
- [Read the self-hosted guide](https://postil.dev/docs/self-hosted) before deploying the service.
- [Read the security model](https://postil.dev/security) before granting repository access.

## Local development

Postil uses Bun, Next.js, and PostgreSQL. Copy `.env.example` to `.env`, configure a reachable PostgreSQL database and the credentials required for the path under test, then run:

```sh
bun install
bun run db:migrate
bun run operational:indexes
bun run jobs:activate-release
bun run dev
```

Run focused tests with `bun test <path>`. Build the production application with `bun run build`.

## Related repositories

- [Postil CLI](https://github.com/postil-dev/postil-cli): review engine and local CLI.
- [Postil Action](https://github.com/postil-dev/postil-action): GitHub Actions wrapper.
- [Postil Sandbox](https://github.com/postil-dev/postil-sandbox): review fixture.

Report security issues through [GitHub private vulnerability reporting](https://github.com/postil-dev/postil/security/advisories/new), not a public issue.
