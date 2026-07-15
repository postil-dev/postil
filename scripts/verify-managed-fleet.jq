def release_group:
  [.[] | select(
    .config.metadata.fly_process_group == "web" or
    .config.metadata.fly_process_group == "worker"
  )];

release_group as $release
| [$release[] | select(.config.metadata.fly_platform_version == "v2")] as $managed
| [$managed[].config.image] | unique as $images
| [$managed[] | select(
    .config.metadata.fly_process_group == "web" and .state == "started"
  )] as $web
| [$managed[] | select(
    .config.metadata.fly_process_group == "worker"
  )] as $all_workers
| [$all_workers[] | select(.state == "started")] as $started_workers
| [$all_workers[].config.env.POSTIL_HOSTED_INFERENCE_ENABLED] | unique as $worker_modes
| {
    release_group_count: ($release | length),
    managed_count: ($managed | length),
    image_count: ($images | length),
    web_started: ($web | length),
    worker_started: ($started_workers | length),
    worker_hosted_inference_modes: $worker_modes
  } as $summary
| if (
    $summary.release_group_count == $summary.managed_count and
    $summary.managed_count >= 3 and
    $summary.image_count == 1 and
    $summary.web_started >= 2 and
    $summary.worker_started >= 1 and
    $summary.worker_hosted_inference_modes == ["0"]
  ) then
    $summary
  else
    error("managed fleet failed release activation checks")
  end
