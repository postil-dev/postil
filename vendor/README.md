# vendor/

Drop the pinned `postil` CLI binary here as `vendor/postil` before building
the Docker image. The Dockerfile copies this directory into the runtime image
at `/usr/local/bin/`, and the worker invokes it via `POSTIL_BIN`. The
Dockerfile itself never fetches a release: it fails the build if
`vendor/postil` is missing, so an unverified binary can never end up in the
image.

In deploy.yml, `vendor/postil` is populated by fetching the
`postil-dev/postil-cli` release named by `hostedCliRelease` in
`src/data/public-cli-release.json` and verifying its Sigstore signature before
the Docker build runs. That file is the only place the pinned release is
named. The `POSTIL_CLI_REV` build arg records the matching release for
provenance labels. For local/dev builds, build `postil` from source yourself
and place the binary here. The single checked-in authority keeps the worker,
the Action, and the documentation aligned.

This directory intentionally contains no binary in source control.
