#!/usr/bin/env sh
set -eu

if ! command -v postil >/dev/null 2>&1; then
  if ! command -v cargo >/dev/null 2>&1; then
    echo "cargo is required to install the Postil reviewer CLI" >&2
    exit 127
  fi

  : "${POSTIL_REVIEWER_GIT:?POSTIL_REVIEWER_GIT is required}"
  : "${POSTIL_REVIEWER_REV:?POSTIL_REVIEWER_REV is required}"
  cargo install --git "$POSTIL_REVIEWER_GIT" --rev "$POSTIL_REVIEWER_REV" --locked --force
fi

if [ "$#" -eq 0 ]; then
  set -- review
fi

exec postil "$@"
