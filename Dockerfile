# syntax=docker/dockerfile:1.7

# --- postil review bot ---
FROM docker.io/library/rust:1 AS postil-reviewer
RUN cargo install --git https://github.com/postil-dev/postil-cli --locked

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
ARG BETTER_AUTH_SECRET=build-only-auth-secret-000000000000
ARG POSTIL_COMMIT_SHA=unknown
ARG POSTIL_BUILD_TIME=unknown
ENV NEXT_TELEMETRY_DISABLED=1
ENV POSTIL_COMMIT_SHA=$POSTIL_COMMIT_SHA
ENV POSTIL_BUILD_TIME=$POSTIL_BUILD_TIME
RUN BETTER_AUTH_SECRET="$BETTER_AUTH_SECRET" bun run build

# --- runner ---
FROM docker.io/oven/bun:1.3-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ARG POSTIL_COMMIT_SHA=unknown
ARG POSTIL_BUILD_TIME=unknown
ENV POSTIL_COMMIT_SHA=$POSTIL_COMMIT_SHA
ENV POSTIL_BUILD_TIME=$POSTIL_BUILD_TIME

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
