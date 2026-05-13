# Deploying postil-web

This document describes the current production deployment of the Postil web application.

## Platform

- **Provider:** Fly.io
- **App name:** `postil-web`
- **Primary region:** `lhr`
- **Strategy:** Rolling deploys via `fly deploy`

## Build

- **Dockerfile:** `./Dockerfile`
- **Base image:** `oven/bun:1.3` (multi-stage build)
- **Output:** Next.js standalone build served by Bun

## Health checks

Fly performs an HTTP health check every 30 seconds:

- **Method:** `GET`
- **Path:** `/api/health`
- **Timeout:** 5 seconds
- **Grace period:** 10 seconds

The app must respond with HTTP 200 for the deploy to be considered healthy.

## Required environment variables

| Variable | Purpose | Example |
|----------|---------|---------|
| `NODE_ENV` | Runtime mode | `production` |
| `PORT` | Internal listen port | `3000` |
| `APP_URL` | Public URL of the deployment | `https://postil.dev` |
| `BETTER_AUTH_SECRET` | Auth cookie encryption | (generate with `openssl rand -hex 32`) |
| `BETTER_AUTH_URL` | Auth callback base URL | same as `APP_URL` |
| `NEON_CONNECTION_STRING` | Postgres pooled connection string | |
| `GITHUB_APP_ID` | GitHub App ID | |
| `GITHUB_APP_CLIENT_ID` | GitHub App OAuth client ID | |
| `GITHUB_APP_CLIENT_SECRET` | GitHub App OAuth secret | |
| `GITHUB_APP_PRIVATE_KEY_B64` | Base64-encoded GitHub App private key | |
| `GITHUB_WEBHOOK_SECRET` | Webhook signature verification secret | |
| `GITHUB_APP_SLUG` | GitHub App slug for install URLs | |
| `POLAR_API_KEY` | Polar billing API key | |
| `POLAR_WEBHOOK_SECRET` | Polar webhook signature secret | |
| `POLAR_ORG_ID` | Polar organization ID | |
| `POLAR_ORG_SLUG` | Polar organization slug | |
| `TRIGGER_API_KEY` | Trigger.dev API key | |
| `TRIGGER_PROJECT_ID` | Trigger.dev project ID | |
| `POSTHOG_PROJECT_TOKEN` | PostHog project API key | |
| `POSTHOG_HOST` | PostHog ingestion host | `https://eu.i.posthog.com` |
| `OPENROUTER_API_KEY` | OpenRouter API key for review LLM | |
| `REVIEW_MODEL` | Model identifier for reviews | `moonshotai/kimi-k2.6` |

## Required secrets

Set via `fly secrets set` or the Fly dashboard:

- `DATABASE_URL` or `NEON_CONNECTION_STRING`
- `GITHUB_APP_PRIVATE_KEY_B64`
- `GITHUB_APP_CLIENT_SECRET`
- `GITHUB_WEBHOOK_SECRET`
- `BETTER_AUTH_SECRET`
- `POLAR_API_KEY`
- `POLAR_WEBHOOK_SECRET`
- `TRIGGER_API_KEY`
- `POSTHOG_PROJECT_TOKEN`
- `OPENROUTER_API_KEY`

## Manual deploy

```bash
fly deploy --app postil-web
```

For CI-based deploys see `.github/workflows/deploy.yml`.

## Machine sizing

- **VM size:** `shared-cpu-1x`
- **Memory:** `512mb`
- **Min machines running:** 1
- **Auto-stop:** Enabled (stops when idle, starts on request)
