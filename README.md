# Postil

A low-noise pull-request review gate. Apache-2.0.

This repository is the **backend, website, GitHub App, and hosted worker** for
Postil. The review engine itself lives in
[`postil-dev/postil-cli`](https://github.com/postil-dev/postil-cli), a single
Rust binary. The GitHub Action lives in
[`postil-dev/postil-action`](https://github.com/postil-dev/postil-action).

The website at https://postil.dev runs from this repo.

## Doctrine

- Review by default, trust by evidence.
- Silence is a feature.
- Comment only when the comment can affect merge.
- Escalate consequential decisions to accountable humans.
- Turn repeated review feedback into durable guardrails.

## Architecture

```
GitHub  ──webhook──▶  postil (Next.js)
                        │ create check-run
                        │ enqueue review job (postgres)
                        ▼
                   worker pool
                        │ spawns
                        ▼
                   postil-cli (Rust)
                        │ envelope (json)
                        ├──▶  inline review + check-run
                        └──▶  reviews table + usage_events
```

The review prompt, OpenRouter call, envelope parser, finding filter, and
GitHub posting all live in `postil-cli`. The Next.js app is plumbing:
webhooks, DB, billing, dispatch, watchdog, marketing site, reports UI.

## Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 15, App Router |
| Runtime | Bun |
| Styling | Tailwind v4, brand System A |
| DB | Postgres + Drizzle |
| Auth | Better Auth (Drizzle adapter) |
| Job queue | Postgres `SELECT FOR UPDATE SKIP LOCKED` (no Trigger.dev) |
| Billing | Polar (passthrough — BYO inference key) |
| Telemetry | PostHog EU |
| Deploy | Fly.io / docker-compose |

## Local development

```bash
cp .env.example .env
# fill in DATABASE_URL and at minimum OPENROUTER_API_KEY
docker compose up -d postgres
bun install
bun db:migrate
bun dev          # web
bun run worker   # in a second terminal
```

Visit `http://localhost:3000`.

## Self-hosted

```bash
git clone https://github.com/postil-dev/postil
cd postil
cp .env.example .env       # fill in everything
export POSTIL_CLI_REV=$(cat .postil-cli-rev)
docker compose up -d
```

That's it. The CLI is baked into the runtime image at the pinned commit; there
is no `cargo install` at startup, no Trigger.dev project to configure, no
secret juggling between dispatch credentials.

See `/docs/self-hosted` on the running site for GitHub Enterprise Server
configuration and BYO model setup.

## Why a Postgres job queue instead of Trigger.dev

The previous incarnation of Postil leaned on Trigger.dev for review dispatch.
The history of the codebase contains an unusually long string of commits all
fighting the same two problems:

1. Credential thrash across `TRIGGER_SECRET_KEY`, `TRIGGER_API_KEY`,
   `TRIGGER_API_TOKEN`, `TRIGGER_ACCESS_TOKEN`, `TRIGGER_PAT`, and a separate
   `REVIEW_TOKEN_SECRET` for envelope encryption. Picking one and documenting
   it solves it forever.
2. `POSTIL_CLI_PATH` install fragility because `cargo install --git --rev` ran
   inside the Trigger build image and had to survive runtime image layering.
   Baking the CLI into the runtime image as a stage-1 build artifact solves it
   forever.

We chose Postgres + `SELECT FOR UPDATE SKIP LOCKED`. The schema, dispatch
layer, and worker are in `src/db/schema.ts`, `src/lib/dispatch.ts`, and
`src/worker/run.ts`. Three files. No service to operate.

## License

Apache-2.0.
