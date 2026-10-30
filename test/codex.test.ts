import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { buildAgentPrompt, CodexRunner, parseAgentOutput } from '../src/adapters/codex.ts';
import { ProcessError, resolveCommand, type ExecuteOptions } from '../src/adapters/process.ts';
import type { Plan, Run } from '../src/core/contracts.ts';
import { hasUncertainTermination } from '../src/core/errors.ts';

const plan: Plan = {
  objective: 'Fix behavior',
  steps: ['Inspect and fix'],
  allowedPaths: ['src/'],
  acceptanceCriteria: ['Tests pass'],
  risks: [],
};
function transcript(value: unknown): string {
  return [
    { type: 'thread.started', thread_id: 'fake' },
    {
      type: 'item.completed',
      item: { type: 'reasoning', text: 'PRIVATE_REASONING_NEVER_PERSIST' },
    },
    { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(value) } },
    { type: 'turn.completed', usage: {} },
  ]
    .map((entry) => JSON.stringify(entry))
    .join('\n');
}

function fixtureRun(worktree: string): Run {
  return {
    schemaVersion: 1,
    id: randomUUID(),
    repo: {
      name: 'test',
      path: worktree,
      fullName: 'owner/repo',
      baseBranch: 'main',
      checks: [{ name: 'test', command: 'npm', args: ['test'], timeoutMs: 1000 }],
    },
    issue: {
      url: 'https://github.com/owner/repo/issues/1',
      number: 1,
      title: '$(injection)',
      body: 'Untrusted issue data',
    },
    baseCommit: 'a'.repeat(40),
    branch: 'agentgate/test',
    worktree,
    status: 'planning',
    checkpoint: 'plan',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    activeMs: 0,
    checks: [],
    repairAttempts: 0,
    ordinaryPrApproved: false,
  };
}

test('Codex JSONL parser discards reasoning and validates the final result', () => {
  assert.deepEqual(parseAgentOutput('plan', transcript(plan)), plan);
  assert.deepEqual(parseAgentOutput('implement', transcript({ summary: 'Done' })), {
    summary: 'Done',
  });
  assert.throws(() => parseAgentOutput('plan', transcript({ objective: 'Incomplete' })), /schema/);
  assert.throws(() => parseAgentOutput('plan', '{not-json}'), /malformed JSONL/);
  assert.throws(
    () => parseAgentOutput('plan', JSON.stringify({ type: 'turn.failed', error: 'sensitive' })),
    /failed turn/,
  );
  assert.throws(
    () => parseAgentOutput('plan', JSON.stringify({ type: 'turn.completed' })),
    /structured final response/,
  );
});

test('Codex runner passes task data through stdin and preserves stage permissions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentgate-codex-'));
  const worktree = join(directory, 'checkout');
  await mkdir(worktree);
  const run = fixtureRun(worktree);
  const captured: ExecuteOptions[] = [];
  const responses = [plan, { summary: 'Implemented' }, { summary: 'Reviewed', findings: [] }];
  const runner = new CodexRunner({
    home: join(directory, 'home'),
    codexPath: process.execPath,
    sandbox: {
      doctor: async () => [
        { name: 'mock', ok: true, detail: 'Unit-test fake; not isolation evidence.' },
      ],
    },
    executor: async (options) => {
      captured.push(options);
      const schema = options.args[options.args.indexOf('--output-schema') + 1]!;
      assert.equal(JSON.parse(await readFile(schema, 'utf8')).type, 'object');
      return { exitCode: 0, stdout: transcript(responses.shift()), stderr: '', durationMs: 1 };
    },
  });
  try {
    await runner.run('plan', { run });
    run.plan = plan;
    run.planApproval = 'approved';
    await runner.run('implement', { run });
    await runner.run('review', { run, diff: 'diff data' });
    const canonicalWorktree = await realpath(worktree);
    const canonicalCodexHome = await realpath(join(directory, 'home', 'codex'));
    const canonicalExecutable = await realpath(process.execPath);
    assert.equal(captured.length, 3);
    captured.forEach((options, index) => {
      assert.equal(
        options.command,
        process.platform === 'linux' ? canonicalExecutable : process.execPath,
      );
      if (process.platform === 'linux')
        assert.ok(
          options.args.some((argument) =>
            argument.includes(`${JSON.stringify(canonicalExecutable)}="read"`),
          ),
          'Every model stage must grant the selected native executable read access for self-reexec.',
        );
      assert.ok(!options.args.includes('--model'));
      assert.ok(!options.args.some((argument) => argument.startsWith('model_reasoning_effort=')));
      assert.ok(options.args.includes('--ignore-user-config'));
      assert.ok(options.args.includes('--ignore-rules'));
      assert.ok(options.args.includes('--json'));
      assert.ok(
        options.args.some((argument) =>
          argument.includes(
            `${JSON.stringify(canonicalWorktree)}=${JSON.stringify(index === 1 ? 'write' : 'read')}`,
          ),
        ),
      );
      assert.equal(options.timeoutMs, 1_800_000);
      assert.equal(options.maxOutputBytes, 4 * 1024 * 1024);
      assert.ok(options.input?.includes('$(injection)'));
      assert.ok(!options.args.some((argument) => argument.includes('$(injection)')));
      assert.equal(options.env?.CODEX_HOME, canonicalCodexHome);
      assert.equal(options.env?.GH_TOKEN, undefined);
      assert.notEqual(options.cwd, worktree);
      assert.ok(!options.input?.includes('PRIVATE_REASONING_NEVER_PERSIST'));
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  'Linux invokes the trusted policy executable instead of resolving PATH again from the launcher',
  { skip: process.platform !== 'linux' },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'agentgate-codex-selection-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const worktree = join(directory, 'checkout');
    const worktreeBin = join(worktree, 'bin');
    const trustedBin = join(directory, 'trusted');
    await mkdir(worktreeBin, { recursive: true });
    await mkdir(trustedBin);
    // These executable fixtures are only resolved, never launched or used as model providers.
    for (const bin of [worktreeBin, trustedBin])
      await writeFile(join(bin, 'codex'), 'unexecuted fixture', { mode: 0o700 });
    const trustedExecutable = await realpath(join(trustedBin, 'codex'));
    const previousPath = process.env.PATH;
    process.env.PATH = [worktreeBin, trustedBin].join(delimiter);
    const invoked: string[] = [];
    try {
      const runner = new CodexRunner({
        home: join(directory, 'home'),
        codexPath: 'codex',
        sandbox: {
          doctor: async () => [{ name: 'fake', ok: true, detail: 'Not isolation evidence' }],
        },
        executor: async (options) => {
          const selected = await resolveCommand(
            options.command,
            options.args,
            options.env,
            options.cwd,
          );
          invoked.push(selected.command);
          assert.ok(
            options.args.some((argument) =>
              argument.includes(`${JSON.stringify(trustedExecutable)}="read"`),
            ),
          );
          return { exitCode: 0, stdout: transcript(plan), stderr: '', durationMs: 1 };
        },
      });

      assert.deepEqual(await runner.run('plan', { run: fixtureRun(worktree) }), plan);
      assert.deepEqual(invoked, [trustedExecutable]);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  },
);

test('Codex uses the explicitly selected model and reasoning effort for every stage', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agentgate-model-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const worktree = join(directory, 'checkout');
  await mkdir(worktree);
  const run = fixtureRun(worktree);
  const captured: ExecuteOptions[] = [];
  const responses = [plan, { summary: 'Implemented' }, { summary: 'Reviewed', findings: [] }];
  const runner = new CodexRunner({
    home: join(directory, 'home'),
    model: 'gpt-6.1-sol',
    codexPath: process.execPath,
    reasoningEffort: 'high',
    sandbox: {
      doctor: async () => [{ name: 'fake', ok: true, detail: 'Not isolation evidence' }],
    },
    executor: async (options) => {
      captured.push(options);
      return { exitCode: 0, stdout: transcript(responses.shift()), stderr: '', durationMs: 1 };
    },
  });
  await runner.run('plan', { run });
  run.plan = plan;
  run.planApproval = 'approved';
  await runner.run('implement', { run });
  await runner.run('review', { run, diff: 'diff data' });
  assert.equal(captured.length, 3);
  for (const { args } of captured) {
    assert.ok(args.includes('--ignore-user-config'));
    assert.equal(args[args.indexOf('--model') + 1], 'gpt-6.1-sol');
    const effortIndex = args.indexOf('model_reasoning_effort="high"');
    assert.ok(effortIndex > 0);
    assert.equal(args[effortIndex - 1], '-c');
  }
});

test('Codex rejects invalid model selection before doctor or execution', () => {
  let calls = 0;
  const options = {
    home: join(tmpdir(), 'unused-model-home'),
    codexPath: process.execPath,
    sandbox: {
      doctor: async () => {
        calls++;
        return [];
      },
    },
    executor: async () => {
      calls++;
      throw new Error('must not run');
    },
  };
  for (const model of ['', '-injected-option', 'model\nother', 'model name', 'a'.repeat(129)])
    assert.throws(() => new CodexRunner({ ...options, model }), /model/i);
  assert.throws(
    () => new CodexRunner({ ...options, reasoningEffort: 'unsupported' as never }),
    /reasoningEffort/,
  );
  assert.equal(calls, 0);
});

test('Codex runner fails closed before a model invocation when isolation is unavailable', async () => {
  let calls = 0;
  const runner = new CodexRunner({
    home: tmpdir(),
    codexPath: process.execPath,
    sandbox: { doctor: async () => [{ name: 'sandbox', ok: false, detail: 'No evidence' }] },
    executor: async () => {
      calls++;
      throw new Error('must not run');
    },
  });
  await assert.rejects(runner.run('plan', { run: fixtureRun(tmpdir()) }), /execution blocked/);
  await assert.rejects(runner.run('implement', { run: fixtureRun(tmpdir()) }), /approved plan/);
  assert.equal(calls, 0);
});

test('task prompts carry approved scope and untrusted issue as data', () => {
  const run = fixtureRun(tmpdir());
  run.plan = plan;
  run.review = { summary: 'Repair this review failure', findings: [] };
  const prompt = buildAgentPrompt('implement', { run, feedback: 'repair only this failure' });
  assert.match(prompt, /TASK_DATA_JSON/);
  assert.match(prompt, /untrusted task data/);
  assert.match(prompt, /allowedPaths/);
  assert.match(prompt, /repair only this failure/);
  assert.match(prompt, /Repair this review failure/);
});

test('Codex never starts after doctor cancellation and preserves uncertain termination', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentgate-cancel-codex-'));
  const abort = new AbortController();
  const failure = new ProcessError('termination', 'Unverified owned process tree.');
  let calls = 0;
  let cancelDoctor = true;
  const runner = new CodexRunner({
    home: join(directory, 'home'),
    codexPath: process.execPath,
    sandbox: {
      doctor: async (signal) => {
        if (cancelDoctor) {
          assert.equal(signal, abort.signal);
          abort.abort(new Error('doctor cancelled'));
        }
        return [{ name: 'fake', ok: true, detail: 'Not isolation evidence' }];
      },
    },
    executor: async (options) => {
      calls++;
      await rm(options.cwd!, { recursive: true, force: true });
      throw failure;
    },
  });
  try {
    await assert.rejects(
      runner.run('plan', { run: fixtureRun(directory) }, abort.signal),
      /doctor cancelled/,
    );
    assert.equal(calls, 0);
    cancelDoctor = false;
    await assert.rejects(
      runner.run('plan', { run: fixtureRun(directory) }),
      (error) => error === failure,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Codex retains session files for nested uncertain termination and cleans ordinary failures', async (t) => {
  const uncertain = new Error('Worker wrapper failed', {
    cause: new AggregateError(
      [new Error('Shutdown wrapper', { cause: new ProcessError('termination', 'Not verified') })],
      'Process shutdown failed',
    ),
  });
  const ordinary = new Error('Worker failed after confirmed termination');
  for (const failure of [uncertain, ordinary]) {
    await t.test(failure === uncertain ? 'uncertain shutdown' : 'ordinary failure', async (t) => {
      const directory = await mkdtemp(join(tmpdir(), 'agentgate-codex-cleanup-'));
      t.after(() => rm(directory, { recursive: true, force: true }));
      let schemaPath: string | undefined;
      const runner = new CodexRunner({
        home: join(directory, 'home'),
        codexPath: process.execPath,
        sandbox: {
          doctor: async () => [{ name: 'fake', ok: true, detail: 'Not isolation evidence' }],
        },
        executor: async (options) => {
          schemaPath = options.args[options.args.indexOf('--output-schema') + 1];
          throw failure;
        },
      });

      await assert.rejects(
        runner.run('plan', { run: fixtureRun(directory) }),
        (error) => error === failure,
      );
      assert.ok(schemaPath);
      if (failure === uncertain) {
        assert.equal(JSON.parse(await readFile(schemaPath, 'utf8')).type, 'object');
      } else {
        await assert.rejects(readFile(schemaPath), { code: 'ENOENT' });
      }
    });
  }
});

test(
  'interrupted Linux model workers retain their session and original stop cause',
  { skip: process.platform !== 'linux' },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'agentgate-codex-native-stop-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    for (const kind of ['aborted', 'timeout', 'output-limit'] as const) {
      const failure = new ProcessError(kind, 'Synthetic native stop; not isolation evidence.');
      let schemaPath: string | undefined;
      const runner = new CodexRunner({
        home: join(directory, kind),
        codexPath: process.execPath,
        sandbox: {
          doctor: async () => [{ name: 'fake', ok: true, detail: 'Not isolation evidence' }],
        },
        executor: async (options) => {
          schemaPath = options.args[options.args.indexOf('--output-schema') + 1];
          throw failure;
        },
      });
      await assert.rejects(
        runner.run('plan', { run: fixtureRun(directory) }),
        (error) =>
          hasUncertainTermination(error) && error instanceof Error && error.cause === failure,
      );
      assert.ok(schemaPath);
      assert.equal(JSON.parse(await readFile(schemaPath, 'utf8')).type, 'object');
    }
  },
);
