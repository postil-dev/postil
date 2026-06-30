# Postil Roadmap

## Near Term

- Run the hosted service on a free-tier-compatible PostgreSQL profile: low per-process DB pools, single-job webhook queue drains, one low-frequency worker fallback, and explicit provider docs.
- Stand up PostHog dashboards for traffic sources, docs/blog paths, install funnel events, and bot/automation breakdowns.
- Keep Prometheus metrics focused on operational health: database reachability, queue depth, stuck jobs, review outcomes, token usage, and webhook volume.

## Later

- Add a first-class queue wake mechanism if hosted traffic grows beyond the low-idle profile.
- Evaluate a non-Postgres queue only if the product needs an edge-native database/runtime migration.
- Add privacy-preserving conversion events for GitHub App install, OAuth login, org settings save, and first completed review.
- Export analytics and metrics into a long-retention warehouse only after the PostHog dashboards prove which views are worth preserving.
