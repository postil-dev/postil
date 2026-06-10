# syntax=docker/dockerfile:1.7
#
# Postil hosted image. Bakes the `postil` CLI into the runtime image at a
# pinned commit SHA. There is intentionally no `cargo install` at runtime —
# the previous incarnation's POSTIL_CLI_PATH install fragility (see commits
# 991db98, 5acd68b, 3864e7e) is the single largest source of operational pain
# in this codebase's history. We refuse to repeat it.

# ---------- Stage 1: build postil CLI from pinned commit --------------------
FROM rust:1.85-bookworm AS cli-build

ARG POSTIL_CLI_REV
ARG POSTIL_CLI_REPO=https://github.com/postil-dev/postil-cli
RUN test -n "$POSTIL_CLI_REV" || (echo "POSTIL_CLI_REV is required" && exit 1)

WORKDIR /build
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates pkg-config \
 && rm -rf /var/lib/apt/lists/*
RUN git clone "$POSTIL_CLI_REPO" cli \
 && cd cli \
 && git checkout "$POSTIL_CLI_REV" \
 && cargo build --release --locked

# ---------- Stage 2: build Next.js -----------------------------------------
FROM oven/bun:1.3-debian AS web-build

WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install
COPY . .
RUN bun run build

# ---------- Stage 3: runtime ----------------------------------------------
FROM oven/bun:1.3-debian AS runtime

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    POSTIL_CLI_PATH=/usr/local/bin/postil \
    PORT=3000

RUN useradd -u 10001 -m postil

WORKDIR /app
COPY --from=cli-build /build/cli/target/release/postil /usr/local/bin/postil
COPY --from=web-build /app/.next ./.next
COPY --from=web-build /app/public ./public
COPY --from=web-build /app/node_modules ./node_modules
COPY --from=web-build /app/package.json ./package.json
COPY --from=web-build /app/next.config.ts ./next.config.ts
COPY --from=web-build /app/drizzle ./drizzle
COPY --from=web-build /app/src ./src
COPY --from=web-build /app/tsconfig.json ./tsconfig.json
COPY --from=web-build /app/drizzle.config.ts ./drizzle.config.ts

USER postil
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1

CMD ["bun", "run", "start"]
