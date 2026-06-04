# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Postil clean reviews now default to silent check-run completion instead of posting approval
  reviews. Repositories that require a Postil approval review in branch protection should set
  `review.onClean: approve` in `.postil.yaml`.
