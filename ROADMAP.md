# Postil Roadmap

## Near Term

- Add organization billing based on active private-repository pull-request
  authors, with separate hosted and BYOK prices. Pool hosted inference allowance
  at the organization level, disable overages by default, and require an explicit
  organization hard limit before incurring additional usage charges.
- Count the same GitHub identity separately for unrelated customer organizations
  and once across organizations consolidated under one enterprise account.
- Gate private-repository review and response work on an active subscription,
  trial, or promotional entitlement before fetching code, creating checks, or
  invoking inference. Public repositories remain independent of private-repository
  billing eligibility.
- Add verified billing contacts, billing-manager roles, payment state, invoices,
  usage alerts, in-app service notices, and clear provider-side budget guidance
  for BYOK customers.
- Run the hosted service on a free-tier-compatible PostgreSQL profile: low per-process DB pools, single-job webhook queue drains, one low-frequency worker fallback, and explicit provider docs.
- Stand up PostHog dashboards for traffic sources, docs/blog paths, install funnel events, and bot/automation breakdowns.
- Keep Prometheus metrics focused on operational health: database reachability, queue depth, stuck jobs, review outcomes, token usage, and webhook volume.

## Later

- Generalize GitHub identities into provider-linked identities, then add OIDC or
  SAML sign-in, verified domains, SCIM provisioning, enterprise account grouping,
  consolidated invoicing, and tenant audit logs. Product pages do not claim these
  capabilities until their end-to-end controls exist.
- Add a first-class queue wake mechanism if hosted traffic grows beyond the low-idle profile.
- Evaluate a non-Postgres queue only if the product needs an edge-native database/runtime migration.
- Add privacy-preserving conversion events for GitHub App install, OAuth login, org settings save, and first completed review.
- Export analytics and metrics into a long-retention warehouse only after the PostHog dashboards prove which views are worth preserving.
