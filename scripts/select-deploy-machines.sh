#!/usr/bin/env bash

# Keep retained workers outside every runtime probe and image replacement.
read_deploy_machines() {
  local mode="${1:-verify}" machines retained expected digest baseline
  machines=$(flyctl machine list --app postil-web --json) || return 1
  retained="${RETAINED_MACHINE_IDS:-[]}"
  if ! jq -e --arg approved "${APPROVED_MACHINE_IDS}" --arg retained "$retained" --arg mode "$mode" '
    ($approved | fromjson) as $active |
    ($retained | fromjson) as $held |
    def ids: type == "array" and all(.[]; type == "string" and test("^[0-9a-f]+$")) and (unique | length) == length;
    ($active | ids and length == 5) and ($held | ids) and
    (($active + $held | unique | length) == ($active + $held | length)) and
    (type == "array") and
    (if $mode == "rollback" or $mode == "active" then
      ([.[].id] | unique | length) == length and
      all(.[]; .id as $id | ($active + $held) | index($id) != null) and
      ([.[] | select(.id as $id | $active | index($id)) | .id] | sort) == ($active | sort)
    else ([.[].id] | sort) == (($active + $held) | sort) and
    all(.[] | select(.id as $id | $held | index($id));
      .state == "stopped" and .config.metadata.fly_platform_version == "v2" and
      .config.metadata.fly_process_group == "worker") end)
  ' <<<"$machines" >/dev/null; then
    echo '::error::Fleet membership or retained worker state differs from the approved release.' >&2
    return 1
  fi
  if [[ "$mode" == rollback || "$mode" == active ]]; then
    jq -c --arg approved "${APPROVED_MACHINE_IDS}" '
      ($approved | fromjson) as $active | [.[] | select(.id as $id | $active | index($id))]
    ' <<<"$machines"
    return
  fi
  digest=$(jq -cS --arg retained "$retained" '
    ($retained | fromjson) as $held |
    [.[] | select(.id as $id | $held | index($id)) | {id, region, state, config, image_ref}] | sort_by(.id)
  ' <<<"$machines" | sha256sum) || return 1
  baseline="${RUNNER_TEMP}/postil-retained-machines.sha256"
  if [[ "$mode" == capture && ! -e "$baseline" && ! -L "$baseline" ]]; then
    (umask 077; set -o noclobber; printf '%s\n' "$digest" > "$baseline") || return 1
  fi
  if [[ ! -f "$baseline" || -L "$baseline" ]]; then
    echo '::error::Retained worker baseline is unavailable.' >&2
    return 1
  fi
  IFS= read -r expected < "$baseline" || return 1
  if [[ "$digest" != "$expected" ]]; then
    echo '::error::Retained worker configuration or image changed during release.' >&2
    return 1
  fi
  jq -c --arg approved "${APPROVED_MACHINE_IDS}" '
    ($approved | fromjson) as $active | [.[] | select(.id as $id | $active | index($id))]
  ' <<<"$machines"
}
