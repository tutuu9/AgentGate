# Acceptance evidence

Record evidence for a specific commit and environment. Date of this initial record: **2026-10-30**. The project is an implementation preview; this document does not declare a stable release or a verified sandbox.

The maintainer initially deferred the live model test, then authorized a Windows attempt on 2026-10-30 using a separately authenticated ChatGPT profile, GPT-6.1 Sol, and high reasoning effort. Authentication passed. After recovering a native setup ownership error, the real probes demonstrated allowed outside-file reads and loopback connections, so execution remained blocked. No model invocation occurred. Native isolation and end-to-end acceptance remain open in [Issue #1](https://github.com/tutuu9/AgentGate/issues/1) and [Issue #2](https://github.com/tutuu9/AgentGate/issues/2).

## Current evidence

| Area                                       | Observation                                                                                                                                                                                                                                                                                                | Status                                                                               |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Storage and safety behavior                | `node --test --test-concurrency=1 test/store.test.ts test/safety.test.ts` on Node.js 24.13.0/Windows: 23 passed, 0 failed, 1 Unix-only permission test skipped. Uses temporary files and fake secrets.                                                                                                     | Focused check passed; not full-suite evidence.                                       |
| Full formatting/lint/typecheck/tests/build | Application commit `ec68201`: `npm run check` passed on Windows/Node.js 24.13.0, including 90 tests: 89 passed, 0 failed, 1 Unix-only permission test skipped.                                                                                                                                             | Passed locally; no real model calls.                                                 |
| Windows and Ubuntu CI                      | Both jobs run `npm run check` and tarball installation/help checks. [PR #5 checks](https://github.com/tutuu9/AgentGate/pull/5/checks) report results for each candidate commit; the PR records the accepted run URL.                                                                                       | Consult the selected commit in CI; no model or native sandbox acceptance is implied. |
| Packaged CLI                               | Application commit `ec68201`: built `agentgate-0.1.0-dev.0.tgz`, inspected all 49 entries, installed it into a fresh temporary prefix, and ran its installed `agentgate.cmd --help` successfully. Only compiled output, public documents, package metadata and the safe environment example were included. | Passed on Windows; not a release publication.                                        |
| Codex adapter prerequisites                | Local preflight accepted Codex 0.154.0, the configuration, disabled external integrations, and empty MCP configuration. This establishes compatibility observations, not an isolation boundary.                                                                                                            | Partial prerequisite evidence only.                                                  |
| Live Codex sandbox                         | The renewed Windows probes executed but permitted outside-file reads and loopback connections. Other observed write and public-network restrictions worked. See the detailed attempt below. Linux acceptance has not been recorded.                                                                        | Blocked; no model was invoked.                                                       |
| Dedicated Codex authentication             | Renewed live preflight on 2026-10-30 confirmed ChatGPT authentication in the separate AgentGate profile. Authentication caches were not copied or printed.                                                                                                                                                 | Passed; selected-model availability has not yet been exercised.                      |
| Real Issue-to-PR workflow                  | Use a disposable repository controlled by the tester and approve each external action explicitly.                                                                                                                                                                                                          | Pending acceptance.                                                                  |
| Private vulnerability reporting            | Enabled and verified through the authenticated GitHub API for `tutuu9/AgentGate` on 2026-10-30.                                                                                                                                                                                                            | Enabled.                                                                             |
| Main branch protection                     | GitHub API confirmed required Windows/Ubuntu check contexts, up-to-date branches, PR-based changes, resolved conversations, admin enforcement, and disabled force pushes/deletion. Required external review count is zero for solo development.                                                            | Configured and API-verified on 2026-10-30.                                           |
| Dependency audit                           | `npm audit --json` reported zero known vulnerabilities across the installed production/development dependency graph on 2026-10-30.                                                                                                                                                                         | Passed at the time of the audit.                                                     |

When a new change affects an area, rerun the relevant evidence. Keep historical observations attached to their versions; do not silently convert a blocked or skipped result into a pass.

## Renewed Windows attempt: 2026-10-30

- Code commit `176f3e1`, Node.js 24.13.0, Codex CLI 0.154.0, native Windows.
- Requested model: `gpt-6.1-sol`; reasoning effort: `high`.
- `npm run check`: passed, including 96 tests (95 passed, 0 failed, 1 Unix-only permission test skipped), formatting, lint, typecheck, and build. Fake-executor tests verify explicit model selection for all three agent stages and trusted Windows identity; they do not establish account access or native isolation.
- Dedicated-profile ChatGPT authentication: passed. Native sandbox setup state was subsequently found.
- Initial native setup failed with `helper_sandbox_lock_failed` / `SetNamedSecurityInfoW sandbox dir failed: 5`. The empty `.sandbox-bin` directory was owned by Administrators and granted the normal user Modify, without permission to replace its DACL. After the maintainer closed the interactive session, the matching leftover read-ACL helper was verified and stopped; the empty directory was preserved as `.sandbox-bin.before-agentgate-repair` and recreated under the normal user. Native Codex then applied its own lockdown. No custom ACL grant, authentication-cache copy, or weaker sandbox was used.
- AgentGate had also omitted `USERNAME`; the pinned setup helper defaults to Administrators when that variable is absent. The adapter now obtains the actual username from the OS. See [the pinned setup payload](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/windows-sandbox-rs/src/setup.rs#L349).
- Actual probe observations, obtained through the real executor under the controller lock, were:

| Observation                                       | Read-only profile | Write profile | Required result                           |
| ------------------------------------------------- | ----------------- | ------------- | ----------------------------------------- |
| Read the allowed workspace file                   | Allowed           | Allowed       | Allowed                                   |
| Write in the workspace                            | Denied            | Allowed       | Denied / allowed by stage                 |
| Read the outside fake-secret file                 | **Allowed**       | **Allowed**   | Denied                                    |
| Write outside the workspace                       | Denied            | Denied        | Denied                                    |
| Connect to the controller's loopback TCP listener | **Allowed**       | **Allowed**   | Denied                                    |
| Connect to public TCP endpoint                    | Denied            | Denied        | Denied; controller baseline was reachable |
| Listed credential environment variables present   | No                | No            | No                                        |

The read failure is consistent with the pinned resolver [excluding the filesystem root from concrete deny paths](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/protocol/src/permissions.rs#L1638) while Windows uses [write-restricted tokens](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/windows-sandbox-rs/src/token.rs#L480). The precise cause of the allowed loopback connection remains unresolved. Neither the probe nor the policy was changed to hide these failed observations.

- Model execution and Issue-to-PR acceptance: not started. A passing preflight is still required.

## Live isolation procedure

1. Use a disposable test workspace and fake sentinel data only. Record OS, Node.js, Codex version, AgentGate commit, and native sandbox configuration.
2. Configure the dedicated Codex profile through `codex login`; do not copy auth files or publish credential output.
   On Windows, finish the native interactive sandbox setup under that same `CODEX_HOME`. The pinned CLI has no `codex sandbox setup` subcommand. The documented `/setup-default-sandbox` interactive flow was attempted; the failed isolation results above still block acceptance.
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
Requested model / reasoning effort:
Scenario:
Expected result:
Observed result:
Result: passed | failed | blocked | skipped
Sanitized command/output or CI/PR link:
Known limitations and follow-up Issue:
```
