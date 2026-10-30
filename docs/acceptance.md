# Acceptance evidence

Record evidence for a specific commit and environment. Date of this initial record: **2026-10-30**. The project is an implementation preview; this document does not declare a stable release or a verified sandbox.

The maintainer explicitly deferred the live model test. Native isolation and end-to-end acceptance remain open in [Issue #1](https://github.com/tutuu9/AgentGate/issues/1) and [Issue #2](https://github.com/tutuu9/AgentGate/issues/2).

## Current evidence

| Area                                       | Observation                                                                                                                                                                                                                                                                                                | Status                                         |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Storage and safety behavior                | `node --test --test-concurrency=1 test/store.test.ts test/safety.test.ts` on Node.js 24.13.0/Windows: 23 passed, 0 failed, 1 Unix-only permission test skipped. Uses temporary files and fake secrets.                                                                                                     | Focused check passed; not full-suite evidence. |
| Full formatting/lint/typecheck/tests/build | Application commit `ec68201`: `npm run check` passed on Windows/Node.js 24.13.0, including 90 tests: 89 passed, 0 failed, 1 Unix-only permission test skipped.                                                                                                                                             | Passed locally; no real model calls.           |
| Windows and Ubuntu CI                      | Workflow configuration is included. Add actual successful run links for the candidate commit.                                                                                                                                                                                                              | Configured; not yet claimed passed.            |
| Packaged CLI                               | Application commit `ec68201`: built `agentgate-0.1.0-dev.0.tgz`, inspected all 49 entries, installed it into a fresh temporary prefix, and ran its installed `agentgate.cmd --help` successfully. Only compiled output, public documents, package metadata and the safe environment example were included. | Passed on Windows; not a release publication.  |
| Codex adapter prerequisites                | Local preflight accepted Codex 0.154.0, the configuration, disabled external integrations, and empty MCP configuration. This establishes compatibility observations, not an isolation boundary.                                                                                                            | Partial prerequisite evidence only.            |
| Live Codex sandbox                         | The native Windows sandbox setup was unavailable during the local preflight. No successful live filesystem/network isolation result was obtained. Linux acceptance has not been recorded.                                                                                                                  | Blocked; acceptance outstanding.               |
| Dedicated Codex authentication             | The fresh separate AgentGate profile has no ChatGPT login yet. Existing personal-profile authentication was not copied.                                                                                                                                                                                    | Blocked pending native user login.             |
| Real Issue-to-PR workflow                  | Use a disposable repository controlled by the tester and approve each external action explicitly.                                                                                                                                                                                                          | Pending acceptance.                            |
| Private vulnerability reporting            | Enabled and verified through the authenticated GitHub API for `tutuu9/AgentGate` on 2026-10-30.                                                                                                                                                                                                            | Enabled.                                       |
| Main branch protection                     | GitHub API confirmed required Windows/Ubuntu check contexts, up-to-date branches, PR-based changes, resolved conversations, admin enforcement, and disabled force pushes/deletion. Required external review count is zero for solo development.                                                            | Configured and API-verified on 2026-10-30.     |
| Dependency audit                           | `npm audit --json` reported zero known vulnerabilities across the installed production/development dependency graph on 2026-10-30.                                                                                                                                                                         | Passed at the time of the audit.               |

When a new change affects an area, rerun the relevant evidence. Keep historical observations attached to their versions; do not silently convert a blocked or skipped result into a pass.

## Live isolation procedure

1. Use a disposable test workspace and fake sentinel data only. Record OS, Node.js, Codex version, AgentGate commit, and native sandbox configuration.
2. Configure the dedicated Codex profile through `codex login`; do not copy auth files or publish credential output.
   On Windows, finish the native interactive sandbox setup under that same `CODEX_HOME`. The pinned CLI has no `codex sandbox setup` subcommand. The currently documented `/setup-default-sandbox` interactive flow has not yet been locally validated for this acceptance record.
3. Run `agentgate doctor --json`. Keep the sanitized summary, including every blocked result.
4. Verify that the live read-only profile can read its allowed workspace, cannot write it, cannot read the outside fake-secret file, and cannot write outside the workspace.
5. Verify that the live write profile can write the workspace while still denying the outside read/write operations.
6. Verify that credential environment values are absent and sandboxed TCP loopback/public connections fail while the controller's diagnostic external baseline is reachable.
7. Exercise an actual check command inside the approved worktree. Confirm that denied requirements stop execution and do not select full access.

If the baseline is unreachable, the native sandbox fails to launch, required fields are unsupported, or authentication is unavailable, record **blocked**. Do not infer permission enforcement from an unavailable network, a mocked executor, or a configuration file alone.

## Controlled workflow acceptance

Use a small repository and Issue that contain no private production data. Record expected and actual outcomes for:

- Plan revision and rejection; implementation must not start before approval.
- Dependency preparation refusal; saved work should be resumable.
- Successful offline lint/typecheck/test/build and read-only review.
- A failing check and a blocking review; at most one repair attempt for the run.
- A changed source tree after checks; old evidence/publication approval must be invalidated.
- An out-of-scope edit or unsupported requirement; execution must stop with work preserved.
- Cancellation and process interruption; resume must revalidate before continuing.
- Publication refusal; no push or PR creation should occur.
- Exact-commit approval followed by branch push and draft PR; record the real PR URL only after success.
- Draft unavailability, if reproducible; an ordinary PR requires a separate explicit choice.
- Failure after push or PR creation; resume must not invent completion or publish a different commit.
- Explicit cleanup of a completed published run; branch and PR remain, unpublished runs remain protected.

A real model invocation consumes the user's existing Codex allowance. Routine tests and CI do not perform these steps. A maintainer must deliberately run and review this procedure before claiming acceptance.

## Evidence entry template

```text
Date / tester:
AgentGate commit:
OS / Node.js / Codex versions:
Scenario:
Expected result:
Observed result:
Result: passed | failed | blocked | skipped
Sanitized command/output or CI/PR link:
Known limitations and follow-up Issue:
```
