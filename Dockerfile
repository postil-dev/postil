# syntax=docker/dockerfile:1.7

# --- postil review bot ---
FROM docker.io/library/rust:1 AS postil-reviewer
WORKDIR /src
COPY reviewer-rev ./
RUN if [ -f reviewer-rev ]; then reviewer_rev="$(cat reviewer-rev)"; else reviewer_rev="f25e97bbe473d2df957453bf5439904839a2959c"; fi \
 && cargo install --git https://github.com/postil-dev/postil-reviewer --rev "$reviewer_rev" --locked

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
