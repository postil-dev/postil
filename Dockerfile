# syntax=docker/dockerfile:1.7

# --- postil review bot ---
FROM docker.io/library/rust:1 AS postil-reviewer
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git jq \
 && rm -rf /var/lib/apt/lists/*
COPY reviewer-rev /tmp/reviewer-rev
RUN set -eu; \
  REVIEWER_REV="$(cat /tmp/reviewer-rev)"; \
  REVIEWER_JSON="$(curl -fsSL -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/postil-dev/postil-reviewer/commits/$REVIEWER_REV")"; \
  test "$(printf '%s' "$REVIEWER_JSON" | jq -r '.sha')" = "$REVIEWER_REV"; \
  test "$(printf '%s' "$REVIEWER_JSON" | jq -r '.commit.verification.verified')" = "true"; \
  test "$(printf '%s' "$REVIEWER_JSON" | jq -r '.commit.verification.reason')" = "valid"; \
  test "$(printf '%s' "$REVIEWER_JSON" | jq -r '.author.login')" = "morgaesis"; \
  test "$(printf '%s' "$REVIEWER_JSON" | jq -r '.committer.login')" = "morgaesis"; \
  reviewer_dir="$(mktemp -d)"; \
  git -C "$reviewer_dir" init -q; \
  git -C "$reviewer_dir" remote add origin https://github.com/postil-dev/postil-reviewer; \
  git -C "$reviewer_dir" fetch --depth=1 origin "$REVIEWER_REV"; \
  git -C "$reviewer_dir" checkout --force FETCH_HEAD; \
  test "$(git -C "$reviewer_dir" rev-parse HEAD)" = "$REVIEWER_REV"; \
  cargo install --path "$reviewer_dir" --locked

# --- deps ---
FROM docker.io/oven/bun:1.3 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts

# --- builder ---
FROM docker.io/oven/bun:1.3 AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN bun run build

# --- runner ---
FROM docker.io/oven/bun:1.3-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN groupadd --system --gid 1001 nodejs \
 && useradd --system --uid 1001 --gid nodejs nextjs

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=postil-reviewer /usr/local/cargo/bin/postil /usr/local/bin/postil

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

CMD ["bun", "server.js"]
