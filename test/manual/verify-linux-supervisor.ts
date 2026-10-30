import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  stat,
  writeFile,
} from 'node:fs/promises';
import { release, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { execute, ProcessError, type ExecuteResult } from '../../src/adapters/process.ts';
import { createSandboxSession, type SandboxSession } from '../../src/adapters/sandbox.ts';
import { cleanTerminal, redact } from '../../src/core/safety.ts';
import { FileRunStore } from '../../src/core/store.ts';

// Native lifecycle experiment only. The outer namespace adds lifecycle ownership; the
// inner Codex command retains the production filesystem and network permissions.
// Bubblewrap's monitor returns its initial command's status; --die-with-parent
// ties the built-in PID 1 reaper to that monitor, including detached descendants.
const outerArguments = [
  '--unshare-user',
  '--unshare-pid',
  '--die-with-parent',
  '--bind',
  '/',
  '/',
  '--proc',
  '/proc',
  '--',
];
const scenarios = ['normal-exit', 'aborted', 'timeout', 'output-limit'] as const;
type Scenario = (typeof scenarios)[number];
type Outcome = { result: ExecuteResult } | { error: unknown };
const abort = new AbortController();
const interrupt = () => abort.abort();
const emit = (value: unknown) =>
  process.stdout.write(`${cleanTerminal(redact(JSON.stringify(value)))}\n`);
const safetyExitMs = 45_000;
// FD 6 avoids the fixed pipe transport's FDs 3/4/5. Bubblewrap closes its status
// descriptor in the namespace child before launching Codex (v0.9.0, line 2825).
const statusLauncher = 'umask 077; set -o noclobber; exec 6> "$1" || exit 125; shift; exec "$@"';

interface NamespaceInit {
  pid: number;
  startTime: string;
  namespace?: string;
}

const childSource = `
const fs = require('node:fs');
const [heartbeat, ready, nonce] = process.argv.slice(1);
const fields = fs.readFileSync('/proc/self/stat', 'utf8').split(') ').at(-1).split(' ');
fs.writeFileSync(ready, JSON.stringify({nonce, pid:process.pid, group:Number(fields[2]), session:Number(fields[3])}), {flag:'wx'});
setInterval(() => fs.appendFileSync(heartbeat, nonce + '\\n'), 25);
setTimeout(() => process.exit(0), ${safetyExitMs});
`;
const parentSource = `
const fs = require('node:fs');
const {spawn} = require('node:child_process');
const [heartbeat, ready, proceed, nonce, scenario, source, metadata, descriptorReport] = process.argv.slice(1);
let metadataDescriptorInherited = false;
for (const descriptor of fs.readdirSync('/proc/self/fd')) {
  try { if (fs.readlinkSync('/proc/self/fd/' + descriptor) === metadata) metadataDescriptorInherited = true; } catch {}
}
fs.writeFileSync(descriptorReport, JSON.stringify({nonce, metadataDescriptorInherited}), {flag:'wx'});
if (metadataDescriptorInherited) process.exit(126);
const child = spawn(process.execPath, ['-e', source, heartbeat, ready, nonce], {shell:false, detached:true, stdio:'ignore'});
child.on('error', () => process.exit(127));
child.unref();
const poll = setInterval(() => {
  if (!fs.existsSync(proceed)) return;
  clearInterval(poll);
  if (scenario === 'normal-exit') process.exit(37);
  if (scenario === 'output-limit') {
    const chunk = Buffer.alloc(8192, 'x');
    setInterval(() => fs.writeSync(1, chunk), 5);
  }
}, 25);
setTimeout(() => process.exit(125), ${safetyExitMs});
`;

async function readReady(path: string, nonce: string): Promise<boolean> {
  try {
    const data: unknown = JSON.parse(await readFile(path, 'utf8'));
    assert.ok(data !== null && typeof data === 'object');
    assert.ok('nonce' in data && data.nonce === nonce);
    assert.ok('pid' in data && typeof data.pid === 'number' && data.pid > 1);
    assert.ok('group' in data && data.group === data.pid);
    assert.ok('session' in data && data.session === data.pid);
    return true;
  } catch (error) {
    if (
      error instanceof SyntaxError ||
      (error instanceof Error && 'code' in error && error.code === 'ENOENT')
    )
      return false;
    throw error;
  }
}

async function heartbeatSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return 0;
    throw error;
  }
}

async function processIdentity(pid: number): Promise<{ state: string; startTime: string } | null> {
  try {
    const record = await readFile(`/proc/${pid}/stat`, 'utf8');
    assert.ok(record.startsWith(`${pid} (`));
    const fields = record.slice(record.lastIndexOf(') ') + 2).split(' ');
    const state = fields[0];
    const startTime = fields[19];
    assert.ok(state && /^[A-Za-z]$/.test(state));
    assert.ok(startTime && /^\d+$/.test(startTime));
    return { state, startTime };
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function captureNamespaceInit(path: string): Promise<NamespaceInit> {
  const entry = await lstat(path);
  assert.ok(entry.isFile() && !entry.isSymbolicLink() && entry.size <= 16_384);
  assert.equal(entry.uid, process.getuid!());
  assert.equal(entry.mode & 0o077, 0);
  const line = (await readFile(path, 'utf8')).split('\n')[0];
  assert.ok(line);
  const status: unknown = JSON.parse(line);
  assert.ok(status !== null && typeof status === 'object' && 'child-pid' in status);
  const pid = status['child-pid'];
  assert.ok(typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 1);
  const identity = await processIdentity(pid);
  assert.ok(identity && identity.state !== 'Z' && identity.state !== 'X');
  const hostStatus = await readFile(`/proc/${pid}/status`, 'utf8');
  const namespacePids = /^NSpid:[ \t]+([0-9 \t]+)$/m.exec(hostStatus)?.[1]?.trim().split(/\s+/);
  assert.ok(namespacePids && namespacePids.length >= 2);
  assert.equal(Number(namespacePids[0]), pid);
  assert.equal(Number(namespacePids.at(-1)), 1);
  let namespace: string | undefined;
  try {
    namespace = await readlink(`/proc/${pid}/ns/pid`);
    assert.notEqual(namespace, await readlink('/proc/self/ns/pid'));
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EACCES')) throw error;
  }
  const confirmed = await processIdentity(pid);
  assert.ok(confirmed && confirmed.state !== 'Z' && confirmed.state !== 'X');
  assert.equal(confirmed.startTime, identity.startTime, 'PID 1 changed during observation.');
  return { pid, startTime: identity.startTime, namespace };
}

async function requireNamespaceStopped(init: NamespaceInit): Promise<void> {
  const deadline = Date.now() + 2_000;
  do {
    const identity = await processIdentity(init.pid);
    if (
      !identity ||
      identity.startTime !== init.startTime ||
      identity.state === 'Z' ||
      identity.state === 'X'
    )
      return;
    await delay(25);
  } while (Date.now() < deadline);
  throw new ProcessError('termination', 'The exact owned outer namespace init is still alive.');
}

function nativeArguments(session: SandboxSession, args: string[]): string[] {
  return [
    ...session.configArgs,
    'sandbox',
    '--include-managed-config',
    '-P',
    session.profile,
    '-C',
    session.launcher,
    '--',
    process.execPath,
    ...args,
  ];
}

async function verifyScenario(codexPath: string, home: string, root: string, scenario: Scenario) {
  const workspace = join(root, scenario);
  await mkdir(workspace);
  const session = await createSandboxSession(home, workspace, true, codexPath);
  const nonce = randomUUID();
  const heartbeat = join(workspace, 'heartbeat');
  const ready = join(workspace, 'ready.json');
  const proceed = join(workspace, 'proceed');
  const metadata = join(home, 'runtime', `namespace-${nonce}.jsonl`);
  const descriptorReport = join(workspace, 'descriptor-report.json');
  const stop = new AbortController();
  const started = Date.now();
  let uncertain = false;
  let settled: Outcome | undefined;
  const execution: Promise<Outcome> = execute({
    command: '/bin/bash',
    args: [
      '--noprofile',
      '--norc',
      '-p',
      '-c',
      statusLauncher,
      'agentgate-supervisor-status',
      metadata,
      '/usr/bin/bwrap',
      '--json-status-fd',
      '6',
      ...outerArguments,
      session.codexExecutable ?? codexPath,
      ...nativeArguments(session, [
        '-e',
        parentSource,
        heartbeat,
        ready,
        proceed,
        nonce,
        scenario,
        childSource,
        metadata,
        descriptorReport,
      ]),
    ],
    cwd: session.launcher,
    env: session.env,
    linuxPipeTransport: true,
    signal: AbortSignal.any([abort.signal, stop.signal]),
    timeoutMs: scenario === 'timeout' ? 12_000 : 25_000,
    maxOutputBytes: 32 * 1024,
  }).then(
    (result) => (settled = { result }),
    (error: unknown) => (settled = { error }),
  );
  try {
    let readyObserved = false;
    while (Date.now() - started < 8_000 && !settled) {
      abort.signal.throwIfAborted();
      if ((await readReady(ready, nonce)) && (await heartbeatSize(heartbeat)) >= nonce.length * 3) {
        readyObserved = true;
        break;
      }
      await delay(25);
    }
    if (!readyObserved) {
      if (settled && 'result' in settled)
        emit({ phase: 'early-exit', scenario, ...settled.result });
      if (settled && 'error' in settled) throw settled.error;
      throw new Error(`Detached descendant did not become ready for ${scenario}.`);
    }
    const init = await captureNamespaceInit(metadata);
    assert.deepEqual(JSON.parse(await readFile(descriptorReport, 'utf8')), {
      nonce,
      metadataDescriptorInherited: false,
    });
    emit({
      phase: 'detached-descendant-ready',
      scenario,
      workspace,
      ownSessionLeader: true,
      outerInit: init,
      statusDescriptorInheritedBySandboxCommand: false,
    });
    await writeFile(proceed, nonce, { flag: 'wx' });
    if (scenario === 'aborted') stop.abort();
    const outcome = await execution;
    if (scenario === 'normal-exit') {
      if ('error' in outcome) throw outcome.error;
      assert.equal(outcome.result.exitCode, 37, outcome.result.stderr);
    } else {
      assert.ok('error' in outcome && outcome.error instanceof ProcessError);
      assert.equal(outcome.error.kind, scenario);
    }
    await requireNamespaceStopped(init);
    const stopped = await heartbeatSize(heartbeat);
    await delay(1_000);
    if ((await heartbeatSize(heartbeat)) !== stopped)
      throw new ProcessError('termination', `Detached descendant survived ${scenario}.`);
    assert.ok(Date.now() - started < 25_000, 'Observation reached the safety-exit window.');
    emit({
      phase: 'supervisor-lifecycle',
      scenario,
      result: 'passed',
      nativeExecutionClosed: true,
      exactOuterNamespaceInitStopped: true,
      namespaceIdentityComparedWhenReadable: init.namespace !== undefined,
      detachedDescendantHeartbeatStopped: true,
      observedBeforeSafetyExit: true,
      sandboxPidInterpretedAsHostPid: false,
      durationMs: Date.now() - started,
    });
  } catch (error) {
    uncertain = true;
    throw error;
  } finally {
    stop.abort();
    await execution;
    if (!uncertain) await session.cleanup();
  }
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { 'expected-version': { type: 'string' } },
  });
  if (process.platform !== 'linux' || process.versions.node.split('.')[0] !== '24')
    throw new Error('This native supervisor experiment requires Linux and Node.js 24.');
  if (
    positionals.length !== 1 ||
    !isAbsolute(positionals[0]!) ||
    !['0.154.0', '0.166.0'].includes(values['expected-version'] ?? '')
  )
    throw new Error(
      'Usage: node test/manual/verify-linux-supervisor.ts <absolute-native-codex> --expected-version 0.154.0|0.166.0',
    );
  const codexPath = await realpath(positionals[0]!);
  assert.ok((await lstat(codexPath)).isFile());
  assert.equal(await realpath('/usr/bin/bwrap'), '/usr/bin/bwrap');
  assert.ok((await lstat('/usr/bin/bwrap')).isFile());
  const home = await mkdtemp(join(await realpath(tmpdir()), 'agentgate-supervisor-home-'));
  const workspace = await mkdtemp(join(await realpath(tmpdir()), 'agentgate-supervisor-work-'));
  const store = new FileRunStore(home);
  await store.init();
  const unlock = await store.acquireLock();
  let uncertain = false;
  try {
    const versionSession = await createSandboxSession(home, undefined, false, codexPath);
    try {
      for (const [name, command, args, expected] of [
        ['codex', codexPath, ['--version'], `codex-cli ${values['expected-version']}`],
        ['bubblewrap', '/usr/bin/bwrap', ['--version'], 'bubblewrap 0.9.0'],
      ] as const) {
        const result = await execute({
          command,
          args,
          cwd: versionSession.launcher,
          env: versionSession.env,
          timeoutMs: 10_000,
          maxOutputBytes: 4096,
        });
        assert.equal(result.exitCode, 0);
        assert.equal(result.stdout.trim(), expected);
        emit({ phase: 'version', name, version: result.stdout.trim() });
      }
    } finally {
      await versionSession.cleanup();
    }
    emit({
      phase: 'environment',
      scope: 'experimental-linux-native-supervisor',
      kernel: release(),
      node: process.version,
      home,
      workspace,
      outerArguments,
      modelInvoked: false,
      authenticatedWorkflow: false,
      productionAuthorizationChanged: false,
    });
    for (const scenario of scenarios) await verifyScenario(codexPath, home, workspace, scenario);
    emit({ result: 'passed', scope: 'experimental-linux-native-supervisor' });
  } catch (error) {
    uncertain = true;
    throw error;
  } finally {
    if (!uncertain) await unlock();
    emit({ phase: 'fixture-retained', home, workspace, lockRetained: uncertain });
  }
}

process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);
try {
  await main();
} catch (error) {
  emit({
    result: 'blocked',
    scope: 'experimental-linux-native-supervisor',
    error: error instanceof Error ? error.message : 'Unexpected supervisor experiment failure.',
  });
  process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
}
