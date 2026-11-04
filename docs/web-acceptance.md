# Local web interface acceptance

The proposed first public beta (`0.1.0-beta.1`) includes the local web interface. On Windows MXC, the installed interface completed a real Issue-to-draft-PR workflow, including publication refusal and restart recovery. [Web implementation #3](https://github.com/tutuu9/AgentGate/issues/3) and [Windows web acceptance #9](https://github.com/tutuu9/AgentGate/issues/9).

On supported Ubuntu, workflows require successful live preflight and separate ChatGPT authentication. The 2026-11-02 native run verified filesystem and network isolation, process lifecycle, Node IPC, and offline toolchain behavior with an unauthenticated profile and no model calls. Recording an authenticated Linux Issue-to-PR run is a follow-up for stable release. [Platform acceptance](acceptance.md) and [Linux workflow follow-up #19](https://github.com/tutuu9/AgentGate/issues/19).

## Implemented boundary

- Show CLI-registered repositories, saved runs, plans, check output, review, and publication diff.
- Start, resume, and cancel through the existing durable workflow and exclusive run lock.
- Bind live decisions to an individual prompt and plan fingerprint or exact candidate commit; ordinary PR creation requires separate consent.
- Restrict the listener to IPv4 loopback with exact Host, per-server token, mutation Origin, strict JSON, and bounded input.
- Preserve waiting prompts across page reload, require explicit resume after server restart, and preserve uncertain locks and unpublished work.
- Keep repository registration, check configuration, authentication, and cleanup in the CLI.

## Evidence and limits

`test/web.test.ts` drives real local HTTP requests through the real workflow/store with fake agent, sandbox, and GitHub boundaries. These tests exercise approvals, retries and contention, cancellation and recovery, request protection, and inspection behavior. They do not invoke a model or establish real filesystem/network isolation.

`test/cli.test.ts` verifies the public command surface and rejects invalid or misplaced web options before creating state. Windows and Ubuntu CI install the tarball in a fresh prefix. `test/manual/verify-web-package.ts` starts the npm-installed command without a TTY, fetches all bundled assets, reads the empty state using the local web token, and verifies shutdown.

## Recorded local verification

On Windows with Node 24.13.0 and npm 11.6.2:

- `npm run check` passed formatting, lint, typecheck, 132 tests, and the build. The 16 existing platform-specific tests were skipped on Windows; no failed tests were reported.
- All 18 new HTTP tests passed, including frequent reads during durable writes. That test exposed a Windows reader/replacement collision; per-file store coordination and bounded replacement retries fixed it without relaxing assertions.
- An npm tarball was installed offline into a fresh disposable directory. The package smoke check started its CLI without a TTY and verified all three assets plus authenticated empty state.
- The browser fixture completed plan approval, dependency readiness, checks/review, exact-commit publication approval, and a separately approved ordinary-PR fallback. Reload retained a pending plan, and polling preserved typed revision feedback.
- Hostile HTML in an issue title remained literal text, with no injected image element. Browser error logs were empty. A 390-pixel viewport had no horizontal document overflow; the viewport override was reset after inspection.

The browser used fake provider, sandbox, and GitHub adapters with disposable data. Linux native acceptance was still deferred at the time of this fixture. The later Windows run below exercised the authenticated browser workflow. The [platform acceptance record](acceptance.md) covers the subsequent native Linux work.

## Native Windows web acceptance: 2026-10-31, completed

This subsequent record covers [issue #9](https://github.com/tutuu9/AgentGate/issues/9). The installed web interface completed a real Windows workflow through human plan and dependency approvals, native implementation, checks, independent review, publication refusal, server restart recovery, and human approval of the exact commit published in a draft PR. This result applies to the recorded environment and scenarios.

### Environment and installed package

- Source commit: `23d09992994e5b966a359a516570c78d46856db5`.
- Windows 11 Pro 25H2, build `26200.9711`; Node `24.13.0`; npm `11.6.2`; Codex `0.166.0` with offline MXC.
- `npm run check` passed formatting, lint, typecheck, build, and 132 tests, with 16 platform-specific skips and no failures. Initial restricted attempts encountered process/cache `EPERM`; the authorized retries outside that restriction passed.
- The tarball contained 65 expected package paths, including all three web assets, and was installed offline into a fresh disposable directory. Its SHA-256 was `29d0999f43b318eedd2652572b3c010485ecf4488e748ca597dc0253b636234f`.
- The installed-package smoke helper passed no-TTY startup, all bundled web assets, authenticated empty state, and shutdown. This helper used no model or workflow calls.
- The installed CLI's real doctor passed all 12 checks, including dedicated ChatGPT authentication and native read, write, and network boundaries.
- The production installed web CLI ran in a PTY session and was exercised in the visible in-app browser. Start and every recorded Resume selected `gpt-6.1-sol` with `high` reasoning effort.

### Plan waiting, cancellation, and resume

- Native run `82ba8198-737e-406e-8792-2bdd0260d7a7` used the existing disposable [fixture issue #1](https://github.com/tutuu9/agentgate-acceptance-20261030-mxc/issues/1) at base `64025f70958e217dcb2155b24744bbc9399eeb56` and reached a generated plan awaiting approval.
- Browser reload retained the pending plan. Typed, unsent revision feedback survived polling; it was not submitted as a revision request.
- The Git index SHA-256 remained `ADEDF4B5C80649453EA9B2CC72E03A398B6B11102176EB91E0D165BFDCDA8F49` across a 44-second observation spanning planning and the pending-plan state. The measurement used direct index hashes without invoking a Git snapshot or status refresh.
- Cancelling at the plan gate saved status `cancelled` at checkpoint `plan`, without plan approval, implementation, a candidate commit, publication approval, or a PR. The worktree stayed clean and the execution lock was safely released. Independent GitHub and `git ls-remote` checks found no remote branch or PR for the run.
- Explicit browser Resume returned the same plan for approval. Browser error logs were empty.

### Implementation and publication refusal

- The user personally selected **Approve plan** and then **Dependencies are ready**. Real native implementation changed exactly `src/clamp.js` (four added lines) and `test/clamp.test.js` (12 added lines).
- Native `npm test` passed all three tests with no failures. An independent native review returned no findings. The run retained `repairAttempts: 0`.
- The checked tree was `2f0983ded0203666861636453c5727f3dba98634`; the candidate commit was `ca57266840c74a78b2ace5bcce92a55751f6e5a9`.
- The publication prompt displayed the diff, checks, review, branch, exact candidate SHA, and prepared PR title/body. During 33 seconds of publication-prompt polling, the Git index SHA-256 stayed `237F38C7E07830F58D430C24B77C784F97D28126A5FF4B642751FC7B3D2F71DE`.
- Selecting **Keep unpublished** completed the operation and left the run at `awaiting_publish`, without publication approval or a PR URL. A GitHub query across all PR states found no PR, and `git ls-remote` found no remote branch for the run.

### Server shutdown and explicit resume

- After an explicit browser Resume reached a new publication prompt, Ctrl+C was sent to the production server's PTY. The run was durably saved as `cancelled` at checkpoint `publish`, retaining the same candidate, results, and worktree without publication approval. The execution lock was removed.
- The owned server process exited, and its listener refused connections. Its process tree had no children at the approval prompt. The outer PTY returned exit code 1; this is not recorded as a zero-exit CLI shutdown.
- Restarting the installed CLI produced a new port and fresh token. The server initially had no active operation or prompt and listed the saved cancelled run. The old token returned HTTP 401.
- Explicit browser Resume produced prompt `ad310e25-a717-4d71-87ff-4bd340e5b01c`, distinct from the previous `80e2b837-8a0c-444f-9e16-f475f8978b37`. The candidate SHA, plan approval, checks, and review were unchanged; publication approval and a PR remained absent. Browser error logs were empty.

This shutdown observation applies to waiting for approval. It does not establish an additional native process-tree cancellation result during active model or check execution; the earlier recorded Windows cancellation evidence remains in [platform acceptance](acceptance.md).

### Exact-commit publication and final verification

- The user personally approved publication of exact commit `ca57266840c74a78b2ace5bcce92a55751f6e5a9` in the browser. The saved run reached `completed`, with publication approval equal to that candidate SHA.
- The production workflow pushed the branch and created real [draft PR #4](https://github.com/tutuu9/agentgate-acceptance-20261030-mxc/pull/4). An independent GitHub query across all PR states returned exactly one PR for the run's head branch, with `isDraft: true` and base `main`. Independent `git ls-remote` verification matched the approved SHA.
- The published title and body matched the stored preview byte for byte. The PR changed exactly `src/clamp.js` (four added lines) and `test/clamp.test.js` (12 added lines), with no deletions.
- The completed run retained `ordinaryPrApproved: false` and `repairAttempts: 0`; its execution lock was absent. Existing runs, worktrees, and earlier fixture PRs were preserved.
- The browser displayed the completed run and reported no browser errors.

Native Windows web acceptance for these scenarios is complete. The fixture repository supported draft PRs, so the ordinary-PR fallback and its separate approval gate have HTTP and fake-browser coverage only.
