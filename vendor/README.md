# vendor/

Drop the pinned `postil` CLI binary here as `vendor/postil` before building
the Docker image. The Dockerfile copies this directory into the runtime image
at `/usr/local/bin/`, and the worker invokes it via `POSTIL_BIN`.

In CI the binary is produced by building `postil-dev/postil-cli` at the
pinned revision (`POSTIL_CLI_REV` build arg, a full 40-hex commit SHA) and
injected into the build context; a future multi-stage build will compile it
from source in a dedicated stage instead. Keeping the pin in one place — the
image — avoids the historical failure mode of the CLI revision drifting
across the worker, the Action, and the docs.

This directory intentionally contains no binary in source control.
