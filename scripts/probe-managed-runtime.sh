# Read-only transport retries leave successful output validation to the caller.
probe_managed_runtime() {
  local attempt status output
  for attempt in 1 2 3; do
    if output=$(flyctl machine exec "$1" "$2" --app postil-web --timeout 15 2>/dev/null); then
      printf '%s' "$output"
      return 0
    else
      status=$?
    fi
    printf 'Runtime probe transport failed (attempt %s/3, exit %s).\n' "$attempt" "$status" >&2
    if (( attempt < 3 )); then
      sleep 2
    fi
  done
  return "$status"
}
