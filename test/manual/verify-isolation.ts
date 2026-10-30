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
  CodexSandbox,
  createSandboxSession,
  isolatedEnvironment,
  type SandboxSession,
} from '../../src/adapters/sandbox.ts';
import { execute } from '../../src/adapters/process.ts';
import { hasUncertainTermination } from '../../src/core/errors.ts';
import { cleanTerminal, redact } from '../../src/core/safety.ts';
import { FileRunStore } from '../../src/core/store.ts';

// Manual only: npm test excludes this directory. No model or login; doctor checks absent auth.
// State homes are retained for diagnostics; cleanup removes only owned fixtures and sessions.
const credentials =
  'GH_TOKEN GITHUB_TOKEN OPENAI_API_KEY CODEX_API_KEY ANTHROPIC_API_KEY SSH_AUTH_SOCK'.split(' ');
const abort = new AbortController();
let capturedChildStdioCompatible: boolean | undefined;
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
  codexPath: string,
  home: string,
  workspace: string | undefined,
  writable: boolean,
  operation: (session: SandboxSession) => Promise<T>,
): Promise<T> {
  const session = await createSandboxSession(home, workspace, writable, codexPath);
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
function read(path) { try { return fs.readFileSync(path,'utf8'); } catch { return null; } }
async function handshake(ready, proceed) {
  fs.writeFileSync(ready,p.nonce,{flag:'wx'});
  const deadline=Date.now()+15000;
  while(read(proceed)!==p.nonce) {
    if(Date.now()>deadline)throw new Error('Handshake timed out');
    await new Promise(resolve=>setTimeout(resolve,25));
  }
}
function connect(host, port) { return new Promise(resolve => {
  const s = net.createConnection({host, port});
  const done = value => {s.destroy(); resolve(value)};
  s.setTimeout(1500, () => done(false)); s.once('connect', () => done(true)); s.once('error', () => done(false));
}); }
(async () => {
  const initiallyAbsent = !fs.existsSync(p.reads.postStart);
  if (!p.child) await handshake(p.ready,p.proceed);
  const observations = {
    reads: Object.fromEntries(Object.entries(p.reads).map(([name,path]) => [name,attempt(() => fs.readFileSync(path))])),
    writes: Object.fromEntries(Object.entries(p.writes).map(([name,path]) => [name,attempt(() => fs.writeFileSync(path,'fake fixture data'))])),
    canaries: Object.fromEntries(Object.entries(p.canaries).map(([name,path]) => {
      const readBefore=read(path);
      const write=attempt(()=>fs.writeFileSync(path,'worker-'+p.nonce));
      return [name,{readBefore,write,readAfter:read(path)}];
    })),
    gitRemovable: attempt(() => fs.unlinkSync(p.writes.git)),
    loopback4: await connect('127.0.0.1', p.port4), loopback6: await connect('::1', p.port6),
    credentials: p.credentials.some(name => Boolean(process.env[name]))
  };
  const stage=p.child?p.childHandshake:p.directHandshake;
  fs.writeFileSync(stage.report,JSON.stringify(observations),{flag:'wx'});
  await handshake(stage.ready,stage.proceed);
  // This nested Node spawn creates socketpairs inside seccomp; report on the descriptor
  // directly because Node's console socket classification needs denied network syscalls.
  if (p.child) return fs.writeSync(1, JSON.stringify(observations) + '\n');
  const child = spawnSync(process.execPath, ['-e', process.argv[2], JSON.stringify({...p,child:true}), process.argv[2]], {
    shell: false, windowsHide: true, encoding: 'utf8', timeout: 15000, maxBuffer: 8192
  });
  if (child.status !== 0 || child.error) throw new Error('Child probe did not complete');
  console.log(JSON.stringify({initiallyAbsent,observations,child:JSON.parse(child.stdout.trim())}));
})().catch(() => process.exit(2));`;

const Observation = z
  .object({
    reads: z.record(z.string(), z.boolean()),
    writes: z.record(z.string(), z.boolean()),
    canaries: z.record(
      z.string(),
      z
        .object({
          readBefore: z.string().nullable(),
          write: z.boolean(),
          readAfter: z.string().nullable(),
        })
        .strict(),
    ),
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
  return withSession(codexPath, home, workspace, writable, async (session) => {
    const nonce = randomUUID();
    const reads = {
      workspace: join(workspace, 'allowed.txt'),
      outsideHomeFixture: join(root, 'sentinel.txt'),
      outside: join(outside, 'sentinel.txt'),
      postStart: join(outside, `${nonce}-post-start.txt`),
    };
    const outsideWrites = {
      outsideHomeFixture: join(root, `${nonce}-write.txt`),
      outside: join(outside, `${nonce}-write.txt`),
    };
    const canaries = {
      outsideHomeFixture: join(root, `${nonce}-canary.txt`),
      outside: join(outside, `${nonce}-canary.txt`),
    };
    const originalCanaries = await Promise.all(
      Object.entries(canaries).map(async ([name, path]) => {
        const content = `FAKE-OUTSIDE-${randomUUID()}`;
        await writeFile(path, content, { flag: 'wx' });
        return { name, path, content, identity: await lstat(path, { bigint: true }) };
      }),
    );
    const writes = {
      ...Object.fromEntries(
        Object.entries(files).map(([key, value]) => [key, join(workspace, value)]),
      ),
      newFile: join(workspace, 'new.txt'),
      ...outsideWrites,
    };
    const handshakePaths = (name: string) => ({
      report: join(session.env.TEMP!, `${name}-report.json`),
      ready: join(session.env.TEMP!, `${name}-ready.txt`),
      proceed: join(session.env.TEMP!, `${name}-continue.txt`),
    });
    const data = {
      nonce,
      reads,
      writes,
      canaries,
      ready: join(session.env.TEMP!, 'ready.txt'),
      proceed: join(session.env.TEMP!, 'continue.txt'),
      directHandshake: handshakePaths('direct'),
      childHandshake: handshakePaths('child'),
      port4: ports[0],
      port6: ports[1],
      credentials,
    };
    const absent = async (path: string) => {
      try {
        await lstat(path);
        return false;
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return true;
        throw error;
      }
    };
    const hostSnapshot = async () => {
      const newOutsideFilesAbsent = Object.fromEntries(
        await Promise.all(
          Object.entries(outsideWrites).map(async ([name, path]) => [name, await absent(path)]),
        ),
      );
      const hostCanaries = Object.fromEntries(
        await Promise.all(
          originalCanaries.map(async (original) => {
            let bytesUnchanged = false;
            let identityUnchanged = false;
            try {
              const identity = await lstat(original.path, { bigint: true });
              bytesUnchanged = (await readFile(original.path, 'utf8')) === original.content;
              identityUnchanged =
                identity.dev === original.identity.dev && identity.ino === original.identity.ino;
            } catch (error) {
              if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT')
                throw error;
            }
            return [original.name, { bytesUnchanged, identityUnchanged }];
          }),
        ),
      );
      const workspaceExistingMatches =
        (await readFile(join(workspace, files.existing), 'utf8')) ===
        (writable ? 'fake fixture data' : 'fake fixture only');
      const workspaceNewMatches = writable
        ? (await readFile(writes.newFile, 'utf8')) === 'fake fixture data'
        : await absent(writes.newFile);
      return { newOutsideFilesAbsent, hostCanaries, workspaceExistingMatches, workspaceNewMatches };
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
      command: session.codexExecutable ?? codexPath,
      linuxPipeTransport: true,
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
    const during: Array<{
      stage: 'direct' | 'child';
      host: Awaited<ReturnType<typeof hostSnapshot>>;
      observation: z.infer<typeof Observation>;
    }> = [];
    try {
      await waitReady(data.ready, nonce, () => stopped, signal);
      if (!inside(outside, reads.postStart))
        throw new Error('Post-start file escaped its owned fixture.');
      await writeFile(reads.postStart, 'fake post-start fixture only', { flag: 'wx' });
      await writeFile(data.proceed, nonce, { flag: 'wx' });
      for (const [stage, handshake] of [
        ['direct', data.directHandshake],
        ['child', data.childHandshake],
      ] as const) {
        await waitReady(handshake.ready, nonce, () => stopped, signal);
        const observation = Observation.parse(JSON.parse(await readFile(handshake.report, 'utf8')));
        if (stopped) throw new Error('Sandbox stopped before live host verification.');
        const host = await hostSnapshot();
        if (stopped) throw new Error('Sandbox stopped during live host verification.');
        during.push({ stage, host, observation });
        await writeFile(handshake.proceed, nonce, { flag: 'wx' });
      }
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
    const after = await hostSnapshot();
    const hostConforms = (host: Awaited<ReturnType<typeof hostSnapshot>>) =>
      Object.keys(outsideWrites).every((name) => host.newOutsideFilesAbsent[name] === true) &&
      Object.keys(canaries).every(
        (name) =>
          host.hostCanaries[name]?.bytesUnchanged === true &&
          host.hostCanaries[name]?.identityUnchanged === true,
      ) &&
      host.workspaceExistingMatches &&
      host.workspaceNewMatches;
    const hostIsolationVerified =
      during.length === 2 &&
      during.every((entry) => hostConforms(entry.host)) &&
      hostConforms(after);
    const reportsMatch =
      JSON.stringify(during[0]?.observation) === JSON.stringify(result.observations) &&
      JSON.stringify(during[1]?.observation) === JSON.stringify(result.child);
    const conforms = (observed: z.infer<typeof Observation>) =>
      Object.keys(reads).every((key) => observed.reads[key] === (key === 'workspace')) &&
      Object.keys(writes).every((key) =>
        key in outsideWrites
          ? typeof observed.writes[key] === 'boolean' && hostIsolationVerified
          : observed.writes[key] === (writable && ['existing', 'newFile'].includes(key)),
      ) &&
      originalCanaries.every(
        (original) =>
          observed.canaries[original.name] !== undefined &&
          observed.canaries[original.name]!.readBefore !== original.content &&
          observed.canaries[original.name]!.readAfter !== original.content,
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
        reportsMatch &&
        hostIsolationVerified &&
        conforms(result.observations) &&
        conforms(result.child),
      strippedInController,
      hostIsolationVerified,
      hostDuring: during.map(({ stage, host }) => ({ stage, ...host })),
      hostAfter: after,
      ...result,
    };
  });
}

async function verifyCommandTransport(codexPath: string, home: string): Promise<boolean> {
  const workspace = await fixture(join(home, 'runtime'), 'command-probe-');
  let uncertain = false;
  try {
    return await withSession(codexPath, home, workspace.path, false, async (session) => {
      const runCommand = (command: string, args: string[], input?: string) =>
        execute({
          command: session.codexExecutable ?? codexPath,
          linuxPipeTransport: true,
          args: [
            ...session.configArgs,
            'sandbox',
            '--include-managed-config',
            '-P',
            session.profile,
            '-C',
            session.launcher,
            '--',
            command,
            ...args,
          ],
          input,
          cwd: session.launcher,
          env: session.env,
          signal: abort.signal,
          timeoutMs: 10_000,
          maxOutputBytes: 8192,
        });
      const commands = [
        {
          name: 'system-printf',
          command: '/usr/bin/printf',
          args: ['agentgate-printf-marker\n'],
          exitCode: 0,
          stdout: 'agentgate-printf-marker\n',
          stderr: '',
        },
        {
          name: 'node-descriptor-write',
          command: process.execPath,
          args: [
            '-e',
            "const fs=require('node:fs');fs.writeSync(1,'agentgate-fd1-marker\\n');fs.writeSync(2,'agentgate-fd2-marker\\n')",
          ],
          exitCode: 0,
          stdout: 'agentgate-fd1-marker\n',
          stderr: 'agentgate-fd2-marker\n',
        },
        {
          name: 'node-pipe-descriptors',
          command: process.execPath,
          args: [
            '-e',
            "const fs=require('node:fs');console.log(JSON.stringify([0,1,2].map(fd=>fs.fstatSync(fd).isFIFO())))",
          ],
          exitCode: 0,
          stdout: '[true,true,true]\n',
          stderr: '',
        },
        {
          name: 'node-stdout',
          command: process.execPath,
          args: ['-e', "console.log('agentgate-node-marker')"],
          exitCode: 0,
          stdout: 'agentgate-node-marker\n',
          stderr: '',
        },
        {
          name: 'node-nonzero',
          command: process.execPath,
          args: ['-e', "console.error('agentgate-exit-marker');process.exitCode=37"],
          exitCode: 37,
          stdout: '',
          stderr: 'agentgate-exit-marker\n',
        },
        {
          name: 'node-delayed-exit',
          command: process.execPath,
          args: [
            '-e',
            "console.log('started');setTimeout(()=>{console.log('finished');process.exitCode=37},250)",
          ],
          exitCode: 37,
          stdout: 'started\nfinished\n',
          stderr: '',
        },
      ];
      let passed = true;
      for (const command of commands) {
        const result = await runCommand(command.command, command.args);
        const commandPassed =
          result.exitCode === command.exitCode &&
          result.stdout === command.stdout &&
          result.stderr === command.stderr;
        passed &&= commandPassed;
        emit({
          phase: 'native-command-transport',
          name: command.name,
          ...result,
          passed: commandPassed,
        });
      }
      if (!passed) {
        const diagnostic = String.raw`
const fs = require('node:fs');
const emit = value => fs.writeSync(1, JSON.stringify(value) + '\n');
const failure = error => error ? {code: error.code, syscall: error.syscall, name: error.name} : null;
for (const fd of [1, 2]) {
  const info = fs.fstatSync(fd);
  emit({fd, fifo: info.isFIFO(), socket: info.isSocket(), characterDevice: info.isCharacterDevice(), procDescriptorVisible: fs.existsSync('/proc/self/fd/' + fd)});
}
for (const [name, stream] of [['stdout', process.stdout], ['stderr', process.stderr]]) {
  emit({name, constructor: stream.constructor.name, type: stream._type ?? null});
  stream.on('error', error => emit({name, event: 'error', error: failure(error)}));
  stream.write('agentgate-stream-marker\n', error => emit({name, event: 'callback', error: failure(error)}));
}
setTimeout(() => emit({event: 'settled', stdoutError: failure(process.stdout.errored), stderrError: failure(process.stderr.errored)}), 250);`;
        const result = await runCommand(process.execPath, ['-e', diagnostic]);
        emit({ phase: 'native-node-stream-diagnostic', ...result, modelInvoked: false });
        throw new Error('Native command output or exit status was not preserved.');
      }

      const outsideFixture = await fixture(join(home, 'runtime'), 'outside-diagnostic-');
      const outsideWorkspace = join(outsideFixture.path, 'workspace');
      await mkdir(outsideWorkspace);
      let outsideUncertain = false;
      let retainOutsideFixture = true;
      try {
        await withSession(codexPath, home, outsideWorkspace, true, async (outsideSession) => {
          const outsideNonce = randomUUID();
          const canary = join(outsideFixture.path, 'canary.txt');
          // This original value is never supplied to the worker, which knows only the file path.
          const originalCanary = `controller-only-${randomUUID()}`;
          await writeFile(canary, originalCanary, { flag: 'wx' });
          const originalIdentity = await lstat(canary, { bigint: true });
          const paths = {
            created: join(outsideFixture.path, 'created.txt'),
            canary,
            positive: join(outsideWorkspace, `positive-${outsideNonce}.txt`),
            report: join(outsideSession.env.TMPDIR!, `report-${outsideNonce}.json`),
            ready: join(outsideSession.env.TMPDIR!, `ready-${outsideNonce}.txt`),
            proceed: join(outsideSession.env.TMPDIR!, `proceed-${outsideNonce}.txt`),
            nonce: outsideNonce,
          };
          const outsideScript = String.raw`
const fs=require('node:fs');const p=JSON.parse(process.argv[1]);
const attempt=fn=>{try{fn();return true}catch{return false}};
const read=path=>{try{return fs.readFileSync(path,'utf8')}catch{return null}};
(async()=>{
  const created=attempt(()=>fs.writeFileSync(p.created,p.nonce,{flag:'wx'}));
  const createdReadback=read(p.created);
  const canaryReadBefore=read(p.canary);
  const canaryWrite=attempt(()=>fs.writeFileSync(p.canary,'worker-'+p.nonce));
  const canaryReadAfter=read(p.canary);
  const positiveWrite=attempt(()=>fs.writeFileSync(p.positive,p.nonce,{flag:'wx'}));
  const positiveReadback=read(p.positive);
  const report={created,createdReadback,canaryReadBefore,canaryWrite,canaryReadAfter,positiveWrite,positiveReadback};
  fs.writeFileSync(p.report,JSON.stringify(report),{flag:'wx'});
  fs.writeFileSync(p.ready,p.nonce,{flag:'wx'});
  const deadline=Date.now()+8000;
  while(read(p.proceed)!==p.nonce){
    if(Date.now()>deadline)throw new Error('Outside diagnostic handshake timed out');
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  console.log(JSON.stringify(report));
})().catch(()=>process.exit(2));`;
          const reportSchema = z
            .object({
              created: z.boolean(),
              createdReadback: z.string().nullable(),
              canaryReadBefore: z.string().nullable(),
              canaryWrite: z.boolean(),
              canaryReadAfter: z.string().nullable(),
              positiveWrite: z.boolean(),
              positiveReadback: z.string().nullable(),
            })
            .strict();
          const hostSnapshot = async () => {
            let createdVisible = false;
            let createdMatches = false;
            try {
              await lstat(paths.created);
              createdVisible = true;
              createdMatches = (await readFile(paths.created, 'utf8')) === outsideNonce;
            } catch (error) {
              if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT')
                throw error;
            }
            let canaryBytesUnchanged = false;
            let canaryIdentityUnchanged = false;
            let positiveWriteVisible = false;
            try {
              const currentIdentity = await lstat(canary, { bigint: true });
              canaryBytesUnchanged = (await readFile(canary, 'utf8')) === originalCanary;
              canaryIdentityUnchanged =
                currentIdentity.dev === originalIdentity.dev &&
                currentIdentity.ino === originalIdentity.ino;
            } catch (error) {
              if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT')
                throw error;
            }
            try {
              positiveWriteVisible = (await readFile(paths.positive, 'utf8')) === outsideNonce;
            } catch (error) {
              if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT')
                throw error;
            }
            return {
              createdVisible,
              createdMatches,
              canaryBytesUnchanged,
              canaryIdentityUnchanged,
              positiveWriteVisible,
            };
          };
          const outsideAbort = new AbortController();
          const outsideSignal = AbortSignal.any([abort.signal, outsideAbort.signal]);
          let outsideStopped = false;
          const outsideExecution = execute({
            command: outsideSession.codexExecutable ?? codexPath,
            linuxPipeTransport: true,
            args: [
              ...outsideSession.configArgs,
              'sandbox',
              '--include-managed-config',
              '-P',
              outsideSession.profile,
              '-C',
              outsideSession.launcher,
              '--',
              process.execPath,
              '-e',
              outsideScript,
              JSON.stringify(paths),
            ],
            cwd: outsideSession.launcher,
            env: outsideSession.env,
            signal: outsideSignal,
            timeoutMs: 10_000,
            maxOutputBytes: 8192,
          })
            .then(
              (result) => ({ result }),
              (error: unknown) => ({ error }),
            )
            .finally(() => {
              outsideStopped = true;
            });
          const stopOutside = async () => {
            outsideAbort.abort();
            const outcome = await outsideExecution;
            if ('error' in outcome && hasUncertainTermination(outcome.error)) {
              outsideUncertain = true;
              throw outcome.error;
            }
            return outcome;
          };
          try {
            await waitReady(paths.ready, outsideNonce, () => outsideStopped, outsideSignal);
            const report = reportSchema.parse(JSON.parse(await readFile(paths.report, 'utf8')));
            if (outsideStopped)
              throw new Error('Outside diagnostic exited before live host observation.');
            const during = await hostSnapshot();
            if (outsideStopped)
              throw new Error('Outside diagnostic stopped during live host observation.');
            await writeFile(paths.proceed, outsideNonce, { flag: 'wx' });
            const outcome = await outsideExecution;
            if ('error' in outcome) throw outcome.error;
            if (outcome.result.exitCode !== 0) throw new Error('Outside diagnostic worker failed.');
            const finalReport = reportSchema.parse(JSON.parse(outcome.result.stdout));
            if (JSON.stringify(finalReport) !== JSON.stringify(report))
              throw new Error('Outside diagnostic changed its reported observations.');
            const after = await hostSnapshot();
            retainOutsideFixture =
              report.canaryReadBefore === originalCanary ||
              [during, after].some(
                (snapshot) =>
                  snapshot.createdVisible ||
                  !snapshot.canaryBytesUnchanged ||
                  !snapshot.canaryIdentityUnchanged,
              );
            emit({
              phase: 'native-outside-create-diagnostic',
              sandboxCreatedOutside: report.created,
              sandboxOutsideReadbackMatches: report.createdReadback === outsideNonce,
              sandboxReadOriginalCanary: report.canaryReadBefore === originalCanary,
              sandboxWroteCanary: report.canaryWrite,
              sandboxCanaryReadbackMatches: report.canaryReadAfter === `worker-${outsideNonce}`,
              sandboxPositiveWrite: report.positiveWrite,
              sandboxPositiveReadbackMatches: report.positiveReadback === outsideNonce,
              hostObservedWhileWorkerAlive: true,
              during,
              after,
              hostFixtureRetained: retainOutsideFixture,
              modelInvoked: false,
            });
          } finally {
            await stopOutside();
          }
        });
      } catch (error) {
        outsideUncertain = hasUncertainTermination(error);
        throw error;
      } finally {
        if (!outsideUncertain && !retainOutsideFixture) await outsideFixture.cleanup();
      }

      const nestedScript = String.raw`
const fs=require('node:fs');let input='';process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{input+=chunk});process.stdin.on('end',()=>{
  fs.writeSync(1,JSON.stringify({input})+'\n');
  console.log('agentgate-nested-stdout');console.error('agentgate-nested-stderr');process.exitCode=37;
});`;
      const nested = await runCommand(process.execPath, [
        '-e',
        "const {spawnSync}=require('node:child_process');const child=spawnSync(process.execPath,['-e',process.argv[1]],{input:'agentgate-nested-stdin',encoding:'utf8',timeout:3000,maxBuffer:4096});console.log(JSON.stringify({exitCode:child.status,stdout:child.stdout,stderr:child.stderr,error:child.error?.code??null}))",
        nestedScript,
      ]);
      const captured = z
        .object({
          exitCode: z.number().int().nullable(),
          stdout: z.string(),
          stderr: z.string(),
          error: z.string().nullable(),
        })
        .strict()
        .parse(JSON.parse(nested.stdout));
      const compatible =
        nested.exitCode === 0 &&
        captured.exitCode === 37 &&
        captured.error === null &&
        captured.stdout === '{"input":"agentgate-nested-stdin"}\nagentgate-nested-stdout\n' &&
        captured.stderr === 'agentgate-nested-stderr\n';
      emit({
        phase: 'native-node-captured-child-compatibility',
        ...captured,
        compatible,
        requiredForGeneralNodeCompatibility: true,
        modelInvoked: false,
      });
      return compatible;
    });
  } catch (error) {
    uncertain = hasUncertainTermination(error);
    throw error;
  } finally {
    if (!uncertain) await workspace.cleanup();
  }
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
    await withSession(codexPath, home, undefined, false, async (session) => {
      const result = await execute({
        command: session.codexExecutable ?? codexPath,
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
      if (version[1] !== CODEX_VERSION)
        throw new Error(`Native acceptance requires the adapter's pinned Codex ${CODEX_VERSION}.`);
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
    if (process.platform === 'linux')
      capturedChildStdioCompatible = await verifyCommandTransport(codexPath, home);
    let nativeProbeInvocations = 0;
    const doctor = await new CodexSandbox({
      home,
      codexPath,
      executor: async (options) => {
        const nativeProbe = options.args.includes('sandbox') && !options.args.includes('--help');
        if (nativeProbe) nativeProbeInvocations++;
        try {
          const result = await execute(options);
          if (nativeProbe) {
            let validJson = false;
            try {
              JSON.parse(result.stdout.trim());
              validJson = true;
            } catch {
              // Only this helper's fixed, unauthenticated fixture output is inspected.
            }
            if (result.exitCode !== 0 || !validJson) {
              const bounded = (value: string) =>
                Buffer.from(cleanTerminal(redact(value)))
                  .subarray(0, 8192)
                  .toString('utf8');
              emit({
                phase: 'native-probe-diagnostic',
                exitCode: result.exitCode,
                validJson,
                stdout: bounded(result.stdout),
                stderr: bounded(result.stderr),
                outputLimitBytesPerStream: 8192,
                modelInvoked: false,
              });
            }
          }
          return result;
        } catch (error) {
          if (nativeProbe)
            emit({
              phase: 'native-probe-diagnostic',
              errorName: error instanceof Error ? error.name : 'UnknownError',
              error: error instanceof Error ? error.message.slice(0, 1024) : 'Native probe failed.',
              modelInvoked: false,
            });
          throw error;
        }
      },
    }).doctor(abort.signal);
    const requiredChecks = [
      'codex-version',
      'codex-integrations',
      'codex-mcp',
      'sandbox-interface',
      'sandbox-read',
      'sandbox-read-network',
      'sandbox-write',
      'sandbox-write-network',
    ];
    const authentication = doctor.filter((check) => check.name === 'codex-auth');
    const unauthenticated = authentication.length === 1 && !authentication[0]!.ok;
    const isolationVerified =
      requiredChecks.every(
        (name) => doctor.filter((check) => check.name === name && check.ok).length === 1,
      ) && doctor.length === requiredChecks.length + 1;
    emit({
      phase: 'doctor',
      nativeProbeInvocations,
      checks: doctor,
      unauthenticated,
      isolationVerified,
      workflowAuthorized: false,
      modelInvoked: false,
    });
    if (!unauthenticated)
      throw new Error('No-auth acceptance requires a fresh profile without authenticated access.');
    if (!isolationVerified)
      throw new Error(
        'Required native prerequisite, filesystem, or network evidence is unavailable.',
      );
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
  emit({
    result: passed ? 'passed' : 'failed',
    scope: 'native-filesystem-network-isolation',
    capturedChildStdioCompatible,
    modelInvoked: false,
  });
  process.exitCode = passed ? 0 : 2;
}

process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);
main()
  .catch((error) => {
    emit({
      result: 'blocked',
      scope: 'native-filesystem-network-isolation',
      capturedChildStdioCompatible,
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
