# Contributing

AgentGate is currently an implementation preview. Start with [AGENTS.md](AGENTS.md), the shared contributor and coding-agent instructions. Keep code, documentation, issues, pull requests, and commits in English.

## Local development

Use Node.js 24 and npm:

```sh
npm ci
npm run check
```

The check command runs formatting validation, ESLint, TypeScript, behavior tests, and the build. `npm run format` formats the repository; run it deliberately and review unrelated changes before committing. Tests must use fake model providers and disposable local fixtures. Do not add credentials or live model calls to the test suite.

Prefer meaningful behavior tests: changed approval data, interruption and recovery, malformed external results, process failures, and denied operations. A passing fake sandbox test proves adapter behavior only. Real permission claims belong in the separate [acceptance record](docs/acceptance.md).

## Propose a change

1. Open or select an Issue with a concrete outcome and acceptance criteria. Discuss material scope changes before expanding an implementation.
2. Create a short topic branch such as `feat/run-inspection` or `fix/lock-recovery`.
3. Make small Conventional Commits with accurate dates and descriptions, for example `fix: preserve run state after a check timeout`.
4. Run `npm run check`, inspect the diff, and open a PR explaining the behavior change and validation.
5. Resolve review findings and have a human decide whether to merge.

Keep `main` stable. Do not fabricate development history or combine unrelated work into one commit. Do not merge or deploy automatically. Maintainers should require the available CI checks on `main`; account-specific branch-protection availability must be verified before it is documented as enforced.

## Implementation conventions

- Keep validated contracts, state, and orchestration in `src/core/`; external process, GitHub, Codex, and sandbox behavior in `src/adapters/`; interaction in `src/cli/`.
- Use clear names and explicit boundaries. Clean Code guidance is a set of heuristics: avoid arbitrary function-length limits, needless wrappers, or speculative abstractions.
- Parse external inputs and preserve behavior outside the requested change. Treat Issue text, repository files, process output, and model responses as untrusted.
- Keep commands and arguments separate. Never interpolate task text into a shell command.
- Preserve the separate plan and exact-commit publication approvals. Do not weaken a blocked check to make a run pass.
- Keep GitHub credentials in the controller and do not add a full-access or paid-API fallback.

The repository uses UTF-8 and LF endings as specified by `.editorconfig` and `.gitattributes`. Keep `package-lock.json` tracked. Do not commit auth caches, production secrets, dependencies, build output, logs, local run state, or worktrees. `.gitignore` does not remove secrets that are already tracked.

## Documentation and releases

Document the behavior that exists. Add an entry to `CHANGELOG.md` for a user-visible change and record significant architectural decisions in `docs/decisions.md`. Keep installation examples runnable and make limitations explicit.

Development versions remain previews until the release criteria in the roadmap and acceptance record are met. A human chooses the release version, reviews the changelog and package contents, and approves any tag or registry publication. Semantic versioning starts with the documented public CLI and state compatibility contract; incompatible state changes require an explicit migration or a clear refusal, never a silent reset.
