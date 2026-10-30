# Design decisions

These decisions describe the implementation preview and the agreed first-user workflow. Date: 2026-10-30. A decision being recorded does not prove that its real-environment acceptance criteria have passed.

## ADR 001: Local CLI first

**Decision:** Build a Node.js 24/TypeScript CLI for the owner of explicitly registered repositories. Run one task at a time locally. Complete Issue-to-PR behavior before adding a web interface or second model provider.

**Reason:** A shared orchestration core with narrow adapters gives the first user a useful end-to-end tool without maintaining multiple interfaces or services immediately.

**Consequences:** No NestJS server, PostgreSQL/Prisma database, Redis queue, VPS, GitHub App, or webhook delivery system is required in this version. A future web interface must retain the same approvals and state invariants.

## ADR 002: Existing GitHub CLI authentication

**Decision:** Use the user's existing `gh` login in the trusted controller. Register a local clone and its exact `github.com` identity before running an Issue.

**Reason:** This reuses a familiar local authentication flow without managing another OAuth application or copying tokens into AgentGate.

**Consequences:** GitHub token permissions can be broader than the selected profile. Application-level repository checks do not reduce the token's actual GitHub scopes. Agent and check environments must exclude these credentials. A future least-privilege token or GitHub App integration is a separate change.

## ADR 003: Git worktree plus verified native sandbox

**Decision:** Create one worktree per run and use a restrictive native Codex sandbox for model tools and repository checks. Refuse execution when the required boundary cannot be established.

**Reason:** Worktrees protect the original checkout's uncommitted work; native permissions are needed to constrain filesystem/network operations. Worktrees alone are not isolation.

**Consequences:** Windows is pinned to Codex CLI 0.166.0 and explicitly selects offline MXC; Linux retains 0.154.0. The initial Windows 0.154.0 elevated attempt failed read and loopback isolation. Enumerating existing directories or weakening the probes cannot replace a default-deny boundary, so legacy Windows backends are not used. Compatibility must be revalidated before expanding the version set. The preview requires explicit authentication in a dedicated profile and has no full-access or paid-API fallback. Docker is not a mandatory dependency. Real isolation acceptance remains a release gate.

## ADR 004: Two human approvals and one repair attempt

**Decision:** Require plan/check approval before implementation and exact-commit approval before push/PR creation. Allow one repair attempt after a check failure or blocking review, within the approved scope. Review is a separate read-only Codex invocation.

**Reason:** The first user wants to remove repetitive handoffs while retaining control of both intended changes and published results. A bounded repair loop avoids indefinite consumption of subscription limits.

**Consequences:** Changed plan/check inputs revoke plan approval. Changed source revokes checks/review/publication approval. Missing checks block publication. Draft-PR unavailability requires a fresh choice before an ordinary PR. Merge and production deployment stay human actions.

## ADR 005: Local versioned files and explicit recovery

**Decision:** Store validated JSON records and redacted JSONL events outside repositories, with atomic replacement and an exclusive process lease. Keep unpublished work.

**Reason:** A single local user with one active task does not yet need a database server. Inspectable files make recovery and understanding easier.

**Consequences:** Invalid schemas are errors, not instructions to discard history. No existing lock is automatically displaced, even if the controller PID is dead, because orphan workers may remain. Crash recovery requires verified process-tree shutdown or a machine restart, a state backup, and explicit removal of only the stale lock. Schema changes need a compatibility decision or migration. Local state may include private task data even after redaction.

## ADR 006: Shared project instructions and practical Clean Code

**Decision:** Keep shared contributor instructions in `AGENTS.md`; `CLAUDE.md` imports that file. Use clear names, focused behavior, explicit boundaries, and relevant tests without line-count or abstraction quotas.

**Reason:** One source reduces divergent agent instructions and lets a human review the project's actual working agreements.

**Consequences:** A separately installed personal `clean-code` skill is optional for contributors and is not distributed as an AgentGate runtime dependency. Its advice does not authorize wider refactoring or override repository conventions.
