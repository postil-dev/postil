# Deployment Guide

Postil is deployed as a Docker image to Fly.io.

## App

- **Name**: `postil-web`
- **Region**: `lhr`
- **Platform**: Fly Machines
- **Strategy**: rolling

## Build

Multi-stage Dockerfile using Bun:

1. `deps` — install dependencies
2. `builder` — run `next build` (output: `standalone`)
3. `runner` — copy standalone output, run as non-root user

## Health check

The app exposes `GET /api/health` which Fly hits every 30s with a 5s timeout and 10s grace period.

## Environment variables

These are set in `fly.toml` (non-secret):

| Variable | Value |
|----------|-------|
| `PORT` | `3000` |
| `NODE_ENV` | `production` |
| `NEXT_TELEMETRY_DISABLED` | `1` |

## Secrets

The following secrets must be configured via `fly secrets set`:

- `DATABASE_URL` — Postgres connection string
- `BETTER_AUTH_SECRET` — Auth cookie secret
- `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_B64`, `GITHUB_WEBHOOK_SECRET` — GitHub App credentials
- `OPENROUTER_API_KEY` — LLM provider key
- `POLAR_API_KEY` — Billing provider key
- `POSTHOG_PROJECT_TOKEN` — Analytics token
- `TRIGGER_API_KEY`, `TRIGGER_PROJECT_ID` — Background job platform

## Manual deploy

```bash
fly deploy --app postil-web
```

## CI deploy

A GitHub Actions workflow (`.github/workflows/deploy.yml`) deploys on every push to `main` and via `workflow_dispatch`. It requires a `FLY_API_TOKEN` repository secret.
