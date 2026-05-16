# Proposal: Isolated-Container Execution

Run each review inside a fresh, short-lived container to limit blast radius from untrusted diffs and provide auditability.

## Options

### A. Trigger.dev (managed)

| Attribute | Detail |
|-----------|--------|
| Cold-start | ~500-1500 ms (kept warm by Trigger's orchestrator) |
| Isolation | Each run is a fresh Node process on a shared cluster; true container isolation is not guaranteed |
| Persistence | Trigger handles output storage and retry logic |
| Cost | Per-task pricing; scales with review volume |

Trade-offs:
- + Managed queue, retries, and observability.
- - Less isolation than a true container per review.
- - Vendor lock-in.

### B. Fly Machines (self-managed on Fly.io)

| Attribute | Detail |
|-----------|--------|
| Cold-start | ~300-800 ms if the Docker image is cached on the host |
| Isolation | One `fly machine` per review; full filesystem + network namespace |
| Persistence | None within the machine; stdout is streamed back to `postil-web` via Fly's API |
| Cost | 1 shared-cpu-1x machine × ~30-60s per review, then auto-destroy |

Architecture:
1. `postil-web` receives a webhook.
2. It calls Fly API: `POST /v1/apps/postil-runner/machines` with `config.image = postil-runner:latest`.
3. The runner image contains `@postil/cli` and a minimal Alpine/Bun runtime.
4. Machine env: `OPENROUTER_API_KEY`, `GITHUB_TOKEN`, `REPO`, `PR`, `HEAD_SHA`.
5. Machine exits when the CLI finishes.
6. `postil-web` polls Fly API for the machine exit code and stdout.
7. `postil-web` uploads the stdout (review JSON) and posts comments/check-run.

Trade-offs:
- + True per-review isolation.
- + stdout is the only egress; no persistent filesystem escape.
- + Can colocate in the same Fly region (`lhr`) for latency.
- - We pay for LLM + compute.
- - Fly Machines API is still "beta" and can change.

### C. Local Podman (self-hosted)

| Attribute | Detail |
|-----------|--------|
| Cold-start | ~1-3s if the image is pulled; 10-30s on first pull |
| Isolation | Rootless Podman pod per review |
| Persistence | None; `/tmp` is ephemeral |
| Cost | Hardware we already own |

Architecture:
- A local daemon receives a webhook event via an internal queue.
- It spawns `podman run --rm --network=slirp4netns postil-runner`.
- The container has no access to the host filesystem except a read-only bind-mount of `@postil/cli`.

Trade-offs:
- + Full control over networking and seccomp profiles.
- - Requires persistent local infrastructure.
- - Harder to scale horizontally without a Kubernetes layer.

## Comparison Matrix

| Criterion | Trigger.dev | Fly Machines | Podman |
|-----------|-------------|--------------|--------|
| Isolation strength | Medium | High | High |
| Cold-start latency | Fastest | Fast | Slowest |
| Operational burden | Lowest | Medium | Highest |
| Cost predictability | Metered | Usage-based | Fixed hardware |
| Auditability | Vendor-dependent | Strong | Strongest |

## Recommendation

Pilot **Option B (Fly Machines)** first:
- Same provider as the web app simplifies networking and secrets management.
- The `flyctl` CLI and API are already in our toolchain (see `.github/workflows/deploy.yml`).
- A single `shared-cpu-1x` machine per review is cost-effective at low volume.

If volume grows beyond ~1,000 reviews/day, evaluate migrating the runner fleet to Kubernetes with per-pod sandboxing or a managed serverless offering (e.g., AWS Fargate). Trigger.dev remains an option if we value managed retries over strict container isolation.

## Open Questions

1. How do we cache the Docker image on every Fly host to keep cold-starts sub-second?
2. Should the runner image be rebuilt on every app deploy, or pinned separately?
3. What is the fallback when Fly Machines API is unavailable or rate-limited?
