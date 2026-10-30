import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
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
    node_options: '--import fake-lowercase',
    NoDe_OpTiOnS: '--require fake-mixed-case',
    HTTPS_PROXY: 'https://fake',
    SSH_AUTH_SOCK: '/fake',
    CODEX_NETWORK_ALLOW_LOCAL_BINDING: '1',
    npm_config_registry: 'https://fake',
  });
  assert.equal(env.PATH, '/bin');
  for (const key of [
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'node_options',
    'NoDe_OpTiOnS',
    'HTTPS_PROXY',
    'SSH_AUTH_SOCK',
    'CODEX_NETWORK_ALLOW_LOCAL_BINDING',
    'npm_config_registry',
  ])
    assert.equal(env[key], undefined);
  assert.equal(
    env.NODE_OPTIONS,
    process.platform === 'win32' ? '--preserve-symlinks --preserve-symlinks-main' : undefined,
  );
  assert.ok(!Object.values(env).some((value) => value?.includes('--require fake')));
});

test('Windows sandbox identity comes from the OS rather than caller environment', () => {
  const env = isolatedEnvironment('/agentgate', '/temporary', {
    USERNAME: 'Administrators',
    username: 'untrusted-user',
    USERDOMAIN: 'untrusted-domain',
    GH_TOKEN: 'fake',
    CODEX_API_KEY: 'fake',
  });
  assert.equal(env.USERNAME, process.platform === 'win32' ? userInfo().username : undefined);
  assert.equal(env.username, undefined);
  assert.equal(env.USERDOMAIN, undefined);
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.CODEX_API_KEY, undefined);
});

test(
  'MXC infrastructure uses trusted redirected host paths without caller overrides',
  { skip: process.platform !== 'win32' },
  () => {
    const previousLocalAppData = process.env.LOCALAPPDATA;
    try {
      const redirected = 'D:\\Redirected Profiles\\Local Data';
      process.env.LOCALAPPDATA = redirected;
      const env = isolatedEnvironment('/agentgate', '/temporary', {
        LOCALAPPDATA: 'C:\\untrusted-appdata',
        localappdata: 'C:\\untrusted-lowercase',
        SystemRoot: 'Z:\\untrusted-windows',
        SYSTEMDRIVE: 'Z:',
        APPDATA: 'C:\\unneeded-roaming-profile',
        GH_TOKEN: 'fake',
        HTTPS_PROXY: 'http://fake',
      });
      assert.equal(env.LOCALAPPDATA, redirected);
      assert.equal(env.localappdata, undefined);
      assert.equal(env.SystemRoot, process.env.SystemRoot);
      assert.equal(env.SystemDrive, process.env.SystemDrive);
      assert.equal(env.SYSTEMDRIVE, undefined);
      assert.equal(env.APPDATA, undefined);
      assert.equal(env.GH_TOKEN, undefined);
      assert.equal(env.HTTPS_PROXY, undefined);
      for (const invalid of ['', 'relative-appdata', 'C:\\invalid\npath']) {
        process.env.LOCALAPPDATA = invalid;
        assert.throws(() => isolatedEnvironment('/agentgate', '/temporary'), /host LOCALAPPDATA/);
      }
      delete process.env.LOCALAPPDATA;
      assert.throws(() => isolatedEnvironment('/agentgate', '/temporary'), /host LOCALAPPDATA/);
    } finally {
      if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = previousLocalAppData;
    }
  },
);

test('session policy separates controller state and grants only the chosen worktree', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentgate-policy-'));
  const workspace = join(directory, 'workspace');
  await mkdir(workspace);
  const session = await createSandboxSession(join(directory, 'home'), workspace, true);
  const codexHome = await realpath(join(directory, 'home', 'codex'));
  try {
    assert.ok(session.configArgs.includes('project_root_markers=[]'));
    assert.ok(session.configArgs.includes('web_search="disabled"'));
    assert.ok(session.configArgs.some((argument) => argument.endsWith('.network.enabled=false')));
    assert.ok(session.configArgs.some((argument) => argument.includes('":root"="deny"')));
    assert.ok(
      session.configArgs.some(
        (argument) =>
          argument.includes(JSON.stringify(codexHome)) &&
          argument.includes(`${JSON.stringify(codexHome)}="deny"`),
      ),
    );
    assert.equal(
      session.configArgs.includes('windows.sandbox="mxc"'),
      process.platform === 'win32',
    );
    assert.ok(!session.configArgs.includes('windows.sandbox="elevated"'));
    assert.ok(!session.configArgs.includes('windows.sandbox="unelevated"'));
    assert.ok(!session.configArgs.includes('features.prefer_mxc=true'));
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
    // A real leaf below a redirected ancestor must also be rejected.
    await mkdir(join(outside, 'nested'));
    await assert.rejects(
      createSandboxSession(join(linkedWorktree, 'nested', 'home')),
      /real canonical directories/,
    );
    assert.deepEqual(await readdir(join(outside, 'nested')), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  'Windows short directory aliases use canonical policy paths without accepting junctions',
  {
    skip: process.platform !== 'win32',
  },
  async (context) => {
    const directory = await mkdtemp(join(tmpdir(), 'agentgate short alias fixture-'));
    // Read-only fixed command: only a controller-generated fixture path enters via the environment.
    const script = 'for %I in ("%AGENTGATE_SHORT_PATH%") do @echo %~sI';
    try {
      const result = spawnSync(
        join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'),
        ['/d', '/s', '/c', script],
        {
          env: {
            SystemRoot: process.env.SystemRoot,
            TEMP: tmpdir(),
            TMP: tmpdir(),
            AGENTGATE_SHORT_PATH: directory,
          },
          encoding: 'utf8',
          shell: false,
          windowsHide: true,
          windowsVerbatimArguments: true,
          timeout: 10_000,
        },
      );
      assert.equal(result.status, 0, result.error?.message ?? result.stderr);
      const shortPath = result.stdout.trim();
      assert.equal(await realpath(shortPath), await realpath(directory));
      if (!shortPath.includes('~')) {
        context.skip('This filesystem does not generate DOS 8.3 aliases.');
        return;
      }
      const workspace = join(shortPath, 'workspace');
      await mkdir(workspace);
      const session = await createSandboxSession(join(shortPath, 'home'), workspace, true);
      try {
        assert.equal(session.env.CODEX_HOME, await realpath(join(directory, 'home', 'codex')));
        const canonicalWorkspace = await realpath(workspace);
        assert.ok(
          session.configArgs.some((argument) =>
            argument.includes(`${JSON.stringify(canonicalWorkspace)}="write"`),
          ),
        );
        assert.ok(!session.launcher.includes('~'));
      } finally {
        await session.cleanup();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

function prerequisiteExecutor(
  options: {
    badVersion?: boolean;
    version?: string;
    enabledFeature?: boolean;
    enabledMcp?: boolean;
    apiAuth?: boolean;
  } = {},
): Executor {
  return async ({ args }) => {
    let stdout = '';
    if (args.includes('--version'))
      stdout = `codex-cli ${options.badVersion ? '999.0.0' : (options.version ?? CODEX_VERSION)}`;
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
    assert.deepEqual(await readdir(join(directory, 'runtime')), []);
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

test('doctor preserves launchers and probe fixtures until uncertain termination is resolved', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agentgate-doctor-preservation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const stage of ['prerequisite', 'probe']) {
    for (const nested of [false, true]) {
      const home = join(directory, `${stage}-${nested}`);
      const termination = new ProcessError('termination', 'Fake unverified worker shutdown.');
      const failure = nested
        ? new Error('Wrapped fixture failure', { cause: new AggregateError([termination]) })
        : termination;
      const launchers = new Set<string>();
      const prerequisites = prerequisiteExecutor();
      const sandbox = new CodexSandbox({
        home,
        connectivity: async () => true,
        executor: async (options) => {
          launchers.add(options.cwd!);
          if (
            stage === 'prerequisite' ||
            (options.args.includes('sandbox') && !options.args.includes('--help'))
          )
            throw failure;
          return prerequisites(options);
        },
      });

      await assert.rejects(sandbox.doctor(), (error) => error === failure);

      assert.equal(launchers.size, stage === 'probe' ? 2 : 1);
      for (const launcher of launchers) await access(launcher);
      const probes = (await readdir(join(home, 'runtime'))).filter((name) =>
        name.startsWith('probe-'),
      );
      assert.equal(probes.length, stage === 'probe' ? 1 : 0);
      if (stage === 'probe') await access(join(home, 'runtime', probes[0]!, 'fake-secret.txt'));
    }
  }
});

test('doctor cleans native probe fixtures after a verified timeout or cancellation', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agentgate-doctor-cleanup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const kind of ['timeout', 'aborted'] as const) {
    const home = join(directory, kind);
    const prerequisites = prerequisiteExecutor();
    const sandbox = new CodexSandbox({
      home,
      connectivity: async () => true,
      executor: async (options) => {
        if (options.args.includes('sandbox') && !options.args.includes('--help'))
          throw new ProcessError(kind, 'Fake worker shutdown was verified.');
        return prerequisites(options);
      },
    });

    const checks = await sandbox.doctor();

    assert.equal(checks.find((check) => check.name === 'sandbox-read')?.ok, false);
    assert.deepEqual(await readdir(join(home, 'runtime')), []);
  }
});

test('doctor rejects the other platform contract before executing a sandbox command', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agentgate-platform-version-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const incompatibleVersion = process.platform === 'win32' ? '0.154.0' : '0.166.0';
  const commands: string[][] = [];
  const executor = prerequisiteExecutor({ version: incompatibleVersion });
  const sandbox = new CodexSandbox({
    home: directory,
    executor: async (options) => {
      commands.push([...options.args]);
      return executor(options);
    },
  });
  const checks = await sandbox.doctor();
  assert.equal(checks.find((check) => check.name === 'codex-version')?.ok, false);
  assert.equal(commands.length, 1);
  assert.ok(commands[0]!.includes('--version'));
});

test(
  'unavailable Windows MXC fails without admin setup or a legacy fallback',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'agentgate-mxc-unavailable-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const prerequisites = prerequisiteExecutor();
    const sandboxCommands: ExecuteOptions[] = [];
    const sandbox = new CodexSandbox({
      home: directory,
      connectivity: async () => true,
      executor: async (options) => {
        if (!options.args.includes('sandbox') || options.args.includes('--help'))
          return prerequisites(options);
        sandboxCommands.push(options);
        return {
          exitCode: 1,
          stdout: '',
          stderr: 'error: MXC isolation is unavailable on this host',
          durationMs: 1,
        };
      },
    });
    const checks = await sandbox.doctor();
    assert.equal(checks.find((check) => check.name === 'sandbox-read')?.ok, false);
    assert.match(checks.find((check) => check.name === 'sandbox-read')!.detail, /MXC.*unavailable/);
    assert.equal(sandboxCommands.length, 1);
    assert.ok(sandboxCommands[0]!.args.includes('windows.sandbox="mxc"'));
    assert.ok(!sandboxCommands[0]!.args.includes('setup'));
    assert.ok(!checks.some((check) => check.name === 'windows-sandbox-setup'));
    await assert.rejects(access(join(directory, 'codex', '.sandbox')), { code: 'ENOENT' });
  },
);

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
    await assert.rejects(access(captured!.cwd!), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('check preserves uncertain worker scratch but cleans verified stopped workers', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agentgate-check-preservation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const worktree = join(directory, 'checkout');
  await mkdir(worktree);
  class FakeVerifiedSandbox extends CodexSandbox {
    override async doctor() {
      return [{ name: 'unit-test', ok: true, detail: 'Fake; not native isolation evidence.' }];
    }
  }
  for (const kind of ['termination', 'nested-termination', 'timeout', 'aborted'] as const) {
    const cause = new ProcessError(
      kind === 'nested-termination' ? 'termination' : kind,
      'Fake worker exit state.',
    );
    const failure = kind === 'nested-termination' ? new AggregateError([cause]) : cause;
    let launcher: string | undefined;
    const sandbox = new FakeVerifiedSandbox({
      home: join(directory, kind),
      executor: async (options) => {
        launcher = options.cwd;
        throw failure;
      },
    });

    await assert.rejects(
      sandbox.check(
        { name: 'fixture', command: process.execPath, args: ['--version'], timeoutMs: 1000 },
        worktree,
      ),
      (error) => error === failure,
    );

    assert.ok(launcher);
    if (kind.includes('termination')) await access(launcher);
    else await assert.rejects(access(launcher), { code: 'ENOENT' });
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
  const prerequisites = prerequisiteExecutor();
  let exposeSentinel = false;
  let exposeLoopback = false;
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
          loopback: exposeLoopback,
          egress: false,
          credentials: false,
          unexpectedPrivateText: 'FAKE_PRIVATE_TEXT_MUST_NOT_REACH_DIAGNOSTICS',
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
    await assert.rejects(access(join(directory, 'codex', '.sandbox')), { code: 'ENOENT' });
    baseline = false;
    assert.equal(
      (await sandbox.doctor()).find((check) => check.name === 'sandbox-read-network')?.ok,
      false,
    );
    baseline = true;
    exposeSentinel = true;
    const failedRead = (await sandbox.doctor()).find((check) => check.name === 'sandbox-read')!;
    assert.equal(failedRead.ok, false);
    assert.match(failedRead.detail, /readSentinel=true/);
    assert.ok(!failedRead.detail.includes('FAKE_PRIVATE_TEXT'));
    exposeSentinel = false;
    exposeLoopback = true;
    const failedNetwork = (await sandbox.doctor()).find(
      (check) => check.name === 'sandbox-read-network',
    )!;
    assert.equal(failedNetwork.ok, false);
    assert.match(failedNetwork.detail, /loopback=true, publicEgress=false/);
    assert.ok(!failedNetwork.detail.includes('FAKE_PRIVATE_TEXT'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
