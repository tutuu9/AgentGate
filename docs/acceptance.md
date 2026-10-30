# Acceptance evidence

Record evidence for a specific commit and environment. Date of this initial record: **2026-10-30**. The project is an implementation preview; this document does not declare a stable release or extend measured isolation results to untested environments.

The maintainer authorized live Windows testing on 2026-10-30 using a separately authenticated ChatGPT profile, GPT-6.1 Sol, and high reasoning effort. The initial Codex 0.154.0 legacy sandbox failed outside-file read and loopback boundaries and correctly blocked model execution. A subsequent explicit offline MXC attempt with Codex 0.166.0 passed the recorded isolation probes and completed a real Issue through planning, implementation, checks, independent review, and an explicitly approved draft PR. The follow-up below records real refusal, cancellation, cleanup, and publication recovery. Native Linux acceptance is still being established; tracking remains in [Issue #1](https://github.com/tutuu9/AgentGate/issues/1) and [Issue #2](https://github.com/tutuu9/AgentGate/issues/2).

## Current evidence

| Area                                       | Observation                                                                                                                                                                                                                                                                                                                                | Status                                                                                                                                                                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Storage and safety behavior                | `node --test --test-concurrency=1 test/store.test.ts test/safety.test.ts` on Node.js 24.13.0/Windows: 23 passed, 0 failed, 1 Unix-only permission test skipped. Uses temporary files and fake secrets.                                                                                                                                     | Focused check passed; not full-suite evidence.                                                                                                                                                                           |
| Full formatting/lint/typecheck/tests/build | At `59e3dcc`, the full local check passed 120 tests: 109 passed, zero failures, 11 platform-specific skips on Windows/Node.js 24.13.0. Earlier results remain recorded below.                                                                                                                                                              | Passed locally; routine tests use no real model calls.                                                                                                                                                                   |
| Windows and Ubuntu CI                      | [CI run 41125948355](https://github.com/tutuu9/AgentGate/actions/runs/41125948355) passed on Windows and Ubuntu for `59e3dcc`, including package installation/help. Ubuntu ran all seven new pipe-transport tests; its full suite reported 116 passed and four platform skips.                                                             | Consult the selected commit in CI; no model or native sandbox acceptance is implied.                                                                                                                                     |
| Packaged CLI                               | Application commit `59e3dcc`, with the current documentation: built `agentgate-0.1.0-dev.0.tgz`, inspected all 49 entries, installed it into a fresh temporary prefix, and ran its installed `agentgate.cmd --help` successfully. Only compiled output, public documents, package metadata and the safe environment example were included. | Passed on Windows; not a release publication.                                                                                                                                                                            |
| Codex adapter prerequisites                | Current Windows preflight accepted Codex 0.166.0, explicit MXC configuration, disabled external integrations, and empty MCP configuration.                                                                                                                                                                                                 | Passed in the recorded Windows environment.                                                                                                                                                                              |
| Live Codex sandbox                         | Real doctor probes and expanded fresh-profile probes passed with offline MXC and fixed Node options. Read-only/write permissions, outside reads/writes, protected paths, IPv4/IPv6 loopback, and nested-process observations are detailed below.                                                                                           | Passed for Windows; real Linux attempts are blocked as detailed below.                                                                                                                                                   |
| Dedicated Codex authentication             | The dedicated profile passed ChatGPT authentication. Real planning, implementation, one repair, and review used `gpt-6.1-sol` with `high` reasoning effort. Authentication caches were not copied or printed.                                                                                                                              | Passed for this account and invocation.                                                                                                                                                                                  |
| Real Issue-to-PR workflow                  | The original run completed with three passing tests. The second run completed with six passing tests, a fresh review without findings, and recovery from a synthetic lost response after real PR creation.                                                                                                                                 | Both approved drafts verified: [PR #2](https://github.com/tutuu9/agentgate-acceptance-20261030-mxc/pull/2) and [PR #3](https://github.com/tutuu9/agentgate-acceptance-20261030-mxc/pull/3); no duplicate after recovery. |
| Private vulnerability reporting            | Enabled and verified through the authenticated GitHub API for `tutuu9/AgentGate` on 2026-10-30.                                                                                                                                                                                                                                            | Enabled.                                                                                                                                                                                                                 |
| Main branch protection                     | GitHub API confirmed required Windows/Ubuntu check contexts, up-to-date branches, PR-based changes, resolved conversations, admin enforcement, and disabled force pushes/deletion. Required external review count is zero for solo development.                                                                                            | Configured and API-verified on 2026-10-30.                                                                                                                                                                               |
| Dependency audit                           | `npm audit --json` reported zero known vulnerabilities across the installed production/development dependency graph on 2026-10-30.                                                                                                                                                                                                         | Passed at the time of the audit.                                                                                                                                                                                         |

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

## Follow-up MVP checks: 2026-10-30

This follow-up adds real refusal, recovery, toolchain, and process observations. It does not convert synthetic fault injection into a model finding, an unauthenticated native probe into an authenticated workflow, or a blocked Linux launch into successful isolation.

### Application and package checks

- `31cab0d`: native acceptance helpers, Linux workflow, and workflow regression coverage.
- `daf3124`: preserve sandbox state and the execution lock when process termination is uncertain.
- `b9cf4e3`: native descendant cancellation and real CLI live/stale-lock refusal checks.
- `d91957e`: prepare the distribution's bubblewrap and its targeted AppArmor prerequisite on the disposable Ubuntu runner.
- `c33ccee`: cancel interactive work on the first Ctrl-C.
- The full local `npm run check` passed on `c33ccee`: **110 tests, 109 passed, zero failures, one Unix-only permission test skipped**, plus formatting, lint, typecheck, and build. Routine tests still use no real model credentials or paid APIs. Subsequent changes require their own final check and CI result.
- After the exact Linux executable correction, a full local check passed **112 tests, 109 passed, zero failures, three platform-specific skips on Windows**. The later `59e3dcc` check passed **120 tests, 109 passed, zero failures, 11 platform-specific skips**. Windows and Ubuntu CI passed; Ubuntu executed all seven Linux pipe-transport tests and reported **116 passed, four platform-specific skips**. Later changes require their own validation.
- The built npm package was inspected again: **49 package paths** were reviewed, followed by installation into a fresh temporary prefix in offline mode and a successful installed-CLI help command. No release or registry publication occurred.

### Windows probes without authentication or model calls

These helpers use fresh disposable state homes and real production sandbox/process boundaries. The native isolation helper explicitly records `codex-auth: false` and `workflowAuthorized: false`; these expected observations do not relax the production authentication gate.

- `test/manual/verify-isolation.ts` now requires the platform's exact pinned Codex version and all expected non-authentication doctor prerequisites. On Windows 0.166.0/MXC, real public-TCP denial against a reachable controller baseline passed, followed by the expanded direct/child filesystem and IPv4/IPv6 loopback probes described above.
- `test/manual/verify-toolchain.ts` passed actual offline `npm run lint`, `npm run typecheck`, `npm run test`, and `npm run build` in a disposable TypeScript project. The compiled JavaScript output was verified. Deliberately injected unused-variable, TypeScript assignment, and assertion errors produced their expected ESLint, `TS2322`, and `ERR_ASSERTION` diagnostics. These were controller-created test faults, not model mistakes.
- That helper also launched a real parent and descendant inside the native sandbox, observed the descendant's increasing heartbeat, and cancelled through the production executor. Execution closed after abort and heartbeat writes stopped before the fixture's safety timeout. No sandbox PID was interpreted as a host PID. A continuing heartbeat is treated as uncertain termination so the session and lock remain preserved.
- `test/manual/verify-lock-recovery.ts` launched a real Node worker holding the production `FileRunStore` lock. The real CLI refused a concurrent doctor invocation. After abrupt termination and verification that the owned worker had exited, the CLI refused the unchanged stale lock and preserved the state marker. No native sandbox directory was created. A separate real production-executor cancellation stopped its descendant process and heartbeat. This helper deliberately retains its disposable stale lock rather than automatically clearing it.

Reproduce from the repository root with the verified Windows native executable:

```powershell
node test/manual/verify-isolation.ts $candidateCodex
node test/manual/verify-toolchain.ts $candidateCodex
node test/manual/verify-lock-recovery.ts
```

The helpers remain outside routine `npm test`. Their positive native results apply to the recorded Windows environment; the Linux execution below remains blocked.

### Authenticated workflow refusal and recovery

The original completed run `fb47d2b5-70c1-4347-8e21-71c09b6f6a51` was archived in sanitized form, then cleaned up after explicit human approval. Its owned worktree and local run record were removed. The published branch, commit `97067b7ae31fb800a3f9783d0279d23ed89ec62f`, and [draft PR #2](https://github.com/tutuu9/agentgate-acceptance-20261030-mxc/pull/2) remained intact.

A second run, `fdcc15cc-b33a-4bfd-8d72-e8159bd4209f`, used the same disposable repository and base `64025f70958e217dcb2155b24744bbc9399eeb56`. Real model stages continued to use `gpt-6.1-sol` with `high` reasoning effort and the dedicated ChatGPT profile.

- Feedback and rejection were exercised against real generated plans; the worktree remained clean before implementation. The human subsequently approved the revised plan. Refusing dependency readiness preserved the run, and resuming it allowed the separately confirmed preparation step to continue.
- A clearly labeled synthetic blocking finding was appended once **after an actual model review**. This controlled fixture triggered the run's one real repair invocation, which made no code changes, followed by fresh checks and a fresh real read-only review. The synthetic finding must not be reported as an issue discovered by the model. The repair budget was not replenished.
- Publication was refused at the real interactive prompt. The local candidate remained preserved and no publication followed that refusal.
- To exercise cancellation during a real check, the controller temporarily added a 120-second waiting test in the approved test file and a readiness marker in the disposable worktree. The first Ctrl-C was swallowed by the interactive input handling. After `c33ccee`, repeating the scenario caused the **first Ctrl-C** to cancel immediately, preserve checkpoint `check`, and release the execution lock after verified termination.
- A deliberately added out-of-scope fixture file blocked the run and was preserved. Only that controller-created file was subsequently removed for continued testing.
- A permanent numeric-string equal-bound test was added by the controller within the approved scope to force a changed tree. Old checks, review, and candidate evidence were invalidated. The final **six tests passed**, and a fresh actual model review returned **no findings**.
- The human explicitly approved replacement candidate `edeb655de0d6bb4e96ecde7704a22efe23f41d01` and its exact title/body. It supersedes candidate `63fc16f419d265ee79168c817360a3ed3cc47a42`, which remains in the branch's two-commit history.
- The controlled harness performed the **real branch push and real PR creation**, then injected a synthetic lost-response error. Saved state correctly remained failed at checkpoint `publish`, with candidate and publication approval both equal to the approved SHA, no saved `prUrl`, and `repairAttempts: 1`. The GitHub response loss was deliberately injected; the external operations were real.
- Normal CLI resume, using the production executor without fault injection, exited successfully, found existing [draft PR #3](https://github.com/tutuu9/agentgate-acceptance-20261030-mxc/pull/3), and completed without requesting approval again. GitHub verification across all PR states found exactly one PR for this branch: open, draft, approved head SHA, and matching title/body. Its final diff contains only `src/clamp.js` (four added lines) and `test/clamp.test.js` (29 added lines), with no deletions. Saved completed state retains the same candidate/approval and one consumed repair attempt. No duplicate PR was created.

### Linux native attempts: blocked

The dedicated native workflow uses a real Ubuntu runner and fresh unauthenticated Codex state. It performs no model call and receives no model credentials. Its results are separate from ordinary Ubuntu unit-test CI.

- Environment recorded for the follow-up: **Ubuntu 24.04.5**, kernel **7.0.0-1017-azure**, Node.js **24.22.1**, Codex CLI **0.154.0**.
- [Native run 41121164554](https://github.com/tutuu9/AgentGate/actions/runs/41121164554) failed during bubblewrap network-namespace setup with `RTM_NEWADDR`. It did not establish filesystem or network enforcement for the intended worker.
- [Native run 41122451164](https://github.com/tutuu9/AgentGate/actions/runs/41122451164), with `d91957e`, installed distribution bubblewrap **0.9.0** and loaded the packaged profile specifically permitting its required user namespaces. The namespace probe passed. The system-wide `kernel.apparmor_restrict_unprivileged_userns` setting remained **1** before and after setup; it was not disabled.
- Execution then stopped because the native Codex executable in the temporary tooling directory was not readable when Codex attempted to re-execute itself under the default-deny policy. The target Node probe did not run, so the namespace setup success is not a sandbox-isolation pass.
- Exact-executable read access in `b1a99aa` resolved the earlier self-reexecution `ENOENT` failure without granting the entire temporary tooling directory. `38a1091` pins invocation to that selected file, preventing a second `PATH` search from selecting a different executable. The diagnostic attempt, [native run 41124153256](https://github.com/tutuu9/AgentGate/actions/runs/41124153256) at `1d27efc`, returned native process exit code zero with empty stdout and stderr instead of the required probe observations.
- [Native run 41125245682](https://github.com/tutuu9/AgentGate/actions/runs/41125245682) established that Node executed JavaScript and preserved exit code 37, but silently discarded console output. Direct descriptor writes worked; descriptors were Unix sockets, and stream callbacks reported no error. This matches [Node's unknown-stream fallback](https://github.com/nodejs/node/blob/v24.22.1/lib/internal/bootstrap/switches/is_main_thread.js#L95): [libuv socket classification](https://github.com/nodejs/node/blob/v24.22.1/deps/uv/src/unix/tty.c#L438) requires inspection syscalls denied by [the pinned Codex seccomp policy](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/linux-sandbox/src/landlock.rs#L194).
- In `59e3dcc`, fixed positional-argument Bash relays provide real POSIX pipes without changing sandbox permissions. [Native run 41125948318](https://github.com/tutuu9/AgentGate/actions/runs/41125948318) passed all six command controls, including FIFO descriptors 0/1/2, separate output, delayed output, and exact nonzero status. Workspace reads/writes, outside-secret read denial, and loopback/public network denial had the expected observations. However, the worker reported an outside write in both permission modes. The doctor correctly blocked; host mutation versus private namespace shadowing needs separate measurement before changing that criterion.
- A Node process can create new socket-based captured streams after entering the sandbox. The outer pipe transport does not repair those nested streams. The fixed nested filesystem/network fixture reports its observations with `fs.writeSync`; this keeps its permission observations measurable without claiming that nested console capture is compatible. General Linux Node compatibility remains a separate blocker.
- Until the required allow/deny observations and offline toolchain checks pass, **Linux isolation and Linux toolchain acceptance remain blocked**. There is no claimed fallback, authenticated Linux workflow, or successful Linux model invocation.

### Remaining acceptance matrix

| Criterion                                             | Recorded outcome                                                                                                                                                                                         | Status                                                                                 |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Windows filesystem, network, and descendant isolation | Authenticated doctor and fresh unauthenticated direct/child probes passed; the latter do not authorize workflow execution.                                                                               | Passed in the recorded Windows environment.                                            |
| Linux filesystem, network, and descendant isolation   | Native command transport and loopback/public network denial passed, but an outside write was observed; host mutation versus private namespace behavior remains under investigation.                      | Blocked; outside-write observation requires host-side verification.                    |
| Offline TypeScript lint, typecheck, tests, and build  | Real Windows npm commands passed; three deliberately broken fixtures produced the expected diagnostics.                                                                                                  | Passed on Windows; Linux pending.                                                      |
| Plan feedback and rejection                           | Real generated plans were revised/rejected while the worktree stayed clean.                                                                                                                              | Passed in the second authenticated run.                                                |
| Dependency readiness refusal and resume               | Refusal preserved the run; preparation was separately confirmed on resume.                                                                                                                               | Passed.                                                                                |
| Failed check and one repair budget                    | First run recovered from a real startup failure without resetting its consumed repair budget. Second run's labeled synthetic blocking finding triggered one real repair and fresh checks/review.         | Passed for these controlled scenarios; synthetic finding is not a model finding.       |
| Changed source invalidates prior evidence             | Controller-added in-scope test invalidated stale checks/review/candidate and produced a different checked candidate.                                                                                     | Passed; replacement SHA was approved, published, and recovered unchanged.              |
| Out-of-scope changes                                  | Injected file blocked execution and remained available until the controller explicitly removed that fixture.                                                                                             | Passed.                                                                                |
| Cancellation and process interruption                 | Native descendant cancellation, real CLI live/stale-lock refusal, and first-Ctrl-C check cancellation were observed. Uncertain-termination preservation also has regression coverage.                    | Passed for recorded scenarios; stale-lock cleanup was deliberately not automated.      |
| Publication refusal                                   | Real prompts preserved local candidates without publishing.                                                                                                                                              | Passed.                                                                                |
| Exact-commit draft publication                        | Both runs produced verified draft PRs with their approved SHA, title/body, and allowed file scope.                                                                                                       | Passed for both runs.                                                                  |
| Failure after push or PR creation                     | Real push/PR creation succeeded before a synthetic lost response; normal CLI resume found the existing PR without reprompting. GitHub showed exactly one PR for the branch.                              | Passed controlled response-loss recovery; approved commit and repair budget unchanged. |
| Ordinary-PR fallback                                  | The fixture repository supports draft PRs, so draft unavailability has not been reproduced against GitHub; the separate approval gate has behavior tests.                                                | Conditional live scenario not reproduced; no ordinary PR created.                      |
| Cleanup of completed published work                   | Sanitized archive preceded human-approved cleanup; worktree/run were removed while branch, published commit, and PR remained.                                                                            | Passed.                                                                                |
| Package installation and contents                     | 49 package paths inspected; fresh offline installation and installed help passed.                                                                                                                        | Passed locally; no release publication.                                                |
| Final candidate quality and release decision          | At `59e3dcc`, local checks and Windows/Ubuntu CI passed; all 49 package paths were inspected and offline installation/help passed. Native Linux acceptance remains blocked; publication recovery passed. | MVP acceptance remains open; no stable release declared.                               |

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
