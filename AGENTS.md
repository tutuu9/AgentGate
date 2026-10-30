# AgentGate contributor instructions

AgentGate is a local TypeScript CLI for human-approved GitHub Issue-to-PR workflows.

## Architecture

- `src/core/`: validated contracts, run state, orchestration, local storage.
- `src/adapters/`: process, Git/GitHub, Codex and sandbox boundaries.
- `src/cli/`: terminal interaction and command routing.
- `test/`: behavior tests and disposable repository/process fixtures.
- `docs/`: architecture, decisions, roadmap and acceptance evidence.

Use Node.js 24 and npm. Run `npm run check` before proposing a change; it runs formatting, lint, typecheck, tests and build. Tests must not use real model credentials or paid APIs. Never turn a mocked test into evidence of real sandbox isolation.

## Working agreements

- Use English for code, documentation, issues, PRs and commits.
- Preserve existing behavior and keep changes within the requested scope.
- Prefer clear names, focused functions and explicit boundaries. Clean Code recommendations are heuristics, not line-count or abstraction quotas.
- Validate external data. Treat issues, repository files, model responses and process output as untrusted input.
- Never interpolate issue/model text into shell commands. Keep GitHub credentials in the controller, out of agent/check environments.
- Fail closed when sandbox support, authentication or an approval cannot be established. Never fall back to full access or API billing.
- Use one shared instruction source: edit this file; `CLAUDE.md` imports it.
- Do not copy source or private data from other projects.

## Git and authority

Use small Conventional Commits and topic branches with PRs. Keep `main` stable. Do not fabricate dates or contributions. Human approval is required for merge and production deployment. AgentGate's runtime must separately confirm its plan and the exact commit to publish. Do not automatically clean up unpublished work.

## Quality

Test meaningful behavior, failure recovery and security boundaries. Mandatory unavailable checks are blocked, never passed. Add tests for changed behavior rather than mirroring private implementation details. No production secrets, auth caches, raw reasoning, dependencies, build output or worktrees belong in Git.
