# Postil

Postil is a low-noise review gate for agent-speed development.

Let agents write code. Do not let unchecked changes merge.

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://www.apache.org/licenses/LICENSE-2.0)
[![GitHub release](https://img.shields.io/badge/release-v0.1.0-blue)](https://github.com/postil-dev/postil/releases)

This repository contains the Postil backend, website, and GitHub App plumbing.
The review CLI lives in [postil-dev/postil-cli](https://github.com/postil-dev/postil-cli),
and the GitHub Action lives in [postil-dev/postil-action](https://github.com/postil-dev/postil-action).

Postil reviews GitHub pull request diffs, emits merge-relevant findings, and
stays out of the way when it has nothing useful to add. It is designed for
teams using humans, AI coding tools, and autonomous agents together, where code
can be produced faster than traditional review can safely absorb.

## Product doctrine

- Review by default, trust by evidence.
- Silence is a feature.
- Comment only when the comment can affect merge.
- Escalate consequential decisions to accountable humans.
- Turn repeated review feedback into durable guardrails.

## Where the docs live

- Hosted app and website: this repository
- CLI and local review: [postil-dev/postil-cli](https://github.com/postil-dev/postil-cli)
- GitHub Action: [postil-dev/postil-action](https://github.com/postil-dev/postil-action)
- Repository policy: [docs/config.md](./docs/config.md)

## Privacy

Postil reads the pull request diff and the repository configuration files needed
for review. It sends that context to the model provider you configure and
returns the review result. The website and hosted worker do not contain review
logic.

## License

Apache-2.0.
