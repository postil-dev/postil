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
ARG POSTIL_COMPATIBLE_SOURCE_RELEASE_SHA
ARG POSTIL_RELEASE_PROTOCOL
ARG POSTIL_MANAGED_RELEASE=0

FROM oven/bun:1.3 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM oven/bun:1.3 AS build
ARG NEXT_PUBLIC_POSTHOG_HOST
ARG POSTIL_DEPLOY_SOURCE_TYPECHECKED=0
ENV NEXT_PUBLIC_POSTHOG_HOST=${NEXT_PUBLIC_POSTHOG_HOST} \
    POSTIL_DEPLOY_SOURCE_TYPECHECKED=${POSTIL_DEPLOY_SOURCE_TYPECHECKED}
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# The deploy workflow typechecks this exact source before secrets are loaded.
# Skip only the duplicate Next.js typecheck in the constrained remote image
# builder. next build needs no live environment; env is validated at boot.
RUN bun run build

FROM oven/bun:1.3 AS runtime
ARG POSTIL_CLI_REV
ARG POSTIL_RELEASE_SHA
ARG POSTIL_COMPATIBLE_SOURCE_RELEASE_SHA
ARG POSTIL_RELEASE_PROTOCOL
ARG POSTIL_MANAGED_RELEASE
LABEL org.opencontainers.image.title="postil-control-plane" \
      org.opencontainers.image.source="https://github.com/postil-dev/postil" \
      dev.postil.cli-rev="${POSTIL_CLI_REV}"
WORKDIR /app
ENV NODE_ENV=production \
    POSTIL_RELEASE_SHA=${POSTIL_RELEASE_SHA} \
    POSTIL_COMPATIBLE_SOURCE_RELEASE_SHA=${POSTIL_COMPATIBLE_SOURCE_RELEASE_SHA} \
    POSTIL_RELEASE_PROTOCOL=${POSTIL_RELEASE_PROTOCOL} \
    POSTIL_MANAGED_RELEASE=${POSTIL_MANAGED_RELEASE} \
    POSTIL_CACHE_DIR=/tmp/postil
RUN set -eu; \
    case "${POSTIL_MANAGED_RELEASE}" in \
      0) ;; \
      1) \
        printf '%s' "${POSTIL_RELEASE_SHA}" | grep -Eq '^[0-9a-f]{40}$' || { echo "ERROR: managed images require an exact target release SHA." >&2; exit 1; }; \
        printf '%s' "${POSTIL_COMPATIBLE_SOURCE_RELEASE_SHA}" | grep -Eq '^[0-9a-f]{40}$' || { echo "ERROR: managed images require an exact compatible source release SHA." >&2; exit 1; }; \
        test "${POSTIL_RELEASE_PROTOCOL}" = "additive-publication-hosted-v1" || { echo "ERROR: managed images require the additive publication and hosted protocol." >&2; exit 1; }; \
        ;; \
      *) echo "ERROR: POSTIL_MANAGED_RELEASE must be 0 or 1." >&2; exit 1 ;; \
    esac
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
RUN bun -e 'const names = ["POSTIL_MANAGED_RELEASE", "POSTIL_RELEASE_SHA", "POSTIL_COMPATIBLE_SOURCE_RELEASE_SHA", "POSTIL_RELEASE_PROTOCOL"]; await Bun.write("/etc/postil-release.json", JSON.stringify(Object.fromEntries(names.map(name => [name, process.env[name] ?? ""]))))'
RUN chown bun:bun /app
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
EXPOSE 3000
# Run the server in the container's signal-receiving process. Package-script
# wrappers can orphan the Next server when the wrapper receives SIGTERM.
# The managed wrapper prepares a monitor-only volume when needed, drops to the
# image's unprivileged application uid/gid, and forwards shutdown signals.
CMD ["bun", "scripts/start-managed-process.ts", "web"]
