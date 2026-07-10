# vendor/

Drop the pinned `postil` CLI binary here as `vendor/postil` before building
the Docker image. The Dockerfile copies this directory into the runtime image
at `/usr/local/bin/`, and the worker invokes it via `POSTIL_BIN`. The
Dockerfile itself never fetches a release: it fails the build if
`vendor/postil` is missing, so an unverified binary can never end up in the
image.

In deploy.yml, `vendor/postil` is populated by fetching a `postil-dev/postil-cli`
release tag (named by the `POSTIL_CLI_TAG` repo variable, default `v0.2.0`)
and verifying its Sigstore signature before the Docker build runs. The
`POSTIL_CLI_REV` build arg only records which release the binary should match,
for provenance/labels. For local/dev builds, build `postil` from source
yourself and place the binary here. Keeping the pin in one place, the image,
avoids the historical failure mode of the CLI revision drifting across the
worker, the Action, and the docs.

This directory intentionally contains no binary in source control.
