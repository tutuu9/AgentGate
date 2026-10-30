# Roadmap and release criteria

The current package is `0.1.0-dev.0`, an implementation preview. The first stable claim is conditional on recorded acceptance evidence, not on the presence of files or passing fake-provider tests.

## First delivery: CLI with Codex

| Milestone / future Issue      | Acceptance criteria                                                                                                                                                        |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contracts and local state     | Repository/run validation, atomic persistence, corruption refusal, exclusive lock, and preserved unpublished work have behavior tests.                                     |
| Human-approved orchestration  | Plan revisions, preparation, mandatory checks, separate review, one repair, cancellation, and checkpoint resume are tested.                                                |
| Controlled GitHub publication | Repository identity, worktree ownership, exact-tree/commit verification, explicit push, draft PR, and separately approved ordinary fallback are covered.                   |
| Native sandbox compatibility  | Real Windows and Linux allow/deny observations establish supported behavior; unavailable or failed observations block execution.                                           |
| End-to-end owner workflow     | A disposable owned repository completes Issue → plan approval → implementation → checks → review → publication approval → PR, with separate refusal and recovery examples. |
| Public contributor package    | README/examples, shared instructions, MIT license, security reporting path, templates, CI, package smoke test, and acceptance record match actual behavior.                |

The source implements the first workflow layers and their test seams. Milestones are not declared accepted until their evidence is entered in [acceptance.md](acceptance.md). Do not turn this table into fabricated completed GitHub Issues or release history.

Tracking Issues:

- [Native Windows/Linux sandbox acceptance](https://github.com/tutuu9/AgentGate/issues/1) remains open. [Real workflow/recovery acceptance](https://github.com/tutuu9/AgentGate/issues/2) is completed for the recorded Windows MXC environment. The [v0.1 CLI acceptance milestone](https://github.com/tutuu9/AgentGate/milestone/1) remains open until Linux acceptance is established.
- [Local web interface](https://github.com/tutuu9/AgentGate/issues/3) belongs to [v0.2](https://github.com/tutuu9/AgentGate/milestone/2).
- [Claude Code adapter](https://github.com/tutuu9/AgentGate/issues/4) belongs to [v0.3](https://github.com/tutuu9/AgentGate/milestone/3).

## Before a first public release

- Run `npm run check` on the release commit and obtain successful Windows/Ubuntu CI results.
- Inspect `npm pack` contents and install the tarball in a fresh directory; verify the documented command surface.
- Complete live sandbox acceptance on supported environments, recording versions and limitations without credentials.
- Complete the controlled GitHub scenario and prove that declining each approval causes no unauthorized publication.
- Exercise cancellation, changed source after checks, missing/offline prerequisites, failed review, partial publication, and resume.
- Review tracked files and package contents for credentials, auth caches, local state, logs, dependencies, and worktrees.
- Verify the actual branch-protection and private-vulnerability-reporting settings available for this repository/account.
- Have the maintainer review the changelog, choose the version, and explicitly approve any tag, release, or npm publication.

## Later iterations

1. Add a local web interface backed by the same core; keep CLI operation available.
2. Add a Claude Code adapter after checking its current supported integration/authentication terms and matching the same permission contract.
3. Expand compatibility from measured evidence: additional Codex versions, macOS or WSL, and richer offline toolchains.
4. Consider multiple tasks, queues, team use, or remote execution only when real use justifies additional state and security complexity.

GitHub Apps/webhooks, fork contributions, automatic merge/deployment, multi-agent swarms, hosted execution, paid-API fallback, and unlimited autonomous repair are outside the first release.
