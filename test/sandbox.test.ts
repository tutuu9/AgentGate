import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  CODEX_VERSION,
  CodexSandbox,
  createSandboxSession,
  DISABLED_FEATURES,
  isolatedEnvironment,
  redactOutput,
} from '../src/adapters/sandbox.ts';
import { ProcessError, type ExecuteOptions, type Executor } from '../src/adapters/process.ts';

test('isolated environments exclude credentials, shell options and proxies', () => {
  const env = isolatedEnvironment('/agentgate', '/temporary', {
    PATH: '/bin',
    GH_TOKEN: 'fake',
    GITHUB_TOKEN: 'fake',
    OPENAI_API_KEY: 'fake',
    ANTHROPIC_API_KEY: 'fake',
    NODE_OPTIONS: '--require fake',
    HTTPS_PROXY: 'https://fake',
    SSH_AUTH_SOCK: '/fake',
    npm_config_registry: 'https://fake',
  });
  assert.equal(env.PATH, '/bin');
  for (const key of [
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'NODE_OPTIONS',
    'HTTPS_PROXY',
    'SSH_AUTH_SOCK',
    'npm_config_registry',
  ])
    assert.equal(env[key], undefined);
});

test('session policy separates controller state and grants only the chosen worktree', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentgate-policy-'));
  const workspace = join(directory, 'workspace');
  await mkdir(workspace);
  const session = await createSandboxSession(join(directory, 'home'), workspace, true);
  try {
    assert.ok(session.configArgs.includes('project_root_markers=[]'));
    assert.ok(session.configArgs.includes('web_search="disabled"'));
    assert.ok(session.configArgs.some((argument) => argument.endsWith('.network.enabled=false')));
    assert.ok(session.configArgs.some((argument) => argument.includes('":root"="deny"')));
    assert.ok(
      session.configArgs.some(
        (argument) =>
          argument.includes(JSON.stringify(join(directory, 'home', 'codex'))) &&
          argument.includes(`${JSON.stringify(join(directory, 'home', 'codex'))}="deny"`),
      ),
    );
    assert.equal(session.env.GITHUB_TOKEN, undefined);
    await session.cleanup();
    assert.deepEqual(await readdir(workspace), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('sessions reject redirected runtime directories and worktrees before granting access', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentgate-linked-policy-'));
  const home = join(directory, 'home');
  const outside = join(directory, 'outside');
  await mkdir(home);
  await mkdir(outside);
  const runtime = join(home, 'runtime');
  await symlink(outside, runtime, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    await assert.rejects(createSandboxSession(home), /real canonical directories/);
    assert.deepEqual(await readdir(outside), []);
    await rm(runtime);
    const linkedWorktree = join(directory, 'linked-worktree');
    await symlink(outside, linkedWorktree, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(
      createSandboxSession(home, linkedWorktree, true),
      /real canonical directories/,
    );
    assert.deepEqual(await readdir(outside), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function prerequisiteExecutor(
  options: {
    badVersion?: boolean;
    enabledFeature?: boolean;
    enabledMcp?: boolean;
    apiAuth?: boolean;
  } = {},
): Executor {
  return async ({ args }) => {
    let stdout = '';
    if (args.includes('--version'))
      stdout = `codex-cli ${options.badVersion ? '999.0.0' : CODEX_VERSION}`;
    else if (args.includes('features'))
      stdout = DISABLED_FEATURES.map(
        (feature) =>
          `${feature} stable ${options.enabledFeature && feature === 'apps' ? 'true' : 'false'}`,
      ).join('\n');
    else if (args.includes('mcp'))
      stdout = options.enabledMcp ? '[{"name":"unexpected","enabled":true}]' : '[]';
    else if (args.includes('login'))
      stdout = options.apiAuth ? 'Logged in using an API key' : 'Logged in using ChatGPT';
    else if (args.includes('--help')) stdout = '--permission-profile --include-managed-config';
    return { exitCode: 0, stdout, stderr: '', durationMs: 1 };
  };
}

test('Codex prerequisites reject unsupported versions, integrations and API billing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentgate-doctor-'));
  const session = await createSandboxSession(directory);
  try {
    for (const [options, name] of [
      [{ badVersion: true }, 'codex-version'],
      [{ enabledFeature: true }, 'codex-integrations'],
      [{ enabledMcp: true }, 'codex-mcp'],
      [{ apiAuth: true }, 'codex-auth'],
    ] as const) {
      const checks = await new CodexSandbox({
        home: directory,
        executor: prerequisiteExecutor(options),
      }).prerequisites(session);
      assert.equal(checks.find((check) => check.name === name)?.ok, false);
    }
  } finally {
    await session.cleanup();
    await rm(directory, { recursive: true, force: true });
  }
});

test('doctor stops immediately on cancellation and propagates uncertain termination', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentgate-cancel-doctor-'));
  const abort = new AbortController();
  let calls = 0;
  const sandbox = new CodexSandbox({
    home: directory,
    executor: async (options) => {
      calls++;
      assert.equal(options.signal, abort.signal);
      abort.abort(new Error('test cancellation'));
      return { exitCode: 0, stdout: `codex-cli ${CODEX_VERSION}`, stderr: '', durationMs: 1 };
    },
  });
  try {
    await assert.rejects(sandbox.doctor(abort.signal), /test cancellation/);
    assert.equal(calls, 1);
    const failure = new ProcessError('termination', 'Unverified owned process tree.');
    const uncertain = new CodexSandbox({
      home: directory,
      executor: async (options) => {
        // Missing scratch deliberately makes cleanup fail; the primary termination must survive.
        await rm(options.cwd!, { recursive: true, force: true });
        throw failure;
      },
    });
    await assert.rejects(uncertain.doctor(), (error) => error === failure);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('check launches fixed trampoline with separate argv and redacts output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentgate-check-'));
  const worktree = join(directory, 'checkout');
  await mkdir(worktree);
  let captured: ExecuteOptions | undefined;
  class FakeVerifiedSandbox extends CodexSandbox {
    override async doctor() {
      return [{ name: 'unit-test', ok: true, detail: 'Fake; not evidence of isolation.' }];
    }
  }
  const sandbox = new FakeVerifiedSandbox({
    home: join(directory, 'home'),
    executor: async (options) => {
      captured = options;
      return { exitCode: 2, stdout: 'token=fake-sensitive-value', stderr: 'failed', durationMs: 4 };
    },
  });
  try {
    const result = await sandbox.check(
      {
        name: 'checks',
        command: process.execPath,
        args: ['--version', '$(do-not-execute)'],
        timeoutMs: 1000,
      },
      worktree,
    );
    assert.equal(result.exitCode, 2);
    assert.equal(result.durationMs, 4);
    assert.ok(!result.output.includes('fake-sensitive-value'));
    assert.ok(captured?.args.includes('$(do-not-execute)'));
    assert.ok(captured?.args.includes('--include-managed-config'));
    assert.notEqual(captured?.cwd, worktree);
    assert.equal(captured?.env?.GH_TOKEN, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('token-like output is redacted without exposing raw credentials', () => {
  assert.equal(
    redactOutput('Authorization: Bearer secretvalue'),
    'Authorization: Bearer [redacted]',
  );
  assert.equal(redactOutput('ghp_12345678901234567890'), '[redacted]');
});

test('synthetic probe observations fail closed on missing network evidence or forbidden reads', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentgate-synthetic-probe-'));
  await mkdir(join(directory, 'codex', '.sandbox'), { recursive: true });
  const prerequisites = prerequisiteExecutor();
  let exposeSentinel = false;
  let baseline = true;
  let probeCalls = 0;
  const sandbox = new CodexSandbox({
    home: directory,
    connectivity: async () => baseline,
    executor: async (options) => {
      if (!options.args.includes('sandbox') || options.args.includes('--help'))
        return prerequisites(options);
      probeCalls++;
      const writable = options.args.some((argument) => /workspace"="write"/.test(argument));
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          readWorkspace: true,
          writeWorkspace: writable,
          readSentinel: exposeSentinel,
          writeOutside: false,
          loopback: false,
          egress: false,
          credentials: false,
        }),
        stderr: '',
        durationMs: 1,
      };
    },
  });
  try {
    const accepted = await sandbox.doctor();
    assert.equal(
      accepted.every((check) => check.ok),
      true,
      'Synthetic observations test only the decision logic, not real isolation.',
    );
    assert.equal(probeCalls, 2);
    baseline = false;
    assert.equal(
      (await sandbox.doctor()).find((check) => check.name === 'sandbox-read-network')?.ok,
      false,
    );
    baseline = true;
    exposeSentinel = true;
    assert.equal(
      (await sandbox.doctor()).find((check) => check.name === 'sandbox-read')?.ok,
      false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
