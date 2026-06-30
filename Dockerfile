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
ARG NEXT_PUBLIC_POSTHOG_KEY
ARG NEXT_PUBLIC_POSTHOG_HOST=https://eu.i.posthog.com

FROM oven/bun:1.3 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM oven/bun:1.3 AS build
ARG NEXT_PUBLIC_POSTHOG_KEY
ARG NEXT_PUBLIC_POSTHOG_HOST
ENV NEXT_PUBLIC_POSTHOG_KEY=${NEXT_PUBLIC_POSTHOG_KEY}
ENV NEXT_PUBLIC_POSTHOG_HOST=${NEXT_PUBLIC_POSTHOG_HOST}
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
# ca-certificates every review fails with "No CA certificates were loaded from
# the system". curl fetches the pinned CLI below.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY . .
COPY --from=build /app/.next ./.next
# Bake the pinned postil CLI into the image. Prefer a vendored binary if the
# build context carries one; otherwise fetch and checksum-verify the pinned
# release directly. The remote build context does not reliably carry an
# untracked binary, so the in-build fetch is the dependable path. Fail the
# build if neither is available rather than ship a worker that cannot review.
RUN set -eu; \
    if [ -f vendor/postil ]; then \
      install -m 0755 vendor/postil /usr/local/bin/postil; \
    elif [ -n "${POSTIL_CLI_REV}" ] && [ "${POSTIL_CLI_REV}" != "unpinned" ]; then \
      base="https://github.com/postil-dev/postil-cli/releases/download/${POSTIL_CLI_REV}"; \
      art="postil-x86_64-unknown-linux-gnu.tar.gz"; \
      curl -fsSL -o "/tmp/${art}" "${base}/${art}"; \
      curl -fsSL -o "/tmp/${art}.sha256" "${base}/${art}.sha256"; \
      (cd /tmp && sha256sum -c "${art}.sha256"); \
      tar -xzf "/tmp/${art}" -C /tmp postil; \
      install -m 0755 /tmp/postil /usr/local/bin/postil; \
      rm -f "/tmp/${art}" "/tmp/${art}.sha256" /tmp/postil; \
    else \
      echo "ERROR: no postil CLI: vendor/postil absent and POSTIL_CLI_REV unset" >&2; \
      exit 1; \
    fi; \
    /usr/local/bin/postil --version
EXPOSE 3000
# Web by default; the worker service overrides with: bun run worker
CMD ["bun", "run", "start"]
