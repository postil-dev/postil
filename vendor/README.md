# vendor/

Drop the pinned `postil` CLI binary here as `vendor/postil` before building
the Docker image. The Dockerfile copies this directory into the runtime image
at `/usr/local/bin/`, and the worker invokes it via `POSTIL_BIN`.

In CI the binary is fetched from a `postil-dev/postil-cli` release tag named
by the `POSTIL_CLI_REV` build arg. A future multi-stage build can compile from
source in a dedicated stage if commit-SHA pins become useful again. Keeping the
pin in one place, the image, avoids the historical failure mode of the CLI
revision drifting across the worker, the Action, and the docs.

This directory intentionally contains no binary in source control.
