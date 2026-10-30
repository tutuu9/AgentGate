import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { execute, ProcessError } from '../../src/adapters/process.ts';
import { isolatedEnvironment } from '../../src/adapters/sandbox.ts';
import { FileRunStore } from '../../src/core/store.ts';
import { cleanTerminal, redact } from '../../src/core/safety.ts';
import { hasUncertainTermination } from '../../src/core/errors.ts';

// Manual process/CLI acceptance. Fixtures and stale locks are deliberately retained.
const self = fileURLToPath(import.meta.url);
const project = resolve(dirname(self), '../..');
const emit = (value: unknown) =>
  process.stdout.write(`${cleanTerminal(redact(JSON.stringify(value)))}\n`);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
    throw error;
  }
}

async function waitFor<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await delay(25);
  }
  throw new Error('Owned fixture did not reach its expected process state.');
}

async function optionalText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function lockRecovery(home: string, env: NodeJS.ProcessEnv): Promise<void> {
  const ready = join(home, 'lock-owner.ready');
  const marker = join(home, 'preserved-state.txt');
  const nonce = randomUUID();
  await writeFile(marker, nonce, { flag: 'wx' });
  const worker = spawn(process.execPath, [self, '--lock-worker', home, ready], {
    env,
    shell: false,
    windowsHide: true,
    stdio: 'ignore',
  });
  let exited = false;
  let spawnError: Error | undefined;
  worker.once('error', (error) => {
    spawnError = error;
    exited = true;
  });
  worker.once('exit', () => {
    exited = true;
  });
  const stop = async () => {
    if (!exited && !worker.kill('SIGKILL'))
      throw new Error('Could not stop the owned lock worker.');
    await waitFor(async () => (exited ? true : undefined));
    if (worker.pid) assert.equal(alive(worker.pid), false, 'Lock worker still exists.');
  };
  try {
    const owner = await waitFor(async () => {
      if (spawnError) throw spawnError;
      if (exited) throw new Error('Lock worker exited before its readiness marker.');
      return optionalText(ready);
    });
    assert.equal(Number(owner), worker.pid);
    const lock = await readFile(join(home, 'run.lock'), 'utf8');
    const doctor = () =>
      execute({
        command: process.execPath,
        args: [join(project, 'src/cli/main.ts'), 'doctor', '--home', home, '--json'],
        env,
        timeoutMs: 10_000,
        maxOutputBytes: 8192,
      });
    const live = await doctor();
    assert.notEqual(live.exitCode, 0);
    assert.match(`${live.stdout}\n${live.stderr}`, /Another AgentGate process holds the run lock/);
    assert.equal(await readFile(join(home, 'run.lock'), 'utf8'), lock);
    await stop();
    const stale = await doctor();
    assert.notEqual(stale.exitCode, 0);
    assert.match(`${stale.stdout}\n${stale.stderr}`, /Stale run lock/);
    assert.equal(await readFile(join(home, 'run.lock'), 'utf8'), lock);
    assert.equal(await readFile(marker, 'utf8'), nonce);
    const entries = await readdir(home);
    assert.equal(entries.includes('runtime') || entries.includes('codex'), false);
    emit({
      phase: 'lock-recovery',
      liveLock: 'blocked-as-expected',
      staleLock: 'blocked-as-expected',
      ownerStopped: true,
      lockPreserved: true,
      statePreserved: true,
      nativeSandboxStarted: false,
      modelInvoked: false,
    });
  } finally {
    await stop();
  }
}

async function cancellation(home: string, env: NodeJS.ProcessEnv): Promise<void> {
  const marker = join(home, 'descendant-heartbeat.json');
  const child = `const fs=require('node:fs');let counter=0;
setInterval(()=>fs.writeFileSync(process.argv[1],JSON.stringify({pid:process.pid,counter:++counter})),25);
setTimeout(()=>process.exit(0),10000);`;
  const parent = `const {spawn}=require('node:child_process');
spawn(process.execPath,['-e',process.argv[2],process.argv[1]],{shell:false,windowsHide:true,stdio:'inherit'});
setTimeout(()=>process.exit(0),10000);`;
  const abort = new AbortController();
  const outcome = execute({
    command: process.execPath,
    args: ['-e', parent, marker, child],
    env,
    signal: abort.signal,
    timeoutMs: 15_000,
    maxOutputBytes: 8192,
  }).then(
    () => undefined,
    (error: unknown) => error,
  );
  const stop = async () => {
    abort.abort();
    const error = await outcome;
    if (hasUncertainTermination(error)) throw error;
  };
  try {
    const heartbeat = await waitFor(async () => {
      const value = await optionalText(marker);
      if (!value) return undefined;
      try {
        const parsed = JSON.parse(value) as { pid: number; counter: number };
        return Number.isSafeInteger(parsed.pid) && parsed.pid > 0 && parsed.counter >= 2
          ? parsed
          : undefined;
      } catch {
        return undefined;
      }
    });
    assert.equal(alive(heartbeat.pid), true);
    abort.abort();
    const error = await outcome;
    assert.ok(error instanceof ProcessError && error.kind === 'aborted');
    await waitFor(async () => (!alive(heartbeat.pid) ? true : undefined));
    const stopped = await readFile(marker, 'utf8');
    await delay(250);
    assert.equal(await readFile(marker, 'utf8'), stopped);
    emit({
      phase: 'cancellation',
      descendantStopped: true,
      heartbeatStopped: true,
      modelInvoked: false,
    });
  } finally {
    await stop();
  }
}

async function main(): Promise<void> {
  if (process.argv[2] === '--lock-worker') {
    const store = new FileRunStore(process.argv[3]!);
    await store.init();
    await store.acquireLock();
    await writeFile(process.argv[4]!, String(process.pid), { flag: 'wx' });
    setInterval(() => {}, 1_000);
    // An interrupted acceptance controller must not leave this fixture alive indefinitely.
    setTimeout(() => process.exit(0), 15_000);
    return;
  }
  assert.equal(process.argv.length, 2, 'This helper takes no arguments.');
  assert.equal(process.versions.node.split('.')[0], '24', 'Node.js 24 is required.');
  const temporary = await realpath(tmpdir());
  const relation = relative(await realpath(project), temporary);
  assert.ok(isAbsolute(relation) || relation === '..' || relation.startsWith(`..${sep}`));
  assert.ok((await lstat(temporary)).isDirectory());
  const home = await mkdtemp(join(temporary, 'agentgate-lock-acceptance-'));
  const scratch = join(home, 'tmp');
  await mkdir(scratch);
  const env = isolatedEnvironment(home, scratch);
  // Any regression beyond the lock cannot use installed authenticated provider executables.
  env.AGENTGATE_GH_PATH = join(home, 'unavailable-gh');
  env.AGENTGATE_CODEX_PATH = join(home, 'unavailable-codex');
  emit({ phase: 'fixture', stateHome: home, stateHomeRetained: true, modelInvoked: false });
  await lockRecovery(home, env);
  await cancellation(home, env);
  emit({ result: 'passed', staleLockRetained: true, modelInvoked: false });
}

main().catch((error: unknown) => {
  emit({
    result: 'blocked',
    error: error instanceof Error ? error.message : 'Manual acceptance failed.',
    uncertainTermination: hasUncertainTermination(error),
    modelInvoked: false,
  });
  process.exitCode = 2;
});
