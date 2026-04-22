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
```
