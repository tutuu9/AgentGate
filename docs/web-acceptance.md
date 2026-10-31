# Local web interface acceptance

This record covers [issue #3](https://github.com/tutuu9/AgentGate/issues/3). It describes browser/controller behavior, not new native sandbox acceptance. The existing [platform acceptance record](acceptance.md) and Linux workflow block still apply.

## Implemented boundary

- Show CLI-registered repositories, saved runs, plans, check output, review, and publication diff.
- Start, resume, and cancel through the existing durable workflow and exclusive run lock.
- Bind live decisions to an individual prompt and plan fingerprint or exact candidate commit; ordinary PR creation requires separate consent.
- Restrict the listener to IPv4 loopback with exact Host, per-server token, mutation Origin, strict JSON, and bounded input.
- Preserve waiting prompts across page reload, require explicit resume after server restart, and preserve uncertain locks and unpublished work.
- Keep repository registration, check configuration, authentication, and cleanup in the CLI.

## Evidence and limits

`test/web.test.ts` drives real local HTTP requests through the real workflow/store with fake agent, sandbox, and GitHub boundaries. These tests exercise approvals, retries and contention, cancellation and recovery, request protection, and inspection behavior. They do not invoke a model or establish real filesystem/network isolation.

`test/cli.test.ts` verifies the public command surface and rejects invalid or misplaced web options before creating state. `test/manual/verify-web-package.ts` starts an installed package without a TTY, fetches all bundled assets, and reads an authenticated empty state. Ordinary Windows/Ubuntu CI runs that package check after the required quality checks.

## Recorded local verification

On Windows with Node 24.13.0 and npm 11.6.2:

- `npm run check` passed formatting, lint, typecheck, 132 tests, and the build. The 16 existing platform-specific tests were skipped on Windows; no failed tests were reported.
- All 18 new HTTP tests passed, including frequent reads during durable writes. That test exposed a Windows reader/replacement collision; per-file store coordination and bounded replacement retries fixed it without relaxing assertions.
- An npm tarball was installed offline into a fresh disposable directory. The package smoke check started its CLI without a TTY and verified all three assets plus authenticated empty state.
- The browser fixture completed plan approval, dependency readiness, checks/review, exact-commit publication approval, and a separately approved ordinary-PR fallback. Reload retained a pending plan, and polling preserved typed revision feedback.
- Hostile HTML in an issue title remained literal text, with no injected image element. Browser error logs were empty. A 390-pixel viewport had no horizontal document overflow; the viewport override was reset after inspection.

The browser used fake provider, sandbox, and GitHub adapters with disposable data. No real PR or model call was made by that fixture. A passing web fixture is not evidence of a new authenticated native model run, production deployment, or stable release. Ordinary Windows/Ubuntu CI remains the cross-platform quality gate; Linux native acceptance remains deferred.
