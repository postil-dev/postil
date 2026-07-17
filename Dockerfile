# Postil control plane: one image serving both the web app (Next.js) and the
# worker; docker-compose selects the command per service.
#
# The postil CLI is baked into the runtime image at a pinned revision so the
# reviewer version is an image property, not a runtime download. Production
# images MUST supply the binary via vendor/postil in the build context (see
# vendor/README.md): deploy.yml fetches the pinned release and verifies its
# Sigstore signature before writing vendor/postil, so that is the only path
# that authenticates the binary, not just checksums it. POSTIL_CLI_REV
# records the pinned postil-cli commit/tag for provenance/labels.

ARG POSTIL_CLI_REV=unpinned
ARG NEXT_PUBLIC_POSTHOG_HOST=https://eu.i.posthog.com
ARG POSTIL_RELEASE_SHA

FROM oven/bun:1.3 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM oven/bun:1.3 AS build
ARG NEXT_PUBLIC_POSTHOG_HOST
ENV NEXT_PUBLIC_POSTHOG_HOST=${NEXT_PUBLIC_POSTHOG_HOST}
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# next build needs no live environment; env is validated at boot instead.
RUN bun run build

FROM oven/bun:1.3 AS runtime
ARG POSTIL_CLI_REV
ARG POSTIL_RELEASE_SHA
LABEL org.opencontainers.image.title="postil-control-plane" \
      org.opencontainers.image.source="https://github.com/postil-dev/postil" \
      dev.postil.cli-rev="${POSTIL_CLI_REV}"
WORKDIR /app
ENV NODE_ENV=production \
    POSTIL_RELEASE_SHA=${POSTIL_RELEASE_SHA}
# The baked postil CLI (Rust) makes outbound HTTPS calls to the forge and the
# model endpoint; the slim bun image ships no root certificates, so without
# ca-certificates every review fails with "No CA certificates were loaded from
# the system". curl is kept for in-container debugging/health checks.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
COPY --chown=bun:bun --from=deps /app/node_modules ./node_modules
COPY --chown=bun:bun . .
COPY --chown=bun:bun --from=build /app/.next ./.next
# Bake the pinned postil CLI into the image. This stage only installs a
# binary that is already present at vendor/postil; it does not fetch or
# verify one itself. Production (deploy.yml) always populates vendor/postil
# after a cosign signature check before this build runs (see the header
# comment above). For local/dev builds without a signed release to hand -
# e.g. POSTIL_CLI_REV=unpinned while iterating on postil-cli - build the CLI
# yourself and drop the binary at vendor/postil (see vendor/README.md);
# there is deliberately no in-Dockerfile fallback that fetches a release
# tarball and only checksum-verifies it, since a checksum fetched from the
# same unauthenticated URL as the artifact proves transit integrity, not
# that the artifact is what postil-cli's release workflow actually
# published.
RUN set -eu; \
    if [ -f vendor/postil ]; then \
      install -m 0755 vendor/postil /usr/local/bin/postil; \
    else \
      echo "ERROR: vendor/postil is missing. Production images must be built" >&2; \
      echo "with a cosign-verified CLI binary at vendor/postil (see deploy.yml's" >&2; \
      echo "'Fetch pinned postil CLI' step and vendor/README.md). For local/dev" >&2; \
      echo "builds, place a self-built postil binary at vendor/postil; this" >&2; \
      echo "Dockerfile does not fetch or verify a release itself." >&2; \
      exit 1; \
    fi; \
    /usr/local/bin/postil --version
USER bun
EXPOSE 3000
# Run the server in the container's signal-receiving process. Package-script
# wrappers can orphan the Next server when the wrapper receives SIGTERM.
CMD ["bun", "scripts/start-web.ts"]
