# AgentGate

A local TypeScript CLI that takes a selected GitHub Issue through an approved plan, isolated coding work, checks, review, and a separately approved pull request.

**Status: implementation preview (`0.1.0-dev.0`). Real Windows MXC workflow and recovery acceptance passed. Linux workflows are blocked pending native cancellation and Node compatibility fixes. No stable release has been declared.** See the [acceptance record](docs/acceptance.md) for evidence and outstanding checks. Mocked adapter tests do not establish real isolation.

Windows uses explicit MXC isolation with networking disabled. The earlier legacy Windows attempt with Codex 0.154.0 failed the outside-file read and loopback-network boundaries; that backend is no longer selected. Every environment must pass the real probes before model execution. See the [acceptance record](docs/acceptance.md) for measured results.

## The workflow

1. Register a local clone and approve its mandatory check commands.
2. Select an Issue belonging to that repository.
3. Review the plan, base commit, allowed paths, and checks; approve it or ask for a revision.
4. Prepare dependencies yourself in the separate Git worktree.
5. Let Codex implement the plan, then run the approved checks offline.
6. Review the result with a separate read-only Codex invocation. A failed check or blocking review permits one repair attempt within the same scope.
7. Inspect the diff, check output, review, branch, and exact candidate commit; separately approve push and draft PR creation.
8. Decide yourself whether to mark the PR ready, merge, or deploy.

If draft PRs are unavailable, AgentGate asks again before creating an ordinary PR. The approved branch may already have been pushed at that point. Refusing publication preserves local work.

## Requirements

- Node.js **24** and npm; Git; GitHub CLI (`gh`) authenticated to your own GitHub account.
- A local repository with an `origin` on `github.com` and permission to push a branch and create a PR. Public and private repositories are supported by the workflow; GitHub account and organization policies still apply.
- **Codex CLI 0.166.0 on Windows**, with ChatGPT authentication in a separate AgentGate profile. Linux diagnostics pin **0.154.0**, but Linux workflow execution is currently blocked. Other versions fail the compatibility check until explicitly validated.
- Native Windows with Microsoft Execution Containers (MXC). Windows selects MXC explicitly and blocks execution if the device or managed policy cannot support it; there is no legacy fallback. See [MXC compatibility](https://learn.chatgpt.com/docs/windows/windows-sandbox#mxc-compatibility).
- Dependencies and check tools that can run offline. The preview targets Node.js/TypeScript repositories and one active run per AgentGate state directory.

Linux diagnostics need distribution-provided `bubblewrap` and permission to create sandbox namespaces. On Ubuntu 24.04, a missing distro `bwrap-userns-restrict` AppArmor profile can prevent startup; see the [official Linux sandbox prerequisites](https://learn.chatgpt.com/docs/sandboxing#prerequisites). Recorded native attempts used the packaged profile, preserved the system-wide AppArmor setting, and ran Codex as the ordinary runner user. These prerequisites alone do not enable Linux workflows.

Linux diagnostics also require `/bin/bash` and `/usr/bin/cat` for their fixed pipe transport. Real filesystem/network isolation passed, but a native descendant continued running after cancellation. Captured stdin/stdout/stderr of nested Node processes also reported `EPERM`, missing input, and discarded console output. The production doctor therefore reports `linux-workflow-support: false` and prevents model stages and project checks from starting. Passing physical probes or ordinary Ubuntu tests does not override this gate. Native Linux aborts, timeouts, and output-limit failures retain state because descendant termination is unverified.

Controller npm checks support the standard `node_modules/npm` installation layout. AgentGate validates that package and runs its selected entry point with the controller's Node.js 24. Only the npm package receives additional read access for those checks; an unsupported layout or a runtime inside the worktree/state directory is rejected.

macOS, GitHub Enterprise hosts, cross-repository forks, hosted workers, webhooks, web UI, and Claude Code are not implemented in this preview.

## Install from source

No published npm version is assumed. From a trusted checkout:

```sh
git clone https://github.com/tutuu9/AgentGate.git
cd AgentGate
npm ci
npm run check
npm link
agentgate --help
```

`npm run check` includes the build. Alternatively, run `npm run build` and use `node dist/cli/main.js --help` without a global link. `npm pack` creates an installable local tarball; this is not a public release or registry publication.

## Configure authentication and state

State defaults to `~/.agentgate`. Keep it outside target repositories. `--home <path>` overrides `AGENTGATE_HOME`, which overrides that default. The CLI reads process environment variables; it does **not** load `.env` files. See [.env.example](.env.example) for optional executable paths.

On Windows, configure native executables rather than `.cmd` or `.bat` launchers. AgentGate resolves npm through its JavaScript entry point; other batch wrappers are unsupported. If Codex or `gh` is not available as a native executable on `PATH`, set its explicit executable path using the variables in `.env.example`.

For a custom Linux Codex installation outside standard system runtime paths, set `AGENTGATE_CODEX_PATH` to its native executable. Linux grants that exact canonical file read access so Codex can re-execute itself inside the sandbox; it does not expose the installation directory. Keep it outside the target worktree and AgentGate state directory. A package-manager wrapper that launches another ungranted executable may fail preflight; select the native binary instead.

Use your existing native GitHub CLI login:

```sh
gh auth status
```

If needed, authenticate through `gh auth login` yourself. AgentGate does not create or store its own GitHub token. The existing `gh` login may have wider repository permissions than the profile you select in AgentGate.

Sign in to a dedicated Codex profile through the native login flow. Do not copy authentication files or tokens from another profile. For the default state home:

```powershell
# PowerShell
$env:CODEX_HOME = Join-Path $HOME '.agentgate/codex'
codex login
```

```sh
# Linux shell
CODEX_HOME="$HOME/.agentgate/codex" codex login
```

For a custom state home, use its `codex` subdirectory instead. Select ChatGPT authentication. AgentGate refuses API-key authentication and has no paid API fallback. Existing subscription limits still apply; AgentGate does not make those limits unlimited or purchase credits.

On Windows, use Codex 0.166.0 on a device that supports MXC. This backend does not require the legacy administrator setup, sandbox users, or firewall provisioning. AgentGate requests `windows.sandbox="mxc"` with networking disabled, including host loopback. Managed networking is not enabled; its different loopback contract would not satisfy these checks. Unsupported native capabilities or policies block execution rather than selecting a legacy backend. The installed CLI can be selected with `AGENTGATE_CODEX_PATH` without changing another Codex installation.

Run the preflight before using a real repository:

```sh
agentgate doctor
```

Every mandatory check must report `PASS`. `BLOCKED` means the requirement is unavailable or unverified. The doctor checks the CLI contract and authentication and attempts real filesystem/network probes. It makes a diagnostic TCP connection to `1.1.1.1:443` from the controller and tests denied connections from the sandbox; a missing baseline is blocked, not counted as isolation evidence. It does not invoke a model.

## Run an Issue

Replace the example paths, repository owner, and Issue number with a repository you control:

```sh
agentgate repo add /absolute/path/to/my-repository --name example
agentgate run https://github.com/YOUR-OWNER/YOUR-REPO/issues/123 --repo example
```

Use a native Windows path when running in PowerShell. Registration suggests existing `lint`, `typecheck`, `test`, and `build` npm scripts and asks you to confirm the exact commands. To supply an explicit list, create a JSON file and pass `--checks /path/to/checks.json`:

```json
[
  { "name": "typecheck", "command": "npm", "args": ["run", "typecheck"], "timeoutMs": 600000 },
  { "name": "test", "command": "npm", "args": ["test"], "timeoutMs": 600000 }
]
```

Commands and arguments are separate values, not shell snippets. Every listed check is mandatory; do not omit a required check just to obtain a green result. Registration and approvals require an interactive terminal and default to declining; there is no `--yes` bypass.

To select the model and reasoning effort explicitly for every agent stage in a run:

```sh
agentgate run https://github.com/YOUR-OWNER/YOUR-REPO/issues/123 --repo example --model gpt-6.1-sol --reasoning-effort high
agentgate resume RUN-ID --model gpt-6.1-sol --reasoning-effort high
```

These options apply to the current invocation; repeat them on `resume`. AgentGate ignores the Codex user configuration during agent execution, so configure the selection through these flags. Omitting the flags leaves model selection to the pinned CLI's defaults. The selected model must be available to the authenticated account; AgentGate does not retry with a different model or API billing if it is unavailable.

After plan approval, the CLI shows the worktree and pauses for dependency preparation. Review dependency scripts before running an installer there, then confirm that the approved checks work offline. AgentGate does not install packages automatically or supply production secrets. Changes outside the approved path scope block progress rather than silently expanding the plan.

On Windows, agent and check Node processes receive fixed `--preserve-symlinks --preserve-symlinks-main` options so script loading works without reading denied ancestor-directory metadata. Caller-supplied `NODE_OPTIONS` are discarded. This changes module identity for linked packages; projects using linked native modules need their own compatibility checks.

## Inspect, resume, and clean up

| Command                            | Purpose                                                                                                    |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `agentgate status`                 | List saved runs.                                                                                           |
| `agentgate status <run-id> --json` | Read a saved run.                                                                                          |
| `agentgate inspect <run-id>`       | Show saved details and the current diff when available.                                                    |
| `agentgate resume <run-id>`        | Revalidate prerequisites and continue from its saved checkpoint.                                           |
| `agentgate cleanup <run-id>`       | Confirm cleanup of a completed published run's worktree and local reports; preserve the Git branch and PR. |

Ctrl+C cancels active work. Failed, cancelled, blocked, or crash-interrupted work is preserved. A crash may leave an in-progress status; it is not evidence of completion. Resume rechecks the stored repository/check configuration and source snapshot. Changed files invalidate their previous checks, review, and publication approval. A changed check configuration requires renewed plan approval. Changed repository identity or base branch requires a new run.

A crashed controller can leave its run lock while an orphan worker is still active. AgentGate does not reclaim that lock merely because its PID is gone. Verify that the entire worker/check process tree has stopped, or restart the machine; back up the state and remove only the exact stale `run.lock` after confirming no AgentGate process remains. Keep every run record and worktree. See [recovery details](docs/architecture.md#state-and-recovery).

The default active execution budget is 60 minutes per run, excluding time spent waiting for you. An agent invocation is limited to 30 minutes; each check is limited to at most 10 minutes. An exhausted active budget requires a new explicitly scoped run. There is one automatic repair attempt, shared between check failures and blocking review findings.

Exit code `2` reports blocked doctor checks or a saved failed/blocked/cancelled run; `1` reports an invocation error. Exit code `0` can also mean that work is waiting for your approval or preparation: inspect the printed status before treating a command as completed.

## Boundaries and limitations

Git worktrees separate changes; they are not a security sandbox. Agent and check subprocesses use the native Codex permission boundary. GitHub credentials remain in the controller, and agents do not receive controller credential environment variables. Live verification is still required for each supported environment; see [security](SECURITY.md).

The controller records validated structured results and redacted diagnostics rather than raw model reasoning. Redaction is a best-effort safeguard, not proof that arbitrary output contains no secrets. Keep authentication caches, production credentials, and unrelated private files out of the worktree. Local state can contain private Issue text and code-related reports.

The globally installed `clean-code` skill is a contributor convenience, not a runtime dependency. Project conventions live in [AGENTS.md](AGENTS.md), which [CLAUDE.md](CLAUDE.md) imports.

## Development

Read [CONTRIBUTING.md](CONTRIBUTING.md), [architecture](docs/architecture.md), [decisions](docs/decisions.md), and the [roadmap](docs/roadmap.md). Tests use fake providers and disposable repositories; they must not use real model credentials or paid APIs. CI is configured for Windows and Ubuntu with Node.js 24.

The separate Native Linux CI workflow is paused at the maintainer's request. Its unresolved cancellation and Node compatibility problems are tracked in [#6](https://github.com/tutuu9/AgentGate/issues/6) and [#7](https://github.com/tutuu9/AgentGate/issues/7). Manual reproductions and historical results remain available; Linux execution stays blocked.

Licensed under [MIT](LICENSE).
