# Changelog

User-visible changes and release notes are recorded here.

## 0.2.0-beta.2 — 2026-11-21

This beta refines the local browser interface. The workflow, CLI and providers are unchanged from `0.2.0-beta.1`.

It is published as the [GitHub prerelease `v0.2.0-beta.2`](https://github.com/tutuu9/AgentGate/releases/tag/v0.2.0-beta.2) with `agentgate-0.2.0-beta.2.tgz`. Verify its SHA-256 against the accompanying `SHA256SUMS` before installing with Node.js 24 and npm. The installed `agentgate --version` command reports `0.2.0-beta.2`. [Installation and verification](README.md#install-the-beta-tarball)

### Changed

- The browser interface follows the system dark theme, colors added, removed and hunk lines in diffs, and shows a pending decision above the start form. While a workflow runs, the start form collapses and the selected run no longer repeats the details shown in the decision.

### Fixed

- The browser layout no longer scrolls horizontally on narrow screens when the activity log or a path contains a long line.

## 0.2.0-beta.1 — 2026-11-21

This beta adds an optional Claude Code provider. Codex remains the default provider, and its behavior is unchanged.

It is published as the [GitHub prerelease `v0.2.0-beta.1`](https://github.com/tutuu9/AgentGate/releases/tag/v0.2.0-beta.1) with `agentgate-0.2.0-beta.1.tgz`. Verify its SHA-256 against the accompanying `SHA256SUMS` before installing with Node.js 24 and npm. The installed `agentgate --version` command reports `0.2.0-beta.1`. [Installation and verification](README.md#install-the-beta-tarball)

### Added

- Optional Claude Code provider for planning, implementation and review, selected with `--provider claude` or in the browser form; Codex remains the default. It requires Claude Code CLI `2.1.287` on Windows or Linux, signed in by you with your Claude subscription in a separate `claude` profile under the state home. API-key authentication is refused and there is no paid API fallback. [Claude Code provider](README.md#use-the-claude-code-provider)
- `--accept-claude-permission-boundary` and a matching browser checkbox. Claude Code has no OS-level isolation for its file tools, so AgentGate limits it to file tools inside the worktree through Claude Code's permission rules, and runs it only after this explicit, per-invocation acceptance. [ADR 009](docs/decisions.md#adr-009-claude-code-provider-behind-an-accepted-permission-boundary)
- `agentgate doctor --provider claude` reports the Claude Code version, subscription login and boundary acceptance.

Mandatory checks still run in the verified Codex sandbox. An authenticated Windows run reached a draft PR; Linux compatibility has not been recorded yet. [Acceptance evidence](docs/acceptance.md#claude-code-provider-compatibility-2026-11-21)

## 0.1.0-beta.1 — 2026-11-05

The first public beta lets you take a GitHub Issue from a local clone to a draft PR using the CLI or a private browser interface. You approve the plan and checks before implementation, then inspect the diff, check results, and independent review before authorizing publication of a specific commit. You can decline publication, keep the candidate locally, and resume the run later.

It is published as the [GitHub prerelease `v0.1.0-beta.1`](https://github.com/tutuu9/AgentGate/releases/tag/v0.1.0-beta.1) with `agentgate-0.1.0-beta.1.tgz`. Verify its SHA-256 against the accompanying `SHA256SUMS` before installing with Node.js 24 and npm. The installed `agentgate --version` command reports `0.1.0-beta.1`. [Installation and verification](README.md#install-the-beta-tarball)

Issue workflows require GitHub CLI login for the controller, a separate ChatGPT login for pinned Codex, and passing live `agentgate doctor` checks. Prepare project dependencies in the worktree before the agent runs. Repository commands run offline, while the controller needs connectivity for GitHub operations and the model requires access to its service. [Setup and prerequisites](README.md#requirements)

- **Windows** uses Codex CLI `0.166.0` on an MXC-capable host. Authenticated CLI and browser runs reached real draft PRs. Recorded scenarios include publication refusal and recovery after a lost publication response. [Windows workflow evidence](docs/acceptance.md) · [Browser evidence](docs/web-acceptance.md)
- **Linux** uses Codex CLI `0.154.0` on supported Ubuntu 24.04 x86_64 with bubblewrap 0.9, Python 3.12, systemd 255 user services and cgroup v2. Native checks cover isolation, process shutdown, Node streams and IPC, and offline toolchain commands. Those checks ran without model credentials. An authenticated Linux Issue-to-PR run remains a follow-up. [Linux evidence](docs/acceptance.md) · [Issue #19](https://github.com/tutuu9/AgentGate/issues/19)

Report suspected vulnerabilities privately through [GitHub private vulnerability reporting](https://github.com/tutuu9/AgentGate/security/advisories/new).

### Added

- `--version` and a help banner that read the CLI's own package metadata, available offline without authentication or state initialization.
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

- Clean build output before packaging, validate tarball contents, and verify installed command launchers on Windows and Ubuntu, including CLI startup through npm's Unix symlink.
- Resolve the minimatch development-toolchain advisory with a version-bounded override to 11.0.4 and real ESLint/TypeScript compatibility coverage.
- Validate publication credentials consistently across configuration formats while preserving explicit examples and environment references; reject sensitive changes before staging or publication.
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

### Preview acceptance history

- All seven native Windows/Linux acceptance criteria in #1 are fulfilled after merging #6 and #7. [Native acceptance on main](https://github.com/tutuu9/AgentGate/actions/runs/41404729439) and [ordinary Windows/Ubuntu CI](https://github.com/tutuu9/AgentGate/actions/runs/41403589070) passed at `fab2054` on 2026-11-02. Historical failed candidates and the unchanged Windows retry remain recorded separately.
- During the `0.1.0-dev.0` preview, Windows MXC isolation, real Issue-to-draft-PR runs, and controlled workflow recovery passed. Linux native filesystem/network isolation, six lifecycle scenarios, captured Node streams/fork IPC, and offline toolchain diagnostics passed in the recorded environment.
