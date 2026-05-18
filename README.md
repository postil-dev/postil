# 📝 Postil — AI pull request reviews

Reviews that ship with the PR. Managed at [postil.dev](https://postil.dev), or self-host under Apache-2.0.

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://www.apache.org/licenses/LICENSE-2.0)
[![GitHub release](https://img.shields.io/badge/release-v0.1.0-blue)](https://github.com/postil-dev/postil/releases)
[![GitHub Actions](https://img.shields.io/badge/GitHub%20Actions-ready-blue?logo=githubactions)](https://github.com/postil-dev/postil/blob/main/action.yml)

Postil reviews every pull request in place — one severity-ranked summary with inline suggestions, right inside GitHub. No dashboards, no context switching, no noise. Install the GitHub App and get a review on every PR within seconds. Or self-host the action under Apache-2.0 and wire your own model provider.

[Install on GitHub →](https://postil.dev)

## 30-second demo

Open any pull request in a repo that has Postil installed. You will see a single review comment with a severity-ranked summary and inline suggestions — no extra tabs, no login walls.

## How it works

- Install the GitHub App or wire the action into your repo.
- Every PR gets one summary review with severity-ranked findings.
- Open the PR and the review is inline — no separate dashboard.

## Get started

### Managed (recommended)

Go to [postil.dev](https://postil.dev) and click **Install** on the GitHub App page. Choose the repositories you want reviewed and you are done. Pricing is at [postil.dev/#pricing](https://postil.dev/#pricing).

### Self-host

Add this workflow to `.github/workflows/postil.yml`:

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
      checks: write
      contents: read
    steps:
      - uses: postil-dev/postil@v1
        with:
          api-key: ${{ secrets.OPENROUTER_API_KEY }}
          model: moonshotai/kimi-k2.6
```

Required secrets: add `OPENROUTER_API_KEY` (or the key for your model provider) in your repo's **Settings → Secrets and variables → Actions**.

## Configuration

| Input | Required | Default | Description |
|---|---|---|---|
| `api-key` | yes | — | API key for your model provider |
| `model` | no | — | Model name (e.g. `moonshotai/kimi-k2.6`) |
| `provider` | no | `openai` | Provider slug (`openai` or `anthropic`) |
| `config-path` | no | — | Path to optional configuration file |
| `github-token` | no | `github.token` | Token for posting review comments |

For a full list of options, see [`action.yml`](./action.yml).

## Privacy

Postil reads the diff and changed file contents from each PR. It sends that context to the model provider you configure and returns the review. It does not store your code, use it for training, or retain it after the review completes.

## License

Apache-2.0. Self-host all you want; you do not owe us anything.

## Links

→ [postil.dev](https://postil.dev) · → [Releases](https://github.com/postil-dev/postil/releases) · → [Changelog](https://github.com/postil-dev/postil/releases)
