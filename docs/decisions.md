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

**Current support:** Linux execution is enabled on the documented environment when all live preflight checks and separate authentication pass. Combined native lifecycle and Node/network compatibility checks and ordinary Windows/Ubuntu CI passed for the pre-enable candidate on 2026-11-02 using ADRs 007 and 008. This evidence contains no authenticated Linux workflow or model invocation. Native and ordinary code-quality CI remain enabled.

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

## ADR 007: Linux cgroup lifecycle ownership

**Decision:** Run each native Linux sandbox invocation under a dedicated systemd user service with a trusted Node supervisor, an explicit startup handshake, and verified cgroup completion. Require the supported Ubuntu/systemd/cgroup environment rather than silently falling back to process-group termination. Runtime performs no privileged host setup.

**Reason:** The recorded native Codex descendant escaped its launcher's process group. A service cgroup owns descendants across session changes without adding the rejected outer PID namespace or relaxing the existing filesystem/network policy.

**Consequences:** Supervisor metadata is controller-private, worker environments remain explicit, and stopped launchers or heartbeats do not establish completion. A retained failed service preserves invocation evidence until verification; its sentinel exit code is distinct from the command's result. Uncertain completion keeps the lock and runtime state. The combined #6/#7 native checks passed; supported execution still requires live preflight and separate authentication. Fake-manager tests establish orchestration behavior only; the separate native workflow supplies OS evidence.

## ADR 008: Offline Linux Node IPC without a managed proxy

**Decision:** Preserve Codex 0.154.0's restricted filesystem and isolated network namespace, and adapt its pinned bubblewrap invocation with a private, validated launcher and an inherited syscall filter. Permit anonymous Unix stream/seqpacket pairs used by Node while denying network sockets and retargetable datagram/raw pairs.

**Reason:** The original restricted filter prevents Node from inspecting and shutting down its subprocess sockets. Managed proxy mode restores streams but introduces host Unix-socket escapes and policy-dependent network decisions. A separate offline boundary avoids relying on proxy approvals, mutable allowlists, or DNS resolution.

**Consequences:** The initial implementation requires Linux x86_64, distro Python 3.12, and bubblewrap 0.9 alongside the existing supervision prerequisites. Unknown invocation shapes are rejected. The configured permission profile remains offline; only the validated inner helper's redundant network filter is suppressed after the outer boundary is fixed. State beneath broader sandbox read grants is rejected before session creation: masking a parent would also hide the read-only launcher in the pinned backend. Native stream, socket, filesystem, credential, toolchain, and lifecycle observations passed together on 2026-11-02. Linux support now depends on successful live checks rather than an unconditional platform block; no authenticated Linux workflow is claimed.

## ADR 009: Claude Code provider behind an accepted permission boundary

**Decision:** Add Claude Code as a second agent provider. Users select it explicitly with `--provider claude` or in the browser form; Codex remains the default. AgentGate launches the user's installed, unmodified Claude Code CLI, pinned to 2.1.287, in headless print mode. Users sign in to it themselves through native Claude Code login, using a separate `CLAUDE_CONFIG_DIR` under the AgentGate state home. Planning and review receive only `Read`, `Glob` and `Grep`. Implementation also receives `Edit` and `Write`, limited to the worktree. The adapter runs with `--restricted` and `dontAsk` permissions and disables permission prompts. MCP servers, hooks, slash commands and session persistence are off. Results come from `--json-schema` structured output, validated by the same Zod schemas as Codex. Claude Code has no operating-system sandbox for its file tools, so it runs only after the user explicitly accepts that boundary for the invocation. Mandatory checks still run in the verified Codex sandbox.

**Reason:** Anthropic's documentation was rechecked on 2026-11-21. The [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) and [legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) pages bar third-party products from offering Claude.ai login or routing requests through subscription credentials, and direct product developers to API keys. The same legal page says this does not prevent end users from signing in to the unmodified Claude Code binary with their own subscription. The [authentication](https://code.claude.com/docs/en/authentication) page documents subscription use in scripts. AgentGate offers no login and never reads, copies, stores or forwards Claude credentials; it launches the user's own binary. API-key authentication would contradict the rule against paid-API fallback.

The [sandboxing](https://code.claude.com/docs/en/sandboxing) page states that native Windows runs commands unsandboxed, and that on macOS, Linux and WSL2 the sandbox covers shell commands only. Claude's file tools follow permission rules instead. Removing every command-running tool therefore leaves permission rules as the effective boundary on both platforms. The maintainer accepted that tradeoff for this provider on 2026-11-21.

**Consequences:** This provider has a weaker boundary than Codex. OS-enforced outside-file read denial, network denial including loopback, and supervised descendant lifecycle cannot be established for Claude. The model process needs its normal connection to Anthropic. Process shutdown relies on controller tree termination, without Linux cgroup supervision.

Doctor reports `claude-permission-boundary` as blocked unless the user accepts the boundary. An unverified version, a missing login or any API-key source (including `apiKeySource`) blocks execution. Agent environments contain only infrastructure variables and the separate Claude profile. `--bare`, which requires API keys, is never used.

Fake-provider tests cover orchestration only. An offline Windows observation with 2.1.287 and an unauthenticated profile confirmed the version, the authentication-status contract, flag acceptance and the failed-result envelope. On the same day an authenticated Windows run reached a draft PR, and direct probes showed outside-directory `Read`, `Write`, `Grep` and `Glob` denied. Linux compatibility has not been run. A residual terms question remains: the consumer terms restrict automated access unless Anthropic explicitly permits it. Revisit this decision if Anthropic's terms or Claude Code's sandbox scope change.
