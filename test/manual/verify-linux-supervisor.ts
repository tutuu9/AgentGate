import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createConnection } from 'node:net';
import { release, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { execute, ProcessError } from '../../src/adapters/process.ts';
import {
  CODEX_VERSION,
  createSandboxSession,
  executeSandbox,
  isolatedEnvironment,
} from '../../src/adapters/sandbox.ts';
import { hasUncertainTermination } from '../../src/core/errors.ts';
import { cleanTerminal, redact } from '../../src/core/safety.ts';
import { FileRunStore } from '../../src/core/store.ts';

// Real, credential-free production launch-path acceptance. Fixtures are retained, never models.
const scope = 'native-linux-production-lifecycle';
const self = fileURLToPath(import.meta.url);
const safetyExitMs = 60_000;
const scenarios = [
  'normal-exit',
  'aborted',
  'timeout',
  'output-limit',
  'interrupted-startup',
  'controller-killed',
] as const;
type Scenario = (typeof scenarios)[number];
const abort = new AbortController();
let recordStartupAbort: (() => void) | undefined;
const interrupt = () => {
  recordStartupAbort?.();
  abort.abort(new Error('Native lifecycle acceptance cancelled.'));
};
const emit = (value: unknown) =>
  process.stdout.write(`${cleanTerminal(redact(JSON.stringify(value)))}\n`);

function failureDetails(error: unknown): string[] {
  const messages: string[] = [];
  const visited = new Set<Error>();
  for (
    let current = error;
    current instanceof Error && messages.length < 5;
    current = current.cause
  ) {
    if (visited.has(current)) break;
    visited.add(current);
    messages.push(cleanTerminal(redact(current.message)).slice(0, 512));
  }
  return messages;
}

const RequestIdentity = z.object({
  nonce: z.string().uuid(),
  unit: z.string().regex(/^agentgate-[a-f0-9-]+\.service$/),
});
const OwnerIdentity = RequestIdentity.extend({
  invocationId: z.string().regex(/^[a-f0-9]{32}$/),
  controlGroup: z.string().startsWith('/'),
  cgroup: z.object({
    path: z.string().startsWith('/sys/fs/cgroup/'),
    dev: z.number(),
    ino: z.number(),
  }),
  mainPid: z.number().int().positive(),
});
type Owner = z.infer<typeof OwnerIdentity>;
type Request = z.infer<typeof RequestIdentity>;
const ControllerResult = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('exit'), exitCode: z.number().int() }),
  z.object({ kind: z.literal('error'), failure: z.string(), uncertain: z.boolean() }),
]);
const descendantSource = String.raw`
const fs=require('node:fs');
const [heartbeat,ready,nonce]=process.argv.slice(1);
process.on('SIGTERM',()=>{});
const fields=fs.readFileSync('/proc/self/stat','utf8').split(') ').at(-1).split(' ');
fs.writeFileSync(ready,JSON.stringify({nonce,pid:process.pid,group:Number(fields[2]),session:Number(fields[3]),ignoresSigterm:true}),{flag:'wx'});
setInterval(()=>fs.appendFileSync(heartbeat,nonce+'\n'),25);
setTimeout(()=>process.exit(0),60000);
`;
const payloadSource = String.raw`
const fs=require('node:fs'),net=require('node:net'),{spawn}=require('node:child_process');
const p=JSON.parse(process.argv[1]);
fs.writeFileSync(p.started,p.nonce,{flag:'wx'});
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const readable=path=>{try{fs.readFileSync(path);return true}catch{return false}};
const writable=path=>{try{const fd=fs.openSync(path,'r+');fs.closeSync(fd);return true}catch{return false}};
const connected=path=>new Promise(resolve=>{let s;const done=value=>{s?.destroy();resolve(value)};try{s=net.createConnection({path});s.once('connect',()=>done(true));s.once('error',()=>done(false));s.setTimeout(1500,()=>done(false))}catch{done(false)}});
setTimeout(()=>process.exit(125),60000);
(async()=>{
  while(!fs.existsSync(p.probeInput))await wait(10);
  const input=JSON.parse(fs.readFileSync(p.probeInput,'utf8'));
  let controlDescriptorInherited=false;
  for(const fd of fs.readdirSync('/proc/self/fd')){
    try{if(fs.readlinkSync('/proc/self/fd/'+fd).startsWith(input.controlDirectory+'/'))controlDescriptorInherited=true}catch{}
  }
  const report={nonce:p.nonce,controlReadable:readable(input.controlDirectory+'/request.json'),controlWritable:writable(input.controlDirectory+'/request.json'),ownerReadable:readable(input.controlDirectory+'/owner.json'),busConnected:await connected(input.bus),cgroupReadable:readable(input.cgroup+'/cgroup.procs'),cgroupWritable:writable(input.cgroup+'/cgroup.procs'),controlDescriptorInherited,pipeDescriptors:[0,1,2].map(fd=>fs.fstatSync(fd).isFIFO()),credentialEnvironment:['GH_TOKEN','GITHUB_TOKEN','OPENAI_API_KEY','CODEX_API_KEY','ANTHROPIC_API_KEY','SSH_AUTH_SOCK','DBUS_SESSION_BUS_ADDRESS','XDG_RUNTIME_DIR','AGENTGATE_FAKE_MANAGER_SECRET'].some(name=>Boolean(process.env[name]))};
  fs.writeFileSync(p.report,JSON.stringify(report),{flag:'wx'});
  const child=spawn(process.execPath,['-e',p.descendantSource,p.heartbeat,p.ready,p.nonce],{shell:false,detached:true,stdio:'ignore'});
  child.on('error',()=>process.exit(127));child.unref();
  while(!fs.existsSync(p.proceed))await wait(10);
  if(p.scenario==='normal-exit')process.exit(37);
  if(p.scenario==='output-limit')setInterval(()=>fs.writeSync(1,Buffer.alloc(8192,'x')),5);
})().catch(()=>process.exit(126));
`;

async function optionalJson(path: string): Promise<unknown | undefined> {
  try {
    const entry = await lstat(path);
    assert.ok(entry.isFile() && !entry.isSymbolicLink() && entry.size <= 64 * 1024);
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if (
      error instanceof SyntaxError ||
      (error instanceof Error && 'code' in error && error.code === 'ENOENT')
    )
      return undefined;
    throw error;
  }
}
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}
async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 12_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    abort.signal.throwIfAborted();
    const value = await read();
    if (value !== undefined) return value;
    await delay(5);
  }
  throw new Error('Native lifecycle fixture did not reach the required state before its deadline.');
}
function controlEnvironment(home: string): NodeJS.ProcessEnv {
  const runtime = `/run/user/${process.getuid!()}`;
  return {
    ...isolatedEnvironment(home, tmpdir()),
    XDG_RUNTIME_DIR: runtime,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus`,
  };
}
async function unitState(unit: string, home: string): Promise<Record<string, string>> {
  RequestIdentity.shape.unit.parse(unit);
  const result = await execute({
    command: '/usr/bin/systemctl',
    args: [
      '--user',
      'show',
      unit,
      '--property=LoadState,ActiveState,SubState,InvocationID,ControlGroup,MainPID,Job',
    ],
    env: controlEnvironment(home),
    timeoutMs: 5_000,
    maxOutputBytes: 8192,
  });
  const state = Object.fromEntries(
    result.stdout
      .trim()
      .split('\n')
      .map((line) => {
        const split = line.indexOf('=');
        return [line.slice(0, split), line.slice(split + 1)];
      }),
  );
  assert.ok(
    result.exitCode === 0 || state.LoadState === 'not-found',
    'User manager state is unavailable.',
  );
  return state;
}
async function stopped(
  owner: Request | Owner,
  home: string,
  requireRetainedFailure = false,
): Promise<boolean> {
  const state = await unitState(owner.unit, home);
  if (state.Job !== '' && state.Job !== '0') return false;
  if (requireRetainedFailure && (state.LoadState !== 'loaded' || state.ActiveState !== 'failed'))
    return false;
  if (state.LoadState !== 'not-found' && !['inactive', 'failed'].includes(state.ActiveState ?? ''))
    return false;
  if ('invocationId' in owner && state.LoadState !== 'not-found')
    assert.equal(state.InvocationID, owner.invocationId, 'Owned unit identity changed.');
  const path =
    'cgroup' in owner
      ? owner.cgroup.path
      : state.ControlGroup
        ? `/sys/fs/cgroup${state.ControlGroup}`
        : undefined;
  if (path && (await exists(path))) {
    if ('cgroup' in owner) {
      const identity = await stat(path);
      assert.equal(identity.dev, owner.cgroup.dev);
      assert.equal(identity.ino, owner.cgroup.ino);
    }
    return /^populated 0$/m.test(await readFile(join(path, 'cgroup.events'), 'utf8'));
  }
  return true;
}
async function supervision(
  home: string,
): Promise<{ directory: string; request: Request } | undefined> {
  const runtime = join(home, 'runtime');
  if (!(await exists(runtime))) return undefined;
  const directories = (await readdir(runtime)).filter((name) => name.startsWith('supervision-'));
  assert.ok(directories.length <= 1, 'Fresh fixture contains unexpected supervision records.');
  if (!directories.length) return undefined;
  const directory = join(runtime, directories[0]!);
  const request = await optionalJson(join(directory, 'request.json'));
  return request === undefined ? undefined : { directory, request: RequestIdentity.parse(request) };
}
async function heartbeatSize(path: string): Promise<number> {
  return (await exists(path)) ? (await stat(path)).size : 0;
}
function spawnController(args: string[], home: string) {
  const child = spawn(process.execPath, [self, '--controller', ...args], {
    env: isolatedEnvironment(home, tmpdir()),
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk: Buffer) => {
      if (output.length < 8192) output += chunk.toString().slice(0, 8192 - output.length);
    });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    },
  );
  return { child, closed, output: () => cleanTerminal(redact(output)) };
}
async function stopOwned(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await delay(2_000);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

async function verifyScenario(codex: string, root: string, scenario: Scenario) {
  const home = join(root, scenario, 'home');
  const workspace = join(root, scenario, 'workspace');
  await mkdir(workspace, { recursive: true });
  const nonce = randomUUID();
  const heartbeat = join(workspace, 'heartbeat');
  const outsideHeartbeat = join(root, `${scenario}-outside-heartbeat`);
  const outside = spawn(
    process.execPath,
    [
      '-e',
      "const fs=require('node:fs');setInterval(()=>fs.appendFileSync(process.argv[1],'x'),25);setTimeout(()=>process.exit(0),60000)",
      outsideHeartbeat,
    ],
    { env: isolatedEnvironment(home, tmpdir()), shell: false, stdio: 'ignore' },
  );
  const controller = spawnController([codex, home, workspace, scenario, nonce], home);
  const started = Date.now();
  let owner: Request | Owner | undefined;
  try {
    if (scenario !== 'interrupted-startup')
      await waitFor(async () => ((await heartbeatSize(outsideHeartbeat)) >= 3 ? true : undefined));
    const control = await waitFor(() => supervision(home));
    owner = control.request;
    if (scenario === 'interrupted-startup') {
      assert.equal(
        await exists(join(control.directory, 'go.json')),
        false,
        'Startup interception was too late.',
      );
      assert.ok(controller.child.kill('SIGTERM'));
    } else {
      const capturedOwner = await waitFor(async () => {
        const value = await optionalJson(join(control.directory, 'owner.json'));
        return value === undefined ? undefined : OwnerIdentity.parse(value);
      });
      owner = capturedOwner;
      assert.equal(owner.unit, control.request.unit);
      assert.equal(owner.nonce, control.request.nonce);
      const probeInput = join(workspace, 'probe-input.json');
      await writeFile(
        `${probeInput}.tmp`,
        JSON.stringify({
          controlDirectory: control.directory,
          bus: `/run/user/${process.getuid!()}/bus`,
          cgroup: capturedOwner.cgroup.path,
        }),
        { flag: 'wx' },
      );
      await rename(`${probeInput}.tmp`, probeInput);
      const ready = await waitFor(async () => {
        const value = await optionalJson(join(workspace, 'ready.json'));
        if (value === undefined || (await heartbeatSize(heartbeat)) < nonce.length * 3)
          return undefined;
        return z
          .object({
            nonce: z.literal(nonce),
            pid: z.number().int().positive(),
            group: z.number().int(),
            session: z.number().int(),
            ignoresSigterm: z.literal(true),
          })
          .parse(value);
      });
      assert.equal(ready.group, ready.pid);
      assert.equal(ready.session, ready.pid);
      assert.deepEqual(await optionalJson(join(workspace, 'boundary.json')), {
        nonce,
        controlReadable: false,
        controlWritable: false,
        ownerReadable: false,
        busConnected: false,
        cgroupReadable: false,
        cgroupWritable: false,
        controlDescriptorInherited: false,
        pipeDescriptors: [true, true, true],
        credentialEnvironment: false,
      });
      await writeFile(join(workspace, 'proceed'), nonce, { flag: 'wx' });
      if (scenario === 'aborted') assert.ok(controller.child.kill('SIGTERM'));
      if (scenario === 'controller-killed') assert.ok(controller.child.kill('SIGKILL'));
    }
    let finishTimer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      controller.closed,
      new Promise<never>((_resolve, reject) => {
        finishTimer = setTimeout(
          () => reject(new Error('Controller did not finish within its deadline.')),
          30_000,
        );
      }),
    ]).finally(() => clearTimeout(finishTimer));
    if (scenario === 'controller-killed') assert.equal(result.signal, 'SIGKILL');
    else {
      assert.equal(result.code, 0, controller.output());
      const report = ControllerResult.parse(
        await optionalJson(join(home, 'controller-result.json')),
      );
      if (scenario === 'normal-exit') assert.deepEqual(report, { kind: 'exit', exitCode: 37 });
      else
        assert.deepEqual(report, {
          kind: 'error',
          failure: scenario === 'interrupted-startup' ? 'aborted' : scenario,
          uncertain: false,
        });
    }
    const exactOwner = owner;
    await waitFor(
      async () =>
        (await stopped(exactOwner, home, scenario === 'controller-killed')) ? true : undefined,
      10_000,
    );
    const stoppedHeartbeat = await heartbeatSize(heartbeat);
    const unrelatedBefore = await heartbeatSize(outsideHeartbeat);
    await delay(1_000);
    assert.equal(
      await heartbeatSize(heartbeat),
      stoppedHeartbeat,
      'Native descendant continued writing after OS completion.',
    );
    assert.ok(
      (await heartbeatSize(outsideHeartbeat)) > unrelatedBefore,
      'An unrelated host process was terminated.',
    );
    assert.equal(
      await stopped(exactOwner, home, scenario === 'controller-killed'),
      true,
      'Owned unit appeared again after completion.',
    );
    assert.ok(
      Date.now() - started < safetyExitMs - 10_000,
      'Observation reached the safety-exit window.',
    );
    if (scenario === 'interrupted-startup') {
      assert.equal(
        await exists(join(workspace, 'payload-started')),
        false,
        'Native payload started despite cancellation before launch authorization.',
      );
      assert.equal(await exists(join(workspace, 'ready.json')), false);
      assert.deepEqual(await optionalJson(join(home, 'startup-abort.json')), {
        nonce,
        requestPresent: true,
        ownerPresent: false,
        goPresent: false,
      });
    }
    if (scenario === 'controller-killed') {
      assert.equal(await exists(join(home, 'run.lock')), true);
      assert.equal(await exists(control.directory), true);
      z.object({
        nonce: z.literal(exactOwner.nonce),
        kind: z.literal('failure'),
        reason: z.literal('controller-lost'),
      }).parse(await optionalJson(join(control.directory, 'result.json')));
      await assert.rejects(new FileRunStore(home).acquireLock(), /Stale run lock/);
    } else assert.equal(await exists(join(home, 'run.lock')), false);
    emit({
      phase: 'lifecycle',
      scenario,
      result: 'passed',
      ownedUnit: exactOwner.unit,
      osCompletionVerified: true,
      detachedSigtermIgnoringDescendantStopped: scenario !== 'interrupted-startup',
      unrelatedHostProcessPreserved: true,
      observedBeforeSafetyExit: true,
      controllerCrashLockRetained: scenario === 'controller-killed',
      durationMs: Date.now() - started,
      modelInvoked: false,
    });
  } catch (error) {
    emit({
      phase: 'scenario-blocked',
      scenario,
      home,
      workspace,
      ownedUnit: owner?.unit,
      controllerOutput: controller.output(),
    });
    throw error;
  } finally {
    await stopOwned(controller.child);
    await stopOwned(outside);
    emit({ phase: 'fixture-retained', scenario, home, workspace });
  }
}

async function controllerWorker(args: string[]) {
  const [codex, home, workspace, scenario, nonce] = args;
  assert.ok(codex && home && workspace && nonce && scenarios.includes(scenario as Scenario));
  const store = new FileRunStore(home);
  await store.init();
  const unlock = await store.acquireLock();
  const session = await createSandboxSession(home, workspace, true, codex);
  if (scenario === 'interrupted-startup')
    recordStartupAbort = () => {
      const runtime = join(home, 'runtime');
      const directories = readdirSync(runtime).filter((name) => name.startsWith('supervision-'));
      const directory = directories.length === 1 ? join(runtime, directories[0]!) : undefined;
      writeFileSync(
        join(home, 'startup-abort.json'),
        JSON.stringify({
          nonce,
          requestPresent: Boolean(directory && existsSync(join(directory, 'request.json'))),
          ownerPresent: Boolean(directory && existsSync(join(directory, 'owner.json'))),
          goPresent: Boolean(directory && existsSync(join(directory, 'go.json'))),
        }),
        { flag: 'wx' },
      );
    };
  let uncertain = false;
  try {
    const result = await executeSandbox({
      command: session.codexExecutable ?? codex,
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
        payloadSource,
        JSON.stringify({
          scenario,
          nonce,
          descendantSource,
          heartbeat: join(workspace, 'heartbeat'),
          ready: join(workspace, 'ready.json'),
          report: join(workspace, 'boundary.json'),
          started: join(workspace, 'payload-started'),
          probeInput: join(workspace, 'probe-input.json'),
          proceed: join(workspace, 'proceed'),
        }),
      ],
      cwd: session.launcher,
      env: session.env,
      linuxPipeTransport: true,
      timeoutMs: scenario === 'timeout' ? 15_000 : 30_000,
      maxOutputBytes: 32 * 1024,
      signal: abort.signal,
    });
    await writeFile(
      join(home, 'controller-result.json'),
      JSON.stringify({ kind: 'exit', exitCode: result.exitCode }),
      { flag: 'wx' },
    );
  } catch (error) {
    uncertain = hasUncertainTermination(error);
    emit({
      phase: 'controller-failure',
      failure: error instanceof ProcessError ? error.kind : 'unexpected',
      uncertain,
      details: failureDetails(error),
    });
    await writeFile(
      join(home, 'controller-result.json'),
      JSON.stringify({
        kind: 'error',
        failure: error instanceof ProcessError ? error.kind : 'unexpected',
        uncertain,
      }),
      { flag: 'wx' },
    );
  } finally {
    recordStartupAbort = undefined;
    if (!uncertain) {
      await session.cleanup();
      await unlock();
    }
  }
}

async function main() {
  if (process.platform !== 'linux' || process.versions.node.split('.')[0] !== '24')
    throw new Error('Native lifecycle acceptance requires Linux and Node.js 24.');
  if (process.argv[2] === '--controller') return controllerWorker(process.argv.slice(3));
  if (process.argv.length !== 3 || !isAbsolute(process.argv[2]!))
    throw new Error('Usage: node test/manual/verify-linux-supervisor.ts <absolute-native-codex>');
  const codex = await realpath(process.argv[2]!);
  assert.ok((await lstat(codex)).isFile());
  const root = await mkdtemp(join(await realpath(tmpdir()), 'agentgate-lifecycle-'));
  const version = await execute({
    command: codex,
    args: ['--version'],
    env: isolatedEnvironment(root, tmpdir()),
    timeoutMs: 10_000,
    maxOutputBytes: 4096,
  });
  assert.equal(version.stdout.trim(), `codex-cli ${CODEX_VERSION}`);
  const bus = createConnection({ path: `/run/user/${process.getuid!()}/bus` });
  await new Promise<void>((resolve, reject) => {
    bus.once('connect', resolve);
    bus.once('error', reject);
    bus.setTimeout(5_000, () => reject(new Error('User bus baseline timed out.')));
  }).finally(() => bus.destroy());
  emit({
    phase: 'environment',
    scope,
    kernel: release(),
    node: process.version,
    codex: CODEX_VERSION,
    root,
    userId: process.getuid!(),
    userBusBaseline: true,
    modelInvoked: false,
    authenticatedWorkflow: false,
    productionWorkflowAuthorized: false,
  });
  for (const scenario of scenarios) await verifyScenario(codex, root, scenario);
  emit({ result: 'passed', scope, modelInvoked: false, authenticatedWorkflow: false });
}

process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);
try {
  await main();
} catch (error) {
  emit({
    result: 'blocked',
    scope,
    error: error instanceof Error ? error.message : 'Native lifecycle acceptance failed.',
    modelInvoked: false,
  });
  process.exitCode = 2;
} finally {
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
}
