# Changelog

User-visible changes are recorded here. Versions follow semantic versioning once the public CLI/state contract is released. Entries under Unreleased are not proof that a release was published.

## Unreleased

### Added

- Local TypeScript CLI for explicit repository registration and GitHub Issue runs.
- Separate approval of a structured plan and the exact candidate commit before publication.
- Git worktrees, configured offline checks, independent read-only review, and one scoped repair attempt.
- Persistent run checkpoints, inspection/resume commands, exclusive run locking, and explicit cleanup of completed published runs.
- GitHub CLI integration for controlled branch push and draft PR creation, with separately confirmed ordinary-PR fallback.
- A Codex CLI 0.154.0 adapter and fail-closed sandbox preflight, with real-environment acceptance still outstanding.
- Explicit model and reasoning-effort options for planning, implementation, and review during `run` and `resume`.
- Behavior tests using fake providers and temporary repositories, plus Windows/Ubuntu CI configuration.

### Status

- Package version `0.1.0-dev.0` is an implementation preview. No stable release, completed live sandbox acceptance, or public npm publication is claimed.
