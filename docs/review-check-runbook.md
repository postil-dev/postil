# Review Check Reliability Runbook

This runbook keeps the `postil/review` required check observable and recoverable.

## Monitoring

Poll `GET /api/metrics?days=1` with `Authorization: Bearer $METRICS_API_KEY` every five minutes.

Alert when any of these are true:

- `reviews.staleRunning.count > 0` for two consecutive polls.
- `reviews.successRatePct < 95` after at least 10 reviews in the window.
- `recentFailures` contains the same repository and pull request for two consecutive polls.

The stale-running signal means a review row has stayed `running` for more than 30 minutes. That normally indicates the required check was created, but the review worker or workflow completion webhook did not finish the check.

## Triage

1. Open the affected pull request and confirm whether the `postil/review` check is still pending or failed.
2. Check the Actions run attached to the pull request for the first failing job and step.
3. Compare `recentFailures[].error` with the job log. Treat the job log as authoritative when they disagree.
4. Verify that the review secret variables are present in the repository or organization settings.
5. If the check is pending but there is no active run, close it by rerunning the review workflow or pushing a no-op commit to the pull request branch.

## Rollback

Use rollback when a newly deployed review change causes repeated stale or failed required checks.

1. Revert the smallest review-related change that touched workflow dispatch, review execution, or check-run completion.
2. Deploy the revert using the normal production deployment path.
3. Rerun one affected pull request review and confirm `postil/review` completes.
4. Keep auto-merge disabled for affected repositories until one fresh review and the normal CI workflow are both green.
5. Record the failure cause, rollback commit, and confirming pull request in the incident notes.

Do not remove `postil/review` from branch protection as the first response. Only relax branch protection when the service is blocking urgent fixes and the rollback path is not available.
