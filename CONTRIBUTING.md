# Contributing

3am is maintained as a maintainer-led project.

## Before Opening a PR

- For bug fixes, include a clear reproduction and the minimal scope needed to fix it.
- For larger changes to product behavior, architecture, dependencies, or public APIs, open an issue first before sending a PR.
- PRs may be declined even if the implementation is correct. We optimize for product direction and maintainer bandwidth.

## Pull Request Expectations

- Keep changes focused. Avoid bundling unrelated refactors.
- Explain user-facing impact and any tradeoffs in the PR description.
- Add or update tests when behavior changes.
- Update docs when commands, setup, or deployment behavior changes.

## Branching

- Feature work normally targets `develop`.
- Release preparation may happen on a `release/*` branch.
- Public releases are cut from `main`.

## AI-Assisted Changes

- AI-assisted drafts are acceptable, but the submitter is responsible for correctness, licensing, and test coverage.
- When AI meaningfully helped author the change, disclose that in the PR.
