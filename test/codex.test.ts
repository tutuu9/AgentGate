import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildAgentPrompt, CodexRunner, parseAgentOutput } from '../src/adapters/codex.ts';
import { ProcessError, type ExecuteOptions } from '../src/adapters/process.ts';
import type { Plan, Run } from '../src/core/contracts.ts';

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
    assert.equal(captured.length, 3);
    captured.forEach((options, index) => {
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

test('Codex runner fails closed before a model invocation when isolation is unavailable', async () => {
  let calls = 0;
  const runner = new CodexRunner({
    home: tmpdir(),
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
