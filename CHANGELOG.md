# Changelog

User-visible changes are recorded here. Versions follow semantic versioning once the public CLI/state contract is released. Entries under Unreleased are not proof that a release was published.

## Unreleased

### Added

- Local browser workflow control with token-protected loopback HTTP, separate plan/commit/ordinary-PR decisions, cancellation and resume, and bundled assets in the npm package.
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

- Preserve Linux nested Node streams and fork IPC with an offline syscall boundary, retaining filesystem restrictions and denying host network/Unix-socket access. Enable supported Linux workflows after combined native and ordinary CI acceptance, subject to live preflight and separate authentication.
- Reject Linux state placement beneath sandbox-readable runtime or worktree roots so private boundary and supervision records remain inaccessible.
- Supervise native Linux sandbox launches with private systemd user services and cgroup completion checks; preserve uncertain shutdown state and the original failure cause.
- Block Linux workflows when required runtime or live isolation checks fail; retain state after unverified native stops.
- Resolve controller npm checks once and grant Linux checks read access only to the validated npm runtime package.
- Verify sandbox writes against live and post-exit host observations, including unchanged outside canaries and actual workspace writes.
- Preserve Linux sandbox command output with real POSIX pipes while retaining the network syscall restrictions.
- Permit Linux Codex to re-execute its trusted native binary with an exact-file read grant, pin invocation to that same file, and reject executables in the worktree or controller state.
- Cancel interactive CLI work on the first Ctrl+C, including between approval prompts.
- Preserve sandbox sessions and probe fixtures when process-tree termination cannot be verified, including errors nested in causes or aggregates.
- Describe the approved objective in PR text after recovery instead of publishing an intermediate repair diagnostic as the final summary.
- Support npm and nested Node script startup inside Windows MXC with fixed symlink-preservation flags while retaining default-deny filesystem permissions.
- Preserve the actual Windows username when refreshing the native Codex sandbox; ignore caller-supplied identity overrides while continuing to exclude credentials.

### Status

- Resumed native Linux CI jointly checks lifecycle #6 and Node/network compatibility #7. Both jobs and ordinary Windows/Ubuntu CI passed for the pre-enable candidate on 2026-11-02; Windows passed an unchanged retry after an initial fixture timeout. Final-head validation is tracked in [PR #12 checks](https://github.com/tutuu9/AgentGate/pull/12/checks).
- Package version `0.1.0-dev.0` is an implementation preview. Windows MXC isolation, real Issue-to-draft-PR runs, and controlled workflow recovery passed. Linux native filesystem/network isolation, six lifecycle scenarios, captured Node streams/fork IPC, and offline toolchain diagnostics passed in the recorded environment. No authenticated Linux workflow, stable release, or public npm publication is claimed.
