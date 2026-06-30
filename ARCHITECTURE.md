# Postil Architecture

## Source Of Truth

- Database schema: `src/lib/db/schema.ts` and generated migrations under `drizzle/`.
- Queue semantics: `src/lib/queue.ts`; it depends on PostgreSQL row locks and `FOR UPDATE SKIP LOCKED`.
- Job execution: `src/worker/runner.ts` owns claimed-job execution shared by the long-running worker and webhook-triggered web drains.
- Hosted runtime configuration: `fly.toml` plus secrets injected by Infisical/Fly.
- Public privacy posture: `src/app/privacy/page.tsx`.
- Self-hosting and operating guidance: `src/app/docs/self-hosted/page.tsx`.

## Database

Postil is PostgreSQL-native. The hosted control plane uses enums, `jsonb`, `bytea`, identity columns, and row-lock queue claims. Neon Free and Supabase Free are viable because they preserve PostgreSQL compatibility. Cloudflare D1, Turso/libSQL, and other SQLite-style services are not drop-in replacements; adopting them requires a schema and queue rewrite.

The free-tier operating profile keeps Postgres idle-capable by avoiding permanent hot polling. Webhook intake enqueues work and can trigger a bounded web-process drain. The worker remains a fallback with configurable idle backoff.

The watchdog shares that free-tier profile: its interval is configurable so the fallback worker does not keep a scale-to-zero database warm by checking for stuck jobs every minute during idle periods.

## Observability

The app exposes three layers:

- `/api/health` for cheap liveness without database access.
- `/api/health/dependencies` and `/api/metrics` for dependency and product-operation metrics.
- PostHog for traffic-source, campaign, pageview, and likely bot/automation analysis.

PostHog is configured for minimal capture: browser pageviews with autocapture and session replay disabled, plus server-side request events on public pages only. Events omit IP addresses, arbitrary query strings, and protected dashboard paths.
