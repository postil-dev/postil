# Pricing Tier Sketch: Free vs Paid

A one-page model for how Postil is offered to consumers.

## Free Tier: CI-Mode

- **Who pays for the LLM?** The consumer (via their own OpenRouter or provider API key).
- **What we provide:** The `@postil/cli` package + a reusable GitHub Actions workflow.
- **Support level:** Community Discord / GitHub Issues.
- **Observability:** GitHub Actions logs only.
- **Limitations:** No hosted dashboard, no persistence, no managed queue.
- **Our cost:** Effectively $0 (we maintain the OSS packages).

## Paid Tier: Hosted Bot

- **Who pays for the LLM?** We do (pooled OpenRouter key, volume pricing).
- **What the consumer gets:**
  - Webhook-triggered reviews (no CI latency).
  - Persistent review history in a dashboard.
  - Team-level configuration and access controls.
  - Observability dashboard (review volume, latency, error rates).
  - Priority model access / higher rate limits.
- **Support level:** Dedicated support channel with SLA.
- **Our cost:** LLM tokens + Fly infrastructure + support overhead.
- **Billing model:** Per-seat or per-review volume, whichever is higher.

## Why This Split Works

| Driver | Free | Paid |
|--------|------|------|
| Trust building | OSS, auditable, no vendor lock-in | Managed, supported, polished |
| Conversion funnel | Try CI-mode → outgrow it → migrate to hosted | Immediate value for teams that don't want to manage LLM keys |
| Marginal cost to us | ~$0 | LLM + infra |
| Marginal revenue | $0 | Per-seat / volume |

## Estimated Unit Economics (Hosted Tier)

| Item | Cost per review |
|------|-----------------|
| LLM (OpenRouter, kimi-k2.6, 2500 output tokens) | ~$0.0063 |
| Fly compute (shared-cpu-1x, 60s) | ~$0.00001 |
| Neon DB (negligible per row) | ~$0.00000 |
| **Total marginal cost** | **~$0.00631** |
| 3× margin cap | $0.0189 |
| **Suggested retail price** | **$0.02 per review** or bundled in a $19/mo seat |

## Migration Path

A single config key: `execution_mode: "inline" | "managed"`.
- `inline` → CI-mode (consumer's GitHub Actions, their API key).
- `managed` → Hosted bot (our Fly app, our API key, webhook-driven).

No code changes required by the consumer; they change one line in `postil.config.json` and install the GitHub App.

## Open Questions

1. Should the free tier be rate-limited (e.g., 50 reviews/month) to encourage conversion?
2. Do we offer a "bring your own key" discount on the paid tier?
3. How does team pricing scale when a single org has 200 repos?
