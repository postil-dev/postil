#!/bin/sh
# Configure git hooks path to .githooks (idempotent, safe to run in Docker).
# Skips silently when not inside a git repo (e.g. Docker build context).

if [ ! -d .git ]; then
  echo "Not a git repository — skipping hook install"
  exit 0
fi

if git config core.hooksPath .githooks 2>/dev/null; then
  echo "Git hooks path configured to .githooks"
else
  echo "Failed to configure git hooks path — skipping"
  exit 0
fi