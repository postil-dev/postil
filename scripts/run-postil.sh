#!/usr/bin/env sh
set -eu

if ! command -v postil >/dev/null 2>&1; then
  if ! command -v cargo >/dev/null 2>&1; then
    echo "cargo is required to install the Postil CLI" >&2
    exit 127
  fi
  if ! command -v git >/dev/null 2>&1; then
    echo "git is required to verify the Postil CLI revision" >&2
    exit 127
  fi

  : "${POSTIL_CLI_GIT:?POSTIL_CLI_GIT is required}"
  : "${POSTIL_CLI_REV:?POSTIL_CLI_REV is required}"

  checkout_dir=$(mktemp -d)
  cleanup() {
    rm -rf "$checkout_dir"
  }
  trap cleanup EXIT HUP INT TERM

  git -C "$checkout_dir" init -q
  git -C "$checkout_dir" fetch --depth 1 "$POSTIL_CLI_GIT" "$POSTIL_CLI_REV"
  fetched_rev=$(git -C "$checkout_dir" rev-parse FETCH_HEAD)
  if [ "$fetched_rev" != "$POSTIL_CLI_REV" ]; then
    echo "fetched Postil CLI revision did not match POSTIL_CLI_REV" >&2
    exit 1
  fi
  git -C "$checkout_dir" checkout --detach -q "$fetched_rev"
  cargo install --path "$checkout_dir" --locked --force
fi

case "${1-}" in
  ""|-*) set -- review "$@" ;;
esac

exec postil "$@"
