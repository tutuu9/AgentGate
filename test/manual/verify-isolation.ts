import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer, type Socket } from 'node:net';
import { arch, platform, release, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  CODEX_VERSION,
  createSandboxSession,
  isolatedEnvironment,
  type SandboxSession,
} from '../../src/adapters/sandbox.ts';
import { execute } from '../../src/adapters/process.ts';
import { hasUncertainTermination } from '../../src/core/errors.ts';
import { cleanTerminal, redact } from '../../src/core/safety.ts';
import { FileRunStore } from '../../src/core/store.ts';

// Manual only: npm test excludes this directory. No model, login, or real credential calls.
// State homes are retained for diagnostics; cleanup removes only owned fixtures and sessions.
const credentials =
  'GH_TOKEN GITHUB_TOKEN OPENAI_API_KEY CODEX_API_KEY ANTHROPIC_API_KEY SSH_AUTH_SOCK'.split(' ');
const abort = new AbortController();
const interrupt = () => abort.abort(new Error('Acceptance probe cancelled.'));
const emit = (value: unknown) =>
  process.stdout.write(`${cleanTerminal(redact(JSON.stringify(value)))}\n`);

function inside(parent: string, path: string): boolean {
  const child = relative(parent, path);
  return (
    Boolean(child) &&
    !isAbsolute(child) &&
    child !== '..' &&
    !child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
  );
}

async function checkedDirectory(path: string): Promise<string> {
  for (let current = resolve(path); ; current = dirname(current)) {
    const entry = await lstat(current);
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw new Error('Refusing a redirected fixture directory.');
    if (dirname(current) === current) return realpath(path);
  }
}

async function prospectiveDirectory(path: string): Promise<string> {
  const missing: string[] = [];
  for (let ancestor = resolve(path); ; ancestor = dirname(ancestor)) {
    try {
      await lstat(ancestor);
      return resolve(await checkedDirectory(ancestor), ...missing);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        error.code !== 'ENOENT' ||
        dirname(ancestor) === ancestor
      )
        throw error;
      missing.unshift(basename(ancestor));
    }
  }
}

async function fixture(parent: string, prefix: string) {
  parent = await checkedDirectory(parent);
  const path = await checkedDirectory(await mkdtemp(join(parent, prefix)));
  const identity = await lstat(path, { bigint: true });
  return {
    path,
    async cleanup() {
      const canonical = await checkedDirectory(path);
      const current = await lstat(path, { bigint: true });
      if (
        canonical !== path ||
        !inside(parent, canonical) ||
        current.dev !== identity.dev ||
        current.ino !== identity.ino
      )
        throw new Error('Fixture identity changed; preserving it.');
      await rm(path, { recursive: true, force: false });
    },
  };
}

async function connect(host: string, port: number): Promise<boolean> {
  abort.signal.throwIfAborted();
  return new Promise((resolveConnection, reject) => {
    const socket = createConnection({ host, port });
    const cancel = () => {
      socket.destroy();
      reject(abort.signal.reason);
    };
    const finish = (value: boolean) => {
      abort.signal.removeEventListener('abort', cancel);
      socket.destroy();
      resolveConnection(value);
    };
    abort.signal.addEventListener('abort', cancel, { once: true });
    socket.setTimeout(1500, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function listener(host: string) {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.end();
  });
  await new Promise<void>((ready, reject) => {
    server.once('error', reject);
    server.listen({ host, port: 0, ipv6Only: host === '::1' }, ready);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Controller listener unavailable.');
  return {
    host,
    port: address.port,
    async baseline() {
      return connect(host, address.port);
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((closed) => server.close(() => closed()));
    },
  };
}

async function withSession<T>(
  home: string,
  workspace: string | undefined,
  writable: boolean,
  operation: (session: SandboxSession) => Promise<T>,
): Promise<T> {
  const session = await createSandboxSession(home, workspace, writable);
  let uncertain = false;
  try {
    return await operation(session);
  } catch (error) {
    uncertain = hasUncertainTermination(error);
    throw error;
  } finally {
    if (!uncertain) await session.cleanup();
  }
}

const SCRIPT = String.raw`
const fs = require('node:fs');
const net = require('node:net');
const {spawnSync} = require('node:child_process');
const p = JSON.parse(process.argv[1]);
function attempt(fn) { try { fn(); return true; } catch { return false; } }
function connect(host, port) { return new Promise(resolve => {
  const s = net.createConnection({host, port});
  const done = value => {s.destroy(); resolve(value)};
  s.setTimeout(1500, () => done(false)); s.once('connect', () => done(true)); s.once('error', () => done(false));
}); }
(async () => {
  const initiallyAbsent = !fs.existsSync(p.reads.postStart);
  if (!p.child) {
    fs.writeFileSync(p.ready, p.nonce, {flag: 'wx'});
    const deadline = Date.now() + 15000;
    while (!attempt(() => {if (fs.readFileSync(p.proceed, 'utf8') !== p.nonce) throw new Error()})) {
      if (Date.now() > deadline) throw new Error('Handshake timed out');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  const observations = {
    reads: Object.fromEntries(Object.entries(p.reads).map(([name,path]) => [name,attempt(() => fs.readFileSync(path))])),
    writes: Object.fromEntries(Object.entries(p.writes).map(([name,path]) => [name,attempt(() => fs.writeFileSync(path,'fake fixture data'))])),
    gitRemovable: attempt(() => fs.unlinkSync(p.writes.git)),
    loopback4: await connect('127.0.0.1', p.port4), loopback6: await connect('::1', p.port6),
    credentials: p.credentials.some(name => Boolean(process.env[name]))
  };
  if (p.child) return console.log(JSON.stringify(observations));
  const child = spawnSync(process.execPath, ['-e', process.argv[2], JSON.stringify({...p,child:true}), process.argv[2]], {
    shell: false, windowsHide: true, encoding: 'utf8', timeout: 6000, maxBuffer: 8192
  });
  if (child.status !== 0 || child.error) throw new Error('Child probe did not complete');
  console.log(JSON.stringify({initiallyAbsent,observations,child:JSON.parse(child.stdout.trim())}));
})().catch(() => process.exit(2));`;

const Observation = z
  .object({
    reads: z.record(z.string(), z.boolean()),
    writes: z.record(z.string(), z.boolean()),
    gitRemovable: z.boolean(),
    loopback4: z.boolean(),
    loopback6: z.boolean(),
    credentials: z.boolean(),
  })
  .strict();
const Result = z
  .object({ initiallyAbsent: z.boolean(), observations: Observation, child: Observation })
  .strict();

async function waitReady(
  path: string,
  nonce: string,
  stopped: () => boolean,
  signal: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    try {
      if ((await readFile(path, 'utf8')) !== nonce) throw new Error('Unexpected handshake marker.');
      return;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
    if (stopped()) throw new Error('Sandbox exited before the readiness handshake.');
    await delay(25, undefined, { signal });
  }
  throw new Error('Sandbox readiness handshake timed out.');
}

async function runStage(
  codexPath: string,
  home: string,
  root: string,
  outside: string,
  ports: [number, number],
  writable: boolean,
) {
  const workspace = join(root, writable ? 'write-workspace' : 'readonly-workspace');
  await mkdir(workspace);
  const files = {
    existing: 'allowed.txt',
    git: '.git',
    agents: '.agents/settings.txt',
    codex: '.codex/settings.txt',
    aws: '.aws/settings.txt',
  };
  for (const directory of ['.agents', '.codex', '.aws']) await mkdir(join(workspace, directory));
  for (const file of Object.values(files))
    await writeFile(join(workspace, file), 'fake fixture only', { flag: 'wx' });
  return withSession(home, workspace, writable, async (session) => {
    const nonce = randomUUID();
    const reads = {
      workspace: join(workspace, 'allowed.txt'),
      outsideHomeFixture: join(root, 'sentinel.txt'),
      outside: join(outside, 'sentinel.txt'),
      postStart: join(outside, `${nonce}-post-start.txt`),
    };
    const writes = {
      ...Object.fromEntries(
        Object.entries(files).map(([key, value]) => [key, join(workspace, value)]),
      ),
      newFile: join(workspace, 'new.txt'),
      outside: join(outside, `${nonce}-write.txt`),
    };
    const data = {
      nonce,
      reads,
      writes,
      ready: join(session.env.TEMP!, 'ready.txt'),
      proceed: join(session.env.TEMP!, 'continue.txt'),
      port4: ports[0],
      port6: ports[1],
      credentials,
    };
    const source = {
      ...process.env,
      ...Object.fromEntries(credentials.map((name) => [name, `FAKE_ACCEPTANCE_${nonce}`])),
    };
    const env = isolatedEnvironment(home, session.env.TEMP!, source);
    const stageAbort = new AbortController();
    const signal = AbortSignal.any([abort.signal, stageAbort.signal]);
    let stopped = false;
    const execution = execute({
      command: codexPath,
      args: [
        ...session.configArgs,
        'sandbox',
        '--include-managed-config',
        '-P',
        session.profile,
        '-C',
        session.launcher,
        '--',
        process.execPath,
        '-e',
        SCRIPT,
        JSON.stringify(data),
        SCRIPT,
      ],
      cwd: session.launcher,
      env,
      signal,
      timeoutMs: 40_000,
      maxOutputBytes: 64 * 1024,
    })
      .then(
        (result) => ({ result }),
        (error) => ({ error }),
      )
      .finally(() => {
        stopped = true;
      });
    let handshakeError: unknown;
    try {
      await waitReady(data.ready, nonce, () => stopped, signal);
      if (!inside(outside, reads.postStart))
        throw new Error('Post-start file escaped its owned fixture.');
      await writeFile(reads.postStart, 'fake post-start fixture only', { flag: 'wx' });
      await writeFile(data.proceed, nonce, { flag: 'wx' });
    } catch (error) {
      handshakeError = error;
      stageAbort.abort(error);
    }
    const outcome = await execution;
    if ('error' in outcome) throw outcome.error;
    if (handshakeError) throw handshakeError;
    if (outcome.result.exitCode !== 0)
      throw new Error(`Sandbox fixture exited ${outcome.result.exitCode}; raw output discarded.`);
    let value: unknown;
    try {
      value = JSON.parse(outcome.result.stdout.trim());
    } catch {
      throw new Error('Invalid fixture JSON; raw output discarded.');
    }
    const result = Result.parse(value);
    const conforms = (observed: z.infer<typeof Observation>) =>
      Object.keys(reads).every((key) => observed.reads[key] === (key === 'workspace')) &&
      Object.keys(writes).every(
        (key) => observed.writes[key] === (writable && ['existing', 'newFile'].includes(key)),
      ) &&
      !observed.gitRemovable &&
      !observed.loopback4 &&
      !observed.loopback6 &&
      !observed.credentials;
    const strippedInController = credentials.every((name) => env[name] === undefined);
    return {
      passed:
        result.initiallyAbsent &&
        strippedInController &&
        conforms(result.observations) &&
        conforms(result.child),
      strippedInController,
      ...result,
    };
  });
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { home: { type: 'string' } },
  });
  if (positionals.length !== 1 || !isAbsolute(positionals[0]!))
    throw new Error(
      'Provide an absolute candidate Codex executable, optionally --home <state-directory>.',
    );
  if (process.versions.node.split('.')[0] !== '24') throw new Error('Node.js 24 is required.');
  const codexPath = await realpath(positionals[0]!);
  const repository = await checkedDirectory(fileURLToPath(new URL('../..', import.meta.url)));
  const temporary = await checkedDirectory(tmpdir());
  if (!values.home && (temporary === repository || inside(repository, temporary)))
    throw new Error('Default state requires a temp directory outside the repository.');
  const home = values.home
    ? await prospectiveDirectory(values.home)
    : await mkdtemp(join(temporary, 'agentgate-manual-home-'));
  if (home === repository || inside(repository, home))
    throw new Error('Keep the state directory outside the repository.');
  const store = new FileRunStore(home);
  await store.init();
  const unlock = await store.acquireLock();
  const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
  const listeners: Awaited<ReturnType<typeof listener>>[] = [];
  let uncertain = false;
  let passed = true;
  try {
    await withSession(home, undefined, false, async (session) => {
      const result = await execute({
        command: codexPath,
        args: [...session.configArgs, '--version'],
        cwd: session.launcher,
        env: session.env,
        signal: abort.signal,
        timeoutMs: 10_000,
        maxOutputBytes: 4096,
      });
      const version = /^codex-cli (\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)$/.exec(
        result.stdout.trim(),
      );
      if (result.exitCode !== 0 || !version)
        throw new Error('Candidate version unavailable; raw output discarded.');
      const mode = session.configArgs.find((value) => value.startsWith('windows.sandbox='));
      emit({
        phase: 'environment',
        os: platform(),
        osVersion: release(),
        architecture: arch(),
        nodeVersion: process.version,
        codexVersion: version[1],
        adapterCodexVersion: CODEX_VERSION,
        windowsSandbox: mode ? JSON.parse(mode.slice('windows.sandbox='.length)) : undefined,
        stateHome: home,
        freshHome: values.home === undefined,
        stateHomeRetained: true,
        modelInvoked: false,
      });
    });
    const root = await fixture(join(home, 'runtime'), 'extended-probe-');
    fixtures.push(root);
    const outside = await fixture(temporary, 'agentgate-outside-probe-');
    fixtures.push(outside);
    if (inside(await realpath(home), outside.path))
      throw new Error('Second fixture is not outside the controller home.');
    for (const entry of fixtures)
      await writeFile(join(entry.path, 'sentinel.txt'), 'fake acceptance sentinel only', {
        flag: 'wx',
      });
    for (const host of ['127.0.0.1', '::1']) listeners.push(await listener(host));
    for (const writable of [false, true]) {
      abort.signal.throwIfAborted();
      const baselineBefore = await Promise.all(listeners.map((entry) => entry.baseline()));
      if (!baselineBefore.every(Boolean))
        throw new Error('Controller loopback baseline unavailable; isolation is unverified.');
      const result = await runStage(
        codexPath,
        home,
        root.path,
        outside.path,
        [listeners[0]!.port, listeners[1]!.port],
        writable,
      );
      const baselineAfter = await Promise.all(listeners.map((entry) => entry.baseline()));
      const stagePassed = result.passed && baselineAfter.every(Boolean);
      passed &&= stagePassed;
      emit({
        stage: writable ? 'write' : 'read-only',
        baselineBefore,
        baselineAfter,
        ...result,
        passed: stagePassed,
      });
    }
  } catch (error) {
    uncertain = hasUncertainTermination(error);
    throw error;
  } finally {
    for (const entry of listeners) await entry.close();
    try {
      if (!uncertain) for (const entry of fixtures.reverse()) await entry.cleanup();
    } finally {
      if (!uncertain) await unlock();
    }
  }
  emit({ result: passed ? 'passed' : 'failed', modelInvoked: false });
  process.exitCode = passed ? 0 : 2;
}

process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);
main()
  .catch((error) => {
    emit({
      result: 'blocked',
      uncertainTermination: hasUncertainTermination(error),
      error: error instanceof Error ? error.message : 'Acceptance probe failed.',
      modelInvoked: false,
    });
    process.exitCode = 2;
  })
  .finally(() => {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  });
