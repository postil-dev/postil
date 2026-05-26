# Per-repo review config

Postil looks for a review configuration file at the root of the repository
being reviewed. The first file found (by this precedence) wins; others are
ignored.

Config exists to tune merge-relevant review, suppress noise, and turn repeated
feedback into durable guardrails. It should not be used to make Postil a style
nitpicker or a generic comment bot.

| Order | File                                       | Schema owner   |
| ----- | ------------------------------------------ | -------------- |
| 1     | `.postil.yaml`, `.postil.yml`, `.postil.json` | Postil         |
| 2     | `.coderabbit.yaml`, `.coderabbit.yml`      | CodeRabbit     |
| 3     | `.kodo.yaml`, `.kodo.yml`                  | Kodo           |
| 4     | *(none)*                                   | Built-in defaults |

Only fields Postil understands are honoured. Unknown fields are ignored, so a
single config file can serve Postil alongside the original tool.

## `.postil.yaml` schema

```yaml
# Whether Postil should review PRs in this repo.
enabled: true

# Glob patterns (relative to repo root) to exclude from review.
ignore:
  - "dist/**"
  - "**/*.snap"
  - "**/generated/**"

# Drop findings below this severity. info | warn | error
severityThreshold: info

# Hard cap on number of inline comments Postil will post per review.
maxFindings: 25

# Reviewer persona overrides.
reviewer:
  tone: neutral    # terse | neutral | verbose
  focus:
    - "security"
    - "concurrency"

# Clean reviews should normally stay silent unless your branch protection
# depends on approval reviews.
review:
  enabled: true
  onClean: skip
  autoMerge: false

# Required check names for auto-merge. If omitted, Postil asks GitHub
# branch protection for the required status checks on the PR base branch.
  requiredChecks:
    - "postil/review"
    - "Lint"
    - "Typecheck"
    - "Unit tests"
    - "Build"
    - "Docker build"
    - "Verify postil/review passed"

  # Timeout in milliseconds for GitHub mergeability and check lookups.
  autoMergeTimeoutMs: 15000
```

## CodeRabbit translation

Postil honours the following fields from `.coderabbit.yaml`:

| CodeRabbit field                    | Postil equivalent                        |
| ----------------------------------- | ---------------------------------------- |
| `reviews.path_filters` (negations)  | `ignore`                                 |

Other CodeRabbit fields are ignored; defaults apply.

## Kodo translation

Postil honours the following fields from `.kodo.yaml`:

| Kodo field     | Postil equivalent       |
| -------------- | ----------------------- |
| `exclude`      | `ignore`                |
| `severity`     | `severityThreshold`     |

## Auto-merge

When `review.autoMerge` is enabled, Postil waits for the PR review check to
finish before trying to merge. It only merges when the required checks are
green, and it keeps the `e2e` label gate active by waiting for `E2E tests`
when that label is present.

If `review.requiredChecks` is set, those check names are used directly.
Otherwise Postil asks GitHub for the branch protection required status checks
on the PR base branch. If neither source yields any required checks, Postil
skips auto-merge.

Other Kodo fields are ignored; defaults apply.

## Defaults

If no config is found, Postil applies:

```yaml
enabled: true
ignore: []
severityThreshold: info
maxFindings: 25
reviewer:
  tone: neutral
  focus: []
review:
  enabled: true
  onClean: skip
  autoMerge: false
  requiredChecks: []
  autoMergeTimeoutMs: 15000
```

## Migration note: clean reviews are silent by default

Postil now defaults `review.onClean` to `skip`. Clean reviews still complete the
`postil/review` check, but they do not post an approving pull request review.
This matches the product rule that silence is a feature.

Repositories whose branch protection or auto-merge policy requires a Postil
approval review should opt back in explicitly:

```yaml
review:
  onClean: approve
```
