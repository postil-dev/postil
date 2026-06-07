# Postil

Postil is a low-noise review gate for agent-speed development.

Let agents write code. Do not let unchecked changes merge.

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://www.apache.org/licenses/LICENSE-2.0)
[![GitHub release](https://img.shields.io/badge/release-v0.1.0-blue)](https://github.com/postil-dev/postil/releases)
[![GitHub Actions](https://img.shields.io/badge/GitHub%20Actions-ready-blue?logo=githubactions)](https://github.com/postil-dev/postil/blob/main/action.yml)

This repository contains the Postil backend, website, GitHub App plumbing, and GitHub Action wrapper. The review engine itself lives in the Rust CLI at [postil-dev/postil-cli](https://github.com/postil-dev/postil-cli).

Postil reviews GitHub pull request diffs, emits merge-relevant findings, and stays out of the way when it has nothing useful to add. It is designed for teams using humans, AI coding tools, and autonomous agents together, where code can be produced faster than traditional review can safely absorb.

## Product doctrine

- Review by default, trust by evidence.
- Silence is a feature.
- Comment only when the comment can affect merge.
- Escalate consequential decisions to accountable humans.
- Turn repeated review feedback into durable guardrails.

## Run the CLI

Install the Rust reviewer:

```bash
cargo install --git https://github.com/postil-dev/postil-cli --locked --force
```

Review a pull request:

```bash
postil review --repo owner/repo --pr 123 --sha HEAD_SHA
```

The CLI reads `GITHUB_TOKEN` and `OPENROUTER_API_KEY` by default. Set `REVIEW_MODEL` or `REVIEW_MODEL_CASCADE` to choose the OpenRouter model path. Repository policy can live in `.postil.yaml`, `.coderabbit.yaml`, or `.kodo.yaml`.

## GitHub Action

Use the action when you want Postil to run as a merge gate in CI:

```yaml
name: Postil Review
on:
  pull_request:
    types: [opened, synchronize]
jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
      issues: write
      checks: write
      contents: read
    steps:
      - uses: postil-dev/postil-action@v1
        with:
          api-key: ${{ secrets.OPENROUTER_API_KEY }}
          model: moonshotai/kimi-k2.6
```

## Configuration

| Input | Required | Default | Description |
|---|---|---|---|
| `api-key` | yes |  | OpenRouter API key |
| `model` | no | `moonshotai/kimi-k2.6` | OpenRouter model name |
| `fail-on` | no | `error` | Exit 1 when a finding meets this severity (`info`, `warn`, `error`) |
| `no-inline` | no | `false` | Skip inline PR review comments |
| `config-path` | no |  | Path to optional runtime configuration file |
| `github-token` | no | `github.token` | Token for posting review comments and check runs |

For per-repo review policy, see [docs/config.md](./docs/config.md).

## Privacy

Postil reads the pull request diff and the repository configuration files needed for review. It sends that context to the model provider you configure and returns the review result. The website and hosted worker do not contain review logic.

## License

Apache-2.0.
