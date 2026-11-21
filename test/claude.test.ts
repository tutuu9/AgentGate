import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  CLAUDE_VERSION,
  ClaudeRunner,
  claudeArguments,
  claudeEnvironment,
  parseClaudeOutput,
} from '../src/adapters/claude.ts';
import { CodexRunner } from '../src/adapters/codex.ts';
import { ProcessError, type ExecuteOptions, type ExecuteResult } from '../src/adapters/process.ts';
import { AgentSelectionSchema, createAgentRunner } from '../src/adapters/providers.ts';
import type { Plan, Run } from '../src/core/contracts.ts';
import { hasUncertainTermination } from '../src/core/errors.ts';

// Every Claude Code process in these tests is a fake executor: no real CLI, login or model
// call is used, and nothing here is evidence of runtime isolation.

const plan: Plan = {
  objective: 'Fix behavior',
  steps: ['Inspect and fix'],
  allowedPaths: ['src/'],
  acceptanceCriteria: ['Tests pass'],
  risks: [],
};
const SUBSCRIPTION = {
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  subscriptionType: 'max',
};

function envelope(structured: unknown, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'PRIVATE_TRANSCRIPT_NEVER_PERSIST',
    structured_output: structured,
    ...overrides,
  });
}

function result(stdout: string, exitCode = 0): ExecuteResult {
  return { exitCode, stdout, stderr: '', durationMs: 1 };
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

interface FakeOptions {
  version?: string;
  auth?: unknown;
  responses?: unknown[];
  stage?: (options: ExecuteOptions) => Promise<ExecuteResult>;
}

function fakeClaude(captured: ExecuteOptions[], fake: FakeOptions = {}) {
  const responses = [...(fake.responses ?? [])];
  return async (options: ExecuteOptions): Promise<ExecuteResult> => {
    captured.push(options);
    if (options.args[0] === '--version')
      return result(`${fake.version ?? CLAUDE_VERSION} (Claude Code)\n`);
    if (options.args[0] === 'auth') return result(JSON.stringify(fake.auth ?? SUBSCRIPTION));
    if (fake.stage) return fake.stage(options);
    return result(envelope(responses.shift()));
  };
}

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'agentgate-claude-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const worktree = join(directory, 'checkout');
  await mkdir(worktree);
  return { directory, worktree, home: join(directory, 'home'), run: fixtureRun(worktree) };
}

test('Claude output parser keeps only a validated structured result', () => {
  assert.deepEqual(parseClaudeOutput('plan', envelope(plan)), plan);
  assert.deepEqual(parseClaudeOutput('implement', envelope({ summary: 'Done' })), {
    summary: 'Done',
  });
  assert.throws(() => parseClaudeOutput('plan', envelope({ objective: 'Incomplete' })), /schema/);
  assert.throws(() => parseClaudeOutput('plan', '{not-json}'), /malformed JSON/);
  assert.throws(() => parseClaudeOutput('plan', JSON.stringify({ type: 'other' })), /envelope/);
  // Observed from Claude Code 2.1.287 without a login: subtype success with is_error true.
  assert.throws(
    () => parseClaudeOutput('plan', envelope(plan, { is_error: true, result: 'Not logged in' })),
    /failed run/,
  );
  assert.throws(
    () => parseClaudeOutput('plan', envelope(plan, { subtype: 'error_max_turns' })),
    /failed run/,
  );
  assert.throws(() => parseClaudeOutput('plan', envelope(undefined)), /structured final response/);
});

test('Claude arguments keep stage permissions to file tools inside the worktree', () => {
  const read = claudeArguments('plan', '{}');
  const write = claudeArguments('implement', '{}', { model: 'sonnet', reasoningEffort: 'high' });
  for (const args of [read, write, claudeArguments('review', '{}')]) {
    for (const flag of [
      '-p',
      '--restricted',
      '--strict-mcp-config',
      '--disable-slash-commands',
      '--no-session-persistence',
    ])
      assert.ok(args.includes(flag), flag);
    assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
    assert.equal(args[args.indexOf('--permission-prompts') + 1], 'none');
    assert.equal(args[args.indexOf('--output-format') + 1], 'json');
    const denied = args[args.indexOf('--disallowedTools') + 1]!.split(',');
    for (const tool of ['Bash', 'PowerShell', 'WebFetch', 'WebSearch', 'Edit(./.git/**)'])
      assert.ok(denied.includes(tool), tool);
    const settings = JSON.parse(args[args.indexOf('--settings') + 1]!);
    assert.equal(settings.forceLoginMethod, 'claudeai');
    assert.equal(settings.disableAllHooks, true);
    assert.ok(!args.includes('--dangerously-skip-permissions'));
    assert.ok(!args.includes('--bare'), 'Bare mode would require API-key authentication.');
  }
  assert.equal(read[read.indexOf('--tools') + 1], 'Read,Glob,Grep');
  assert.ok(!read.includes('--allowedTools'));
  assert.equal(write[write.indexOf('--tools') + 1], 'Read,Glob,Grep,Edit,Write');
  assert.equal(write[write.indexOf('--allowedTools') + 1], 'Edit(./**)');
  assert.equal(write[write.indexOf('--model') + 1], 'sonnet');
  assert.equal(write[write.indexOf('--effort') + 1], 'high');
  assert.ok(!read.includes('--model') && !read.includes('--effort'));
});

test('Claude environment strips controller and API credentials', () => {
  const env = claudeEnvironment(join(tmpdir(), 'agentgate-home'), join(tmpdir(), 'scratch'), {
    ...process.env,
    ANTHROPIC_API_KEY: 'secret',
    ANTHROPIC_AUTH_TOKEN: 'secret',
    CLAUDE_CODE_OAUTH_TOKEN: 'secret',
    CLAUDE_CODE_USE_BEDROCK: '1',
    GH_TOKEN: 'secret',
    GITHUB_TOKEN: 'secret',
    OPENAI_API_KEY: 'secret',
    HTTPS_PROXY: 'http://proxy.invalid',
    NODE_OPTIONS: '--require=evil',
  });
  for (const [key, value] of Object.entries(env)) {
    assert.ok(!/token|key|secret|bedrock|vertex|proxy/i.test(key), key);
    assert.notEqual(value, 'secret');
  }
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.CODEX_HOME, undefined);
  assert.equal(env.CLAUDE_CONFIG_DIR, join(tmpdir(), 'agentgate-home', 'claude'));
  assert.equal(env.DISABLE_AUTOUPDATER, '1');
});

test('Claude runner passes task data through stdin from the worktree for every stage', async (t) => {
  const { home, worktree, run } = await fixture(t);
  const captured: ExecuteOptions[] = [];
  const runner = new ClaudeRunner({
    home,
    acceptPermissionBoundary: true,
    executor: fakeClaude(captured, {
      responses: [plan, { summary: 'Implemented' }, { summary: 'Reviewed', findings: [] }],
    }),
  });
  assert.deepEqual(await runner.run('plan', { run }), plan);
  run.plan = plan;
  run.planApproval = 'approved';
  assert.deepEqual(await runner.run('implement', { run }), { summary: 'Implemented' });
  assert.deepEqual(await runner.run('review', { run, diff: 'diff data' }), {
    summary: 'Reviewed',
    findings: [],
  });
  const stages = captured.filter((options) => options.args[0] === '-p');
  assert.equal(stages.length, 3);
  const canonicalWorktree = await realpath(worktree);
  for (const options of stages) {
    assert.equal(options.command, 'claude');
    assert.equal(options.cwd, canonicalWorktree);
    assert.equal(options.env?.CLAUDE_CONFIG_DIR, join(home, 'claude'));
    assert.equal(options.timeoutMs, 1_800_000);
    assert.ok(options.input?.includes('$(injection)'));
    assert.ok(!options.args.some((argument) => argument.includes('$(injection)')));
    const schema = JSON.parse(options.args[options.args.indexOf('--json-schema') + 1]!);
    assert.equal(schema.type, 'object');
    // Claude Code 2.1.287 refused the 2020-12 meta-schema in the first live run.
    assert.equal(schema.$schema, 'http://json-schema.org/draft-07/schema#');
  }
  assert.ok(stages[1]!.args.includes('Edit(./**)'));
  assert.ok(!stages[0]!.args.includes('Edit(./**)') && !stages[2]!.args.includes('Edit(./**)'));
  for (const options of captured.filter((entry) => entry.args[0] !== '-p'))
    assert.equal(options.input, undefined, 'Doctor commands never receive task data.');
  assert.deepEqual(await readdir(join(home, 'runtime')), [], 'Scratch directories are removed.');
});

test('Claude runner blocks before any model call without explicit boundary acceptance', async (t) => {
  const { home, run } = await fixture(t);
  const captured: ExecuteOptions[] = [];
  const runner = new ClaudeRunner({ home, executor: fakeClaude(captured, { responses: [plan] }) });
  const checks = await runner.doctor();
  const boundary = checks.find((check) => check.name === 'claude-permission-boundary');
  assert.equal(boundary?.ok, false);
  assert.match(boundary!.detail, /no OS-level isolation/);
  await assert.rejects(runner.run('plan', { run }), /claude-permission-boundary/);
  assert.ok(!captured.some((options) => options.args[0] === '-p'));
});

test('Claude runner fails closed on unverified versions and non-subscription login', async (t) => {
  const { home, run } = await fixture(t);
  const cases: [FakeOptions, RegExp][] = [
    [{ version: '2.1.288' }, /claude-version/],
    [{ auth: { ...SUBSCRIPTION, authMethod: 'api_key' } }, /claude-auth/],
    [{ auth: { ...SUBSCRIPTION, apiKeySource: 'ANTHROPIC_API_KEY' } }, /claude-auth/],
    [{ auth: { ...SUBSCRIPTION, apiProvider: 'bedrock' } }, /claude-auth/],
    [{ auth: { loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' } }, /claude-auth/],
    [{ auth: 'not json' }, /claude-auth/],
  ];
  for (const [fake, expected] of cases) {
    const captured: ExecuteOptions[] = [];
    const runner = new ClaudeRunner({
      home,
      acceptPermissionBoundary: true,
      executor: fakeClaude(captured, { ...fake, responses: [plan] }),
    });
    await assert.rejects(runner.run('plan', { run }), expected);
    assert.ok(!captured.some((options) => options.args[0] === '-p'), String(expected));
  }
  const unavailable = new ClaudeRunner({
    home,
    acceptPermissionBoundary: true,
    executor: async () => {
      throw new ProcessError(
        'spawn',
        'No executable was found in trusted absolute PATH directories.',
      );
    },
  });
  const checks = await unavailable.doctor();
  assert.ok(checks.some((check) => check.name === 'claude-prerequisites' && !check.ok));
});

test('Claude runner requires an approved plan and rejects failed or invalid results', async (t) => {
  const { home, run } = await fixture(t);
  const runner = (stage: FakeOptions['stage']) =>
    new ClaudeRunner({ home, acceptPermissionBoundary: true, executor: fakeClaude([], { stage }) });
  await assert.rejects(
    runner(async () => result(envelope({ summary: 'x' }))).run('implement', { run }),
    /approved plan/,
  );
  await assert.rejects(
    runner(async () => result(envelope(plan), 1)).run('plan', { run }),
    /exited with code 1/,
  );
  await assert.rejects(
    runner(async () => result(envelope({ objective: 'partial' }))).run('plan', { run }),
    /schema/,
  );
  assert.deepEqual(await readdir(join(home, 'runtime')), []);
});

test('Claude runner retains scratch files when process termination is uncertain', async (t) => {
  const { home, run } = await fixture(t);
  const runner = new ClaudeRunner({
    home,
    acceptPermissionBoundary: true,
    executor: fakeClaude([], {
      stage: async () => {
        throw new ProcessError('termination', 'Process-tree termination could not be verified.');
      },
    }),
  });
  await assert.rejects(runner.run('plan', { run }), (error) => hasUncertainTermination(error));
  assert.equal((await readdir(join(home, 'runtime'))).length, 1);
});

test('provider selection is explicit, defaults to Codex, and gates Claude on acceptance', () => {
  const home = join(tmpdir(), 'agentgate-provider-home');
  assert.ok(createAgentRunner({ home }, {}) instanceof CodexRunner);
  assert.ok(
    createAgentRunner({ home }, { provider: 'codex', model: 'gpt-x' }) instanceof CodexRunner,
  );
  assert.ok(
    createAgentRunner(
      { home },
      { provider: 'claude', acceptClaudePermissionBoundary: true },
    ) instanceof ClaudeRunner,
  );
  for (const invalid of [
    { provider: 'claude' },
    { provider: 'claude', acceptClaudePermissionBoundary: false },
    { provider: 'codex', acceptClaudePermissionBoundary: true },
    { acceptClaudePermissionBoundary: false },
    { provider: 'gemini' },
    { provider: 'claude', acceptClaudePermissionBoundary: true, apiKey: 'secret' },
    { provider: 'claude', acceptClaudePermissionBoundary: true, model: 'Opus; rm -rf' },
  ])
    assert.equal(AgentSelectionSchema.safeParse(invalid).success, false, JSON.stringify(invalid));
});
