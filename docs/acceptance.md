# Acceptance evidence

Record evidence for a specific commit and environment. Date of this initial record: **2026-10-30**. The project is an implementation preview; this document does not declare a stable release or extend measured isolation results to untested environments.

The maintainer authorized live Windows testing on 2026-10-30 using a separately authenticated ChatGPT profile, GPT-6.1 Sol, and high reasoning effort. The initial Codex 0.154.0 legacy sandbox failed outside-file read and loopback boundaries and correctly blocked model execution. A subsequent explicit offline MXC attempt with Codex 0.166.0 passed the recorded isolation probes and completed a real Issue through planning, implementation, checks, independent review, and an explicitly approved draft PR. Linux and broader workflow acceptance remain open in [Issue #1](https://github.com/tutuu9/AgentGate/issues/1) and [Issue #2](https://github.com/tutuu9/AgentGate/issues/2).

## Current evidence

| Area                                       | Observation                                                                                                                                                                                                                                                                                                | Status                                                                                                                    |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Storage and safety behavior                | `node --test --test-concurrency=1 test/store.test.ts test/safety.test.ts` on Node.js 24.13.0/Windows: 23 passed, 0 failed, 1 Unix-only permission test skipped. Uses temporary files and fake secrets.                                                                                                     | Focused check passed; not full-suite evidence.                                                                            |
| Full formatting/lint/typecheck/tests/build | Application commit `fff93a0` plus the manual acceptance helper: `npm run check` passed on Windows/Node.js 24.13.0, including 100 tests: 99 passed, 0 failed, 1 Unix-only permission test skipped.                                                                                                          | Passed locally; routine tests use no real model calls.                                                                    |
| Windows and Ubuntu CI                      | Both jobs run `npm run check` and tarball installation/help checks. [PR #5 checks](https://github.com/tutuu9/AgentGate/pull/5/checks) report results for each candidate commit; the PR records the accepted run URL.                                                                                       | Consult the selected commit in CI; no model or native sandbox acceptance is implied.                                      |
| Packaged CLI                               | Application commit `ec68201`: built `agentgate-0.1.0-dev.0.tgz`, inspected all 49 entries, installed it into a fresh temporary prefix, and ran its installed `agentgate.cmd --help` successfully. Only compiled output, public documents, package metadata and the safe environment example were included. | Passed on Windows; not a release publication.                                                                             |
| Codex adapter prerequisites                | Current Windows preflight accepted Codex 0.166.0, explicit MXC configuration, disabled external integrations, and empty MCP configuration.                                                                                                                                                                 | Passed in the recorded Windows environment.                                                                               |
| Live Codex sandbox                         | Real doctor probes and expanded fresh-profile probes passed with offline MXC and fixed Node options. Read-only/write permissions, outside reads/writes, protected paths, IPv4/IPv6 loopback, and nested-process observations are detailed below.                                                           | Passed for the recorded Windows environment; Linux remains untested.                                                      |
| Dedicated Codex authentication             | The dedicated profile passed ChatGPT authentication. Real planning, implementation, one repair, and review used `gpt-6.1-sol` with `high` reasoning effort. Authentication caches were not copied or printed.                                                                                              | Passed for this account and invocation.                                                                                   |
| Real Issue-to-PR workflow                  | Disposable repository Issue #1 reached candidate `97067b7ae31fb800a3f9783d0279d23ed89ec62f`; its three tests passed and independent review returned no findings.                                                                                                                                           | Completed after exact-commit approval: [draft PR #2](https://github.com/tutuu9/agentgate-acceptance-20261030-mxc/pull/2). |
| Private vulnerability reporting            | Enabled and verified through the authenticated GitHub API for `tutuu9/AgentGate` on 2026-10-30.                                                                                                                                                                                                            | Enabled.                                                                                                                  |
| Main branch protection                     | GitHub API confirmed required Windows/Ubuntu check contexts, up-to-date branches, PR-based changes, resolved conversations, admin enforcement, and disabled force pushes/deletion. Required external review count is zero for solo development.                                                            | Configured and API-verified on 2026-10-30.                                                                                |
| Dependency audit                           | `npm audit --json` reported zero known vulnerabilities across the installed production/development dependency graph on 2026-10-30.                                                                                                                                                                         | Passed at the time of the audit.                                                                                          |

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

## Windows MXC attempt: 2026-10-30

This later attempt supersedes the legacy backend for current Windows execution; it does not change the failed observations above.

- Application changes: `fe71efc` (explicit offline MXC), `e258107` (fixed Node options), and `fff93a0` (publication text after recovery). The final local full check passed with 100 tests (99 passed, one Unix-only skip). The no-model `test/manual/verify-isolation.ts` helper is committed alongside this evidence; the application PR records CI results for the final documentation/helper commit.
- Environment: Windows 11 25H2, build **26200.9711**; Node.js **24.13.0**; Codex CLI **0.166.0** installed separately from the existing global 0.154.0 installation.
- Backend: explicit `windows.sandbox="mxc"`, default-deny filesystem policy, networking disabled, no managed network proxy, and no legacy fallback. This backend requires MXC capability rather than the legacy administrator setup marker. See the [pinned MXC backend contract](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/mxc-sandbox/README.md) and [offline network policy](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/mxc-sandbox/src/policy.rs).
- The authenticated doctor passed version/configuration/authentication checks and both real filesystem/network probe profiles. Outside fake-secret reads and writes, loopback TCP, and public TCP were denied; the controller's public TCP baseline was reachable. Authentication data remained in the dedicated profile.
- The expanded manual helper also passed from a fresh, unauthenticated state home with the fixed Node options active. It invoked no model and used only disposable fake data. Its direct process and nested child both produced the following observations:

| Observation                                                | Read-only profile | Write profile |
| ---------------------------------------------------------- | ----------------- | ------------- |
| Read the allowed workspace file                            | Allowed           | Allowed       |
| Overwrite an existing workspace file or create a new one   | Denied            | Allowed       |
| Read a sibling fake-secret file inside the controller home | Denied            | Denied        |
| Read a fake-secret file outside the controller home        | Denied            | Denied        |
| Read an outside file created after sandbox startup         | Denied            | Denied        |
| Write outside the workspace                                | Denied            | Denied        |
| Write `.git`, `.agents`, `.codex`, or `.aws` fixtures      | Denied            | Denied        |
| Delete the `.git` fixture                                  | Denied            | Denied        |
| Connect to IPv4 or IPv6 loopback listeners                 | Denied            | Denied        |
| Listed fake credential environment variables present       | No                | No            |

The controller reached both loopback listeners before and after each profile. The outside file was created only after the sandbox's readiness handshake, so denial was not inferred from a nonexistent file or a startup-only directory snapshot. The expanded helper does not replace the doctor's public-egress baseline check.

From the AgentGate repository root, reproduce the additional no-model probes against the separately installed candidate with:

```powershell
$candidateCodex = (Resolve-Path -LiteralPath '.agentgate/tooling/codex-0.166.0/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe').Path
node test/manual/verify-isolation.ts $candidateCodex
```

If installed elsewhere, supply that installation's absolute native executable path. Omitting `--home` creates a fresh unauthenticated state home outside the repository. The helper prints sanitized JSON observations, exits nonzero for failed or unavailable requirements, and retains the state home for diagnostics; it removes only its owned fixtures and sessions after verified termination. It is excluded from routine `npm test` and performs no login or model call.

### Real workflow and Node startup recovery

- Repository: [`tutuu9/agentgate-acceptance-20261030-mxc`](https://github.com/tutuu9/agentgate-acceptance-20261030-mxc), [Issue #1](https://github.com/tutuu9/agentgate-acceptance-20261030-mxc/issues/1).
- Run: `fb47d2b5-70c1-4347-8e21-71c09b6f6a51`; base commit: `64025f70958e217dcb2155b24744bbc9399eeb56`.
- Real planning, implementation, one automatic repair, and independent read-only review used `gpt-6.1-sol` with `high` reasoning effort. The human approved the plan before implementation.
- The first `npm test` attempt failed during Node startup with `EPERM: operation not permitted, lstat 'C:\'`. Node's default module resolution tried to inspect denied ancestor metadata. The one repair attempt did not resolve that infrastructure failure; its budget and the approved run were preserved.
- The adapter now supplies exactly `NODE_OPTIONS=--preserve-symlinks --preserve-symlinks-main` on Windows and discards caller-supplied options. This changes Node path resolution without adding filesystem grants or patching Node APIs. A separate no-model fixture passed npm tests covering JavaScript imports, Node's built-in TypeScript stripping, and a nested Node child. Linked-package and native-module semantics still require project-specific validation; see the [Node.js 24.13.0 flag documentation](https://nodejs.org/download/release/v24.13.0/docs/api/cli.html#--preserve-symlinks).
- The same saved run resumed from its check checkpoint without resetting the repair budget or plan approval. Its **three tests passed** and independent read-only review reported **no findings**.
- Candidate commit: `97067b7ae31fb800a3f9783d0279d23ed89ec62f`. The initial publication preview included an obsolete infrastructure diagnostic from the repair stage, so publication was declined and the saved candidate was preserved. The PR builder was corrected to describe the approved objective alongside current checks and review; the historical stage report remains available locally.
- The human then approved this exact commit, title, and body. AgentGate pushed the candidate and created [draft PR #2](https://github.com/tutuu9/agentgate-acceptance-20261030-mxc/pull/2). GitHub verification confirmed `isDraft: true`, the exact candidate SHA, matching title/body, and only `src/clamp.js` and `test/clamp.test.js` (16 added lines). The saved run reached `completed`. No ordinary-PR fallback or merge occurred.

This establishes successful isolated execution and the Issue-to-draft-PR workflow in the recorded environment. It does not establish Linux isolation, ordinary-PR fallback behavior, every recovery scenario below, general TypeScript-tool compatibility, or a stable release.

## Live isolation procedure

1. Use a disposable test workspace and fake sentinel data only. Record OS, Node.js, Codex version, AgentGate commit, and native sandbox configuration.
2. For the authenticated doctor and workflow, configure the dedicated Codex profile through `codex login`; do not copy auth files or publish credential output. On Windows, use Codex 0.166.0 on an MXC-capable host. AgentGate explicitly selects offline MXC; legacy administrator setup is neither required nor accepted as evidence. On Linux, use the pinned 0.154.0 adapter and record its own native results. The additional manual helper can run without authentication in a fresh state home.
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
