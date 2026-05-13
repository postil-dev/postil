# Postil

Open-source AI pull request reviewer. Managed SaaS at postil.dev, or self-host under Apache-2.0.

## Stack

- Next.js 15 (App Router, TypeScript) on Bun
- Better Auth + @polar-sh/better-auth (billing)
- Trigger.dev v4 for durable jobs
- Drizzle ORM on Postgres (Neon in managed mode)
- GitHub App via Octokit
- PostHog (EU) for analytics, errors, logs
- Cloudflare DNS + CDN in front of Fly.io Machines
- Sandbox drivers: Fly Machines (default), E2B (stub), Docker (self-host stub)

## GitHub App permissions

Postil requires a GitHub App with the following permissions:

| Permission        | Access level | Purpose                                      |
| ----------------- | ------------ | -------------------------------------------- |
| `pull_requests`   | Read & write | Post inline review comments                  |
| `checks`          | Write        | Create and update the `postil/review` check-run |
| `contents`        | Read         | Read PR diffs and repo files                 |
| `metadata`        | Read         | Basic repo information                       |
| `issues`          | Write        | Post summary comments on PRs                 |

> **Re-consent required:** If you add or upgrade the `checks: write` permission on an existing installation, every organization that has installed the App must re-consent via the GitHub Apps settings page before the check-run can be posted.

## Local dev

```bash
bun install
cp .env.example .env.local   # fill in secrets
make db-up                   # postgres + redis
bun run db:migrate
bun run dev
```

In a second shell, `bun run trigger:dev` for the Trigger.dev worker.

## Self-host

```bash
docker compose --profile app up --build
```

See the `SandboxDriver` interface in `src/sandbox/driver.ts` if you want to plug in
your own execution backend.

## Commands

| target              | description                     |
| ------------------- | ------------------------------- |
| `bun run dev`       | Next dev server (turbopack)     |
| `bun run build`     | Production build                |
| `bun run lint`      | Biome lint                      |
| `bun run format`    | Biome format                    |
| `bun run typecheck` | TypeScript check                |
| `bun run test`      | Vitest unit tests               |
| `bun run test:e2e`  | Playwright end-to-end           |
| `make smoke`        | typecheck + lint + test + build |

## License

Apache-2.0.
