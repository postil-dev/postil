# Postil control plane: one image serving both the web app (Next.js) and the
# worker (bun run worker); docker-compose selects the command per service.
#
# The postil CLI is baked into the runtime image at a pinned revision so the
# reviewer version is an image property, not a runtime download. Supply it by
# placing the binary at vendor/postil in the build context (see
# vendor/README.md). POSTIL_CLI_REV records the pinned postil-cli commit for
# provenance/labels; a dedicated cargo build stage can replace the COPY when
# building fully from source.

ARG POSTIL_CLI_REV=unpinned

FROM oven/bun:1.3 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM oven/bun:1.3 AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# next build needs no live environment; env is validated at boot instead.
RUN bun run build

FROM oven/bun:1.3 AS runtime
ARG POSTIL_CLI_REV
LABEL org.opencontainers.image.title="postil-control-plane" \
      org.opencontainers.image.source="https://github.com/postil-dev/postil" \
      dev.postil.cli-rev="${POSTIL_CLI_REV}"
WORKDIR /app
ENV NODE_ENV=production
# The baked postil CLI (Rust) makes outbound HTTPS calls to the forge and the
# model endpoint; the slim bun image ships no root certificates, so without
# this every review fails with "No CA certificates were loaded from the system".
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY . .
COPY --from=build /app/.next ./.next
# Bake the pinned CLI (vendor/postil if provided; see vendor/README.md).
RUN if [ -f vendor/postil ]; then \
      install -m 0755 vendor/postil /usr/local/bin/postil; \
    else \
      echo "NOTE: vendor/postil not present; worker requires POSTIL_BIN at runtime"; \
    fi
EXPOSE 3000
# Web by default; the worker service overrides with: bun run worker
CMD ["bun", "run", "start"]
