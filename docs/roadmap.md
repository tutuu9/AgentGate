# Roadmap and release criteria

`0.1.0-beta.1` is the proposed first public beta. The candidate includes the Codex CLI workflow and the local browser interface. The planned distribution is an installable `.tgz` attached to a GitHub prerelease. The maintainer reviews the version, notes, artifact, and qualification results before deciding whether to publish. [Beta preparation #18](https://github.com/tutuu9/AgentGate/issues/18).

## Implemented for the beta

| Capability                   | Delivered behavior and evidence                                                                                                                                                                                                                                               |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contracts and local state    | Repository/run validation, atomic persistence, corruption refusal, an exclusive lock, and preservation of unpublished work have behavior tests.                                                                                                                               |
| Human-approved orchestration | The CLI supports plan revisions, worktree preparation, mandatory checks, independent review, one repair, cancellation, and explicit resume.                                                                                                                                   |
| GitHub publication           | The controller checks repository identity, worktree ownership, and the exact commit approved for push and draft PR creation. An ordinary PR requires a separate decision if drafts are unavailable.                                                                           |
| Local web interface          | The browser uses the same durable workflow for start, inspection, approvals, cancellation, and resume. Repository registration, check configuration, authentication, and cleanup remain CLI operations. [Web implementation #3](https://github.com/tutuu9/AgentGate/issues/3) |
| Public package               | The CLI reports the package version. CI checks the tarball contents and tests the installed launcher, bundled web assets, authenticated empty state, and shutdown on Windows and Ubuntu. [Package verification #17](https://github.com/tutuu9/AgentGate/issues/17)            |

The Windows MXC record covers real Issue-to-draft-PR runs with separate plan and exact-commit approvals. The CLI and browser records include publication refusal and recovery. The ordinary-PR fallback has fixture coverage because the disposable repositories supported draft PRs. [CLI acceptance #2](https://github.com/tutuu9/AgentGate/issues/2) and [web acceptance #9](web-acceptance.md).

All seven native acceptance criteria were fulfilled in the recorded Windows and Linux environments. The 2026-11-02 Ubuntu run verified isolation, process lifecycle, Node IPC, and offline toolchain behavior after the fixes in [#6](https://github.com/tutuu9/AgentGate/issues/6) and [#7](https://github.com/tutuu9/AgentGate/issues/7). The run used an unauthenticated profile and made no model calls. Linux workflows require successful live preflight and separate authentication. [Platform acceptance record](acceptance.md), [native CI on main](https://github.com/tutuu9/AgentGate/actions/runs/41404729439), and [Windows/Ubuntu CI](https://github.com/tutuu9/AgentGate/actions/runs/41403589070).

## First public beta qualification

The v0.1 release work includes the completed fixes for [publication credential validation #14](https://github.com/tutuu9/AgentGate/issues/14), the [development dependency advisory #15](https://github.com/tutuu9/AgentGate/issues/15), [CLI version reporting #16](https://github.com/tutuu9/AgentGate/issues/16), and [package verification #17](https://github.com/tutuu9/AgentGate/issues/17). The web interface originally tracked under v0.2 is included in this candidate. [v0.1 milestone](https://github.com/tutuu9/AgentGate/milestone/1) and [web milestone](https://github.com/tutuu9/AgentGate/milestone/2).

For the candidate commit, record `npm run check`, Windows/Ubuntu CI, relevant native evidence, full and production dependency audits, and the repository's branch-protection and private-reporting settings. Review tracked files and the pack manifest, install the tarball in a fresh prefix, and record its filename, version, SHA-256, and source commit for the publication decision. [Release checklist #18](https://github.com/tutuu9/AgentGate/issues/18).

## After the beta

1. Record an authenticated Issue-to-PR workflow on supported Linux, including publication refusal and recovery in a disposable repository. This is a follow-up for stable release and is nonblocking for the first beta. [Linux workflow #19](https://github.com/tutuu9/AgentGate/issues/19).
2. Evaluate a Claude Code adapter against the same authentication and permission contract. [Adapter #4](https://github.com/tutuu9/AgentGate/issues/4) and [v0.3 milestone](https://github.com/tutuu9/AgentGate/milestone/3).
3. Expand compatibility as measurements support additional Codex versions, macOS or WSL, and richer offline toolchains.
4. Consider queues, team use, or remote execution if real use justifies the added state and permission requirements.
