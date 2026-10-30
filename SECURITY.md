# Security

AgentGate runs a coding tool and repository-controlled check commands. Windows MXC has recorded native acceptance; Linux workflows remain blocked after native cancellation and Node compatibility failures. Overall acceptance is incomplete, so this preview should not be described as a generally verified isolation product. See the version-specific [acceptance evidence](docs/acceptance.md).

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/tutuu9/AgentGate/security/advisories/new). This repository setting was enabled and verified through the authenticated GitHub API on 2026-10-30.

If that channel is unavailable, open a public Issue requesting a private reporting channel without disclosing exploit details, credentials, private code, or sensitive logs. There is no promised response-time SLA or supported stable release yet.

Include the AgentGate commit/version, operating system, Node.js and Codex versions, expected boundary, observed behavior, and a minimal reproduction using fake secrets and a disposable repository. Remove private Issue contents and unrelated filesystem paths from shared evidence.

## Intended trust boundaries

- The human chooses the repository and Issue, approves the plan/checks, and separately approves the exact commit to publish. An Issue or comment never authorizes a run by itself.
- The trusted controller owns GitHub access, Git publication, stored approvals, and process supervision. Existing `gh` authorization can be broader than the selected repository.
- The worker's Git worktree separates source changes. The native sandbox, not Git, must enforce filesystem and network restrictions on agent/check commands.
- Agent/check environments exclude controller tokens, API keys, proxies, and shell injection settings. The Codex profile is authenticated separately through native ChatGPT login; AgentGate does not copy tokens or switch to API billing.
- Repository instructions, model output, and subprocess output are untrusted. Structured responses are validated, changed paths are checked against the plan, and changed source invalidates prior review/check approval.
- External integrations are disabled by the fixed adapter configuration. Unsupported versions or settings, missing authentication, unproven isolation, and unavailable mandatory checks block execution.

The controller itself is not an untrusted-code sandbox. Do not run AgentGate as administrator merely to bypass a failing requirement. A compromised operating system, an attacker acting as the same OS user, or a compromised Git/gh/Codex binary is outside this boundary. Filesystem checks reduce accidental traversal and link attacks; they do not claim to eliminate all races with a hostile same-user process.

## Data and credentials

State under `AGENTGATE_HOME` may contain private Issue text, repository paths, plans, check output, review findings, and events. Keep it outside repositories and do not publish it. State files/directories request private Unix permissions; Windows access also depends on the user's filesystem ACLs.

Storage redacts recognized token formats, sensitive environment values, and credential fields recursively. Raw reasoning fields/events are omitted and raw Codex JSONL is discarded after parsing the final structured response. Redaction is heuristic and does not certify that arbitrary text is secret-free.

Never copy production `.env` files, SSH keys, cloud credentials, or authentication caches into worktrees. Dependency installation is a separate user action outside the agent workflow; review package lifecycle scripts before running it. Checks requiring secrets, network services, or downloads are unavailable in the current offline profile and must not be silently omitted.

Unpublished work is not automatically deleted. Explicit cleanup is limited to completed published runs and preserves the branch and PR. If a credential was exposed, revoke it with its provider and inspect every location that may contain it; removing a local log or adding a `.gitignore` rule is not sufficient.

## Validation policy

Routine tests and CI must not use real model credentials or paid APIs. Fake fixtures establish expected orchestration and error handling, not real sandbox behavior. Record live allow/deny observations separately in [docs/acceptance.md](docs/acceptance.md). A failed or unavailable observation remains blocked, and approval prompts do not substitute for enforcement.
