# Per-repo review config

Postil looks for a review configuration file at the root of the repository
being reviewed. The first file found (by this precedence) wins; others are
ignored.

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

# Review posting and auto-merge behaviour.
review:
  enabled: true        # true | false — set false to skip the PR review (CI check-run still runs).
  on_clean: approve    # approve | comment | skip — what to do when there are no findings.
                       #   approve: post an APPROVE review with empty body.
                       #   comment: post a COMMENT review (with summary if available).
                       #   skip:    don't post a review at all.
  auto_merge: false    # true | false — when true and the review concludes clean, the bot
                       #   will attempt to squash-merge the PR immediately via the GitHub API.
                       #   Note: this bypasses branch protection; use with caution.
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
  on_clean: approve
  auto_merge: false
```
