# Changelog

User-visible changes are recorded here. Versions follow semantic versioning once the public CLI/state contract is released. Entries under Unreleased are not proof that a release was published.

## Unreleased

### Added

- Local TypeScript CLI for explicit repository registration and GitHub Issue runs.
- Separate approval of a structured plan and the exact candidate commit before publication.
- Git worktrees, configured offline checks, independent read-only review, and one scoped repair attempt.
- Persistent run checkpoints, inspection/resume commands, exclusive run locking, and explicit cleanup of completed published runs.
- GitHub CLI integration for controlled branch push and draft PR creation, with separately confirmed ordinary-PR fallback.
- Platform-pinned Codex adapters (0.166.0 on Windows, 0.154.0 on Linux) and fail-closed sandbox preflight.
- Explicit offline MXC on Windows with no legacy fallback, plus individual observations for failed isolation probes.
- Explicit model and reasoning-effort options for planning, implementation, and review during `run` and `resume`.
- Behavior tests using fake providers and temporary repositories, plus Windows/Ubuntu CI configuration.

### Fixed

- Describe the approved objective in PR text after recovery instead of publishing an intermediate repair diagnostic as the final summary.
- Support npm and nested Node script startup inside Windows MXC with fixed symlink-preservation flags while retaining default-deny filesystem permissions.
- Preserve the actual Windows username when refreshing the native Codex sandbox; ignore caller-supplied identity overrides while continuing to exclude credentials.

### Status

- Package version `0.1.0-dev.0` is an implementation preview. Windows MXC isolation and a real Issue-to-draft-PR run passed; Linux and broader recovery acceptance remain open. No stable release or public npm publication is claimed.
