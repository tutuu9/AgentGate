#!/usr/bin/env node
import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { CheckSchema, RepoSchema } from '../core/contracts.ts';
import { FileRunStore } from '../core/store.ts';
import { hasUncertainTermination } from '../core/errors.ts';
import { cleanTerminal, redact } from '../core/safety.ts';
import { Workflow } from '../core/workflow.ts';
import { CodexModelOptionsSchema, CodexRunner } from '../adapters/codex.ts';
import { CodexSandbox } from '../adapters/sandbox.ts';
import { GitHubCli } from '../adapters/github.ts';
import { execute } from '../adapters/process.ts';
import { TerminalInteraction } from './terminal.ts';

const HELP = `AgentGate 0.1.0-dev.0 — human-approved Issue-to-PR workflows

Usage:
  agentgate doctor
  agentgate repo add <local-path> [--name <name>] [--checks <checks.json>]
  agentgate run <issue-url> --repo <name>
  agentgate status [run-id] [--json]
  agentgate inspect <run-id> [--json]
  agentgate resume <run-id>
  agentgate cleanup <run-id>

Options:
  --home <path>   State directory (default: AGENTGATE_HOME or ~/.agentgate)
  --help         Show this help

Run/resume options:
  --model <id>                 Explicit Codex model identifier
  --reasoning-effort <effort>   low, medium, high, xhigh, or max
Model options apply to this invocation only; repeat them when resuming a run.

Requires Node.js 24, Git, GitHub CLI, and a verified Codex sandbox.
Run/repo add/resume/cleanup require an interactive terminal; there is no --yes bypass.
No merge, deployment, paid API fallback, or automatic dependency installation.
`;

function show(value: string): void {
  process.stdout.write(`${cleanTerminal(redact(value))}\n`);
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      json: { type: 'boolean' },
      home: { type: 'string' },
      repo: { type: 'string' },
      name: { type: 'string' },
      checks: { type: 'string' },
      model: { type: 'string' },
      'reasoning-effort': { type: 'string' },
    },
  });
  if (values.help || !positionals.length) {
    show(HELP);
    return 0;
  }
  if (process.versions.node.split('.')[0] !== '24')
    throw new Error('AgentGate requires Node.js 24.');
  const command = positionals[0];
  if (!['doctor', 'repo', 'run', 'status', 'inspect', 'resume', 'cleanup'].includes(command!))
    throw new Error(`Unknown command: ${command}. Use --help.`);
  if (
    (values.model !== undefined || values['reasoning-effort'] !== undefined) &&
    command !== 'run' &&
    command !== 'resume'
  )
    throw new Error('--model and --reasoning-effort are only supported for run and resume.');
  const modelOptions = CodexModelOptionsSchema.parse({
    model: values.model,
    reasoningEffort: values['reasoning-effort'],
  });
  const interactive = ['repo', 'run', 'resume', 'cleanup'].includes(command!);
  if (interactive && (!process.stdin.isTTY || !process.stdout.isTTY))
    throw new Error('This command requires an interactive terminal for explicit approvals.');
  const home = resolve(values.home ?? process.env.AGENTGATE_HOME ?? join(homedir(), '.agentgate'));
  const store = new FileRunStore(home);
  const sandbox = new CodexSandbox({ home, codexPath: process.env.AGENTGATE_CODEX_PATH });
  const git = new GitHubCli({ home, ghPath: process.env.AGENTGATE_GH_PATH });
  const abort = new AbortController();
  const interrupt = () => abort.abort(new Error('Cancelled by the user.'));
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  let ui: TerminalInteraction | undefined;
  try {
    await store.init();
    if (command === 'doctor') {
      return await withRunLock(store, async () => {
        const checks = [{ name: 'node', ok: true, detail: process.version }];
        for (const [name, executable, args] of [
          ['git', 'git', ['--version']],
          ['github', process.env.AGENTGATE_GH_PATH ?? 'gh', ['auth', 'status']],
        ] as const) {
          try {
            const result = await execute({
              command: executable,
              args: [...args],
              timeoutMs: 20_000,
              signal: abort.signal,
            });
            checks.push({
              name,
              ok: result.exitCode === 0,
              detail:
                result.exitCode === 0
                  ? 'Available'
                  : 'Unavailable or not authenticated; configure this tool yourself.',
            });
          } catch (error) {
            if (hasUncertainTermination(error)) throw error;
            abort.signal.throwIfAborted();
            checks.push({ name, ok: false, detail: errorMessage(error) });
          }
        }
        checks.push(...(await sandbox.doctor(abort.signal)));
        if (values.json) show(JSON.stringify(checks, null, 2));
        else
          for (const check of checks)
            show(`${check.ok ? 'PASS' : 'BLOCKED'} ${check.name}: ${check.detail}`);
        return checks.every((check) => check.ok) ? 0 : 2;
      });
    }
    if (command === 'status') {
      const result = positionals[1] ? await store.getRun(positionals[1]) : await store.listRuns();
      if (values.json || positionals[1]) show(JSON.stringify(result, null, 2));
      else
        for (const run of Array.isArray(result) ? result : [result])
          show(
            `${run.id}  ${run.status}  ${run.repo.fullName}#${run.issue.number}  ${run.updatedAt}`,
          );
      return 0;
    }
    if (command === 'inspect') {
      const run = await store.getRun(required(positionals[1], 'run-id'));
      let diff: string;
      try {
        diff = await withRunLock(store, async () => {
          await git.snapshot(run.worktree, abort.signal);
          return git.diff(run.worktree, run.baseCommit, abort.signal);
        });
      } catch (error) {
        diff = `Diff unavailable: ${errorMessage(error)}`;
      }
      show(
        values.json
          ? JSON.stringify({ run, diff }, null, 2)
          : `${JSON.stringify(run, null, 2)}\n${diff}`,
      );
      return 0;
    }
    const interaction = new TerminalInteraction(abort.signal, interrupt);
    ui = interaction;
    if (command === 'repo') {
      if (positionals[1] !== 'add') throw new Error('Use: agentgate repo add <path>');
      return await withRunLock(store, async () => {
        const path = await realpath(resolve(required(positionals[2], 'local-path')));
        const identity = await git.identify(path, abort.signal);
        const checks = values.checks
          ? z
              .array(CheckSchema)
              .min(1)
              .parse(JSON.parse(await readFile(resolve(values.checks), 'utf8')))
          : await suggestedChecks(path);
        const profile = RepoSchema.parse({
          name: values.name ?? basename(path),
          path,
          ...identity,
          checks,
        });
        interaction.show(
          `Register or replace this repository profile?\n${JSON.stringify(profile, null, 2)}\nThese exact commands will run code from the worktree inside the offline sandbox.`,
        );
        if (!(await interaction.confirm('Save this profile?'))) return 0;
        await store.saveRepo(profile);
        show(`Registered ${profile.name}.`);
        return 0;
      });
    }
    if (command === 'cleanup') {
      return await withRunLock(store, async () => {
        const run = await store.getRun(required(positionals[1], 'run-id'));
        if (run.status !== 'completed' || !run.prUrl)
          throw new Error(
            'Only completed published runs can be cleaned up. Unpublished work is preserved.',
          );
        interaction.show(
          `Worktree: ${run.worktree}\nPR remains: ${run.prUrl}\nThe Git branch is preserved. Local reports and logs will be removed.`,
        );
        if (!(await interaction.confirm(`Clean up run ${run.id}?`))) return 0;
        await git.cleanup(run, abort.signal);
        await store.deleteRun(run.id);
        return 0;
      });
    }
    const workflow = new Workflow({
      store,
      sandbox,
      git,
      ui,
      agent: new CodexRunner({
        home,
        codexPath: process.env.AGENTGATE_CODEX_PATH,
        ...modelOptions,
      }),
    });
    const run =
      command === 'run'
        ? await workflow.start(
            required(values.repo, '--repo'),
            required(positionals[1], 'issue-url'),
            abort.signal,
          )
        : await workflow.resume(required(positionals[1], 'run-id'), abort.signal);
    show(`Saved run ${run.id}: ${run.status}${run.message ? `\n${run.message}` : ''}`);
    return ['blocked', 'failed', 'cancelled', 'interrupted'].includes(run.status) ? 2 : 0;
  } finally {
    ui?.close();
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  }
}

async function withRunLock<T>(store: FileRunStore, operation: () => Promise<T>): Promise<T> {
  const release = await store.acquireLock();
  let retain = false;
  try {
    return await operation();
  } catch (error) {
    retain = hasUncertainTermination(error);
    if (retain) {
      throw new Error(
        'Process shutdown could not be verified. The run lock is retained; follow the documented stale-lock recovery before another execution.',
        { cause: error },
      );
    }
    throw error;
  } finally {
    if (!retain) await release();
  }
}

async function suggestedChecks(path: string) {
  const manifest = z
    .object({ scripts: z.record(z.string(), z.string()).default({}) })
    .parse(JSON.parse(await readFile(join(path, 'package.json'), 'utf8')));
  const names = ['lint', 'typecheck', 'test', 'build'].filter((name) => name in manifest.scripts);
  if (!names.length)
    throw new Error(
      'No standard checks found. Provide --checks with a JSON array of {name, command, args, timeoutMs}.',
    );
  return names.map((name) => CheckSchema.parse({ name, command: 'npm', args: ['run', name] }));
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing ${name}. Use --help.`);
  return value;
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${cleanTerminal(redact(errorMessage(error)))}\n`);
      process.exitCode = 1;
    });
}
