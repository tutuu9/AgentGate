import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import {
  executeLinuxSandbox,
  type LinuxSupervisionDriver,
  type LinuxUnit,
} from '../src/adapters/linux-supervisor.ts';
import { ProcessError, type ExecuteOptions } from '../src/adapters/process.ts';
import {
  publishGo,
  writeProtocol,
  STARTUP_MS,
  STOP_MS,
} from '../src/adapters/linux-supervisor-protocol.ts';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agentgate-supervision-test-'));
  const runtime = join(root, 'runtime');
  const launcher = join(runtime, 'launch-fixture');
  await mkdir(runtime, { mode: 0o700 });
  await mkdir(launcher, { mode: 0o700 });
  const state = {
    directory: '',
    unit: undefined as LinuxUnit | undefined,
    targetStarted: false,
    killed: false,
    released: false,
    empty: false,
    running: false,
    wrapperFailure: undefined as Error | undefined,
    inspectError: undefined as Error | undefined,
    beforeReady: undefined as (() => void) | undefined,
    beforeEmpty: undefined as (() => void) | undefined,
    beforeRelease: undefined as (() => void) | undefined,
    request: undefined as Record<string, unknown> | undefined,
  };
  const driver: LinuxSupervisionDriver = {
    async prerequisites() {},
    async identity(pid) {
      return { pid, startTime: '42' };
    },
    async start({ directory, unit, runtimeMaxMs, options }) {
      state.directory = directory;
      const request = JSON.parse(await readFile(join(directory, 'request.json'), 'utf8')) as {
        nonce: string;
      };
      state.request = request;
      state.unit = {
        id: unit,
        invocationId: 'a'.repeat(32),
        mainPid: process.pid + 10000,
        controlGroup: `/user.slice/${unit}`,
        activeState: 'active',
        job: '',
        type: 'exec',
        exitType: 'main',
        killMode: 'control-group',
        killSignal: '9',
        sendSIGKILL: 'yes',
        restart: 'no',
        collectMode: 'inactive',
        remainAfterExit: 'no',
        successExitStatus: '',
        restartForceExitStatus: '',
        timeoutStopMs: 7000,
        runtimeMaxMs,
      };
      state.beforeReady?.();
      await writeProtocol(directory, 'ready.json', {
        nonce: request.nonce,
        pid: state.unit.mainPid,
        startTime: '42',
      });
      for (let index = 0; index < 6000; index++) {
        if (state.killed || options.signal?.aborted) {
          state.empty = true;
          state.unit.activeState = 'failed';
          state.unit.mainPid = 0;
          return { exitCode: 200, stdout: 'out', stderr: 'err', durationMs: 1 };
        }
        try {
          await access(join(directory, 'go.json'));
          state.targetStarted = true;
          if (state.wrapperFailure) throw state.wrapperFailure;
          if (!state.running) {
            await writeProtocol(directory, 'result.json', {
              nonce: request.nonce,
              kind: 'exit',
              exitCode: 37,
            });
            state.empty = true;
            state.unit.activeState = 'failed';
            state.unit.mainPid = 0;
            return { exitCode: 200, stdout: 'out', stderr: 'err', durationMs: 1 };
          }
        } catch (error) {
          if (error === state.wrapperFailure) throw error;
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        }
        await delay(5);
      }
      throw new Error('Fake service exceeded its safety deadline.');
    },
    async inspect() {
      if (state.inspectError) throw state.inspectError;
      return state.unit ? { ...state.unit } : undefined;
    },
    async captureCgroup() {
      return { path: '/fake-cgroup', dev: 1, ino: 2 };
    },
    async cgroupEmpty() {
      state.beforeEmpty?.();
      return state.empty;
    },
    async kill() {
      state.killed = true;
      state.empty = true;
      if (state.unit) {
        state.unit.activeState = 'failed';
        state.unit.mainPid = 0;
      }
    },
    async release() {
      state.beforeRelease?.();
      state.released = true;
    },
  };
  const options: ExecuteOptions = {
    command: process.execPath,
    args: ['literal $value %value ;'],
    cwd: launcher,
    env: { PATH: process.env.PATH },
    timeoutMs: 5000,
  };
  return {
    root,
    runtime,
    launcher,
    state,
    driver,
    options,
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('Linux supervisor returns actual target status and separated output after exact cgroup completion', async () => {
  const f = await fixture();
  try {
    const result = await executeLinuxSandbox(f.options, f.driver);
    assert.equal(result.exitCode, 37);
    assert.equal(result.stdout, 'out');
    assert.equal(result.stderr, 'err');
    assert.equal(f.state.targetStarted, true);
    assert.equal(f.state.released, true);
    assert.deepEqual(f.state.request?.args, f.options.args);
    assert.deepEqual(f.state.request?.env, f.options.env);
    assert.deepEqual(await readdir(f.runtime), ['launch-fixture']);
  } finally {
    await f.cleanup();
  }
});

test('Linux supervisor cancellation during startup never publishes GO and stops the late service', async () => {
  const f = await fixture();
  const abort = new AbortController();
  f.state.beforeReady = () => abort.abort();
  try {
    await assert.rejects(
      executeLinuxSandbox({ ...f.options, signal: abort.signal }, f.driver),
      (error: unknown) => error instanceof ProcessError && error.kind === 'aborted',
    );
    assert.equal(f.state.targetStarted, false);
    assert.equal(f.state.killed, true);
    assert.equal(f.state.released, true);
    assert.deepEqual(await readdir(f.runtime), ['launch-fixture']);
  } finally {
    await f.cleanup();
  }
});

test('Linux supervisor kills native work when output capture fails outside its process tree', async () => {
  const f = await fixture();
  const failure = new ProcessError('output-limit', 'Fake bounded capture failure.');
  f.state.wrapperFailure = failure;
  try {
    await assert.rejects(
      executeLinuxSandbox(f.options, f.driver),
      (error: unknown) => error === failure,
    );
    assert.equal(f.state.targetStarted, true);
    assert.equal(f.state.killed, true);
    assert.equal(f.state.released, true);
  } finally {
    await f.cleanup();
  }
});

test('Linux supervisor preserves records and original cancellation cause when ownership changes', async () => {
  const f = await fixture();
  const abort = new AbortController();
  f.state.running = true;
  const originalInspect = f.driver.inspect;
  f.driver.inspect = async (unit) => {
    if (f.state.targetStarted) {
      abort.abort();
      if (f.state.unit) f.state.unit.invocationId = 'b'.repeat(32);
    }
    return originalInspect(unit);
  };
  try {
    await assert.rejects(
      executeLinuxSandbox({ ...f.options, signal: abort.signal }, f.driver),
      (error: unknown) =>
        error instanceof ProcessError &&
        error.kind === 'termination' &&
        error.cause instanceof AggregateError &&
        error.cause.errors.some(
          (cause: unknown) => cause instanceof ProcessError && cause.kind === 'aborted',
        ),
    );
    assert.equal(f.state.killed, false, 'A replacement invocation must never be killed.');
    assert.equal(f.state.released, false);
    assert.ok((await readdir(f.runtime)).some((name) => name.startsWith('supervision-')));
    await access(join(f.state.directory, 'owner.json'));
  } finally {
    await f.cleanup();
  }
});

for (const phase of ['beforeEmpty', 'beforeRelease'] as const) {
  test(`Linux supervisor preserves cancellation received during ${phase}`, async () => {
    const f = await fixture();
    const abort = new AbortController();
    f.state[phase] = () => abort.abort();
    try {
      await assert.rejects(
        executeLinuxSandbox({ ...f.options, signal: abort.signal }, f.driver),
        (error: unknown) => error instanceof ProcessError && error.kind === 'aborted',
      );
      assert.equal(f.state.released, true);
    } finally {
      await f.cleanup();
    }
  });
}

test('GO authorization checks cancellation after asynchronous preparation and before publication', async () => {
  const f = await fixture();
  try {
    let checked = false;
    const published = await publishGo(f.launcher, { nonce: 'fixture' }, () => {
      checked = true;
      return true;
    });
    assert.equal(checked, true);
    assert.equal(published, false);
    await assert.rejects(access(join(f.launcher, 'go.json')), { code: 'ENOENT' });
    await access(join(f.launcher, 'go.json.tmp'));
  } finally {
    await f.cleanup();
  }
});

test('Linux supervisor rejects implicit environments and pre-cancelled work without requesting a service', async () => {
  const f = await fixture();
  const abort = new AbortController();
  abort.abort();
  try {
    await assert.rejects(
      executeLinuxSandbox({ ...f.options, env: undefined }, f.driver),
      /explicit isolated environment/,
    );
    await assert.rejects(
      executeLinuxSandbox({ ...f.options, env: { GH_TOKEN: 'fake-never-forwarded' } }, f.driver),
      /unsupported variable/,
    );
    await assert.rejects(
      executeLinuxSandbox({ ...f.options, signal: abort.signal }, f.driver),
      (error: unknown) => error instanceof ProcessError && error.kind === 'aborted',
    );
    assert.equal(f.state.directory, '');
    assert.deepEqual(await readdir(f.runtime), ['launch-fixture']);
  } finally {
    await f.cleanup();
  }
});

test('Linux supervisor unavailable prerequisites never request a native service', async () => {
  const f = await fixture();
  const missing = new Error('Fake missing user manager.');
  f.driver.prerequisites = async () => {
    throw missing;
  };
  try {
    await assert.rejects(
      executeLinuxSandbox(f.options, f.driver),
      (error: unknown) => error === missing,
    );
    assert.equal(f.state.directory, '');
    assert.deepEqual(await readdir(f.runtime), ['launch-fixture']);
  } finally {
    await f.cleanup();
  }
});

for (const invalid of ['ready nonce', 'success policy'] as const) {
  test(`Linux supervisor rejects a changed ${invalid} before authorizing the target`, async () => {
    const f = await fixture();
    f.state.beforeReady = () => {
      if (invalid === 'ready nonce' && f.state.request)
        f.state.request.nonce = '11111111-1111-4111-8111-111111111111';
      if (invalid === 'success policy' && f.state.unit) f.state.unit.successExitStatus = '200';
    };
    try {
      await assert.rejects(
        executeLinuxSandbox(f.options, f.driver),
        (error: unknown) => error instanceof ProcessError && error.kind === 'termination',
      );
      assert.equal(f.state.targetStarted, false);
      assert.equal(f.state.released, false);
      await assert.rejects(access(join(f.state.directory, 'go.json')), { code: 'ENOENT' });
      await access(join(f.state.directory, 'request.json'));
    } finally {
      await f.cleanup();
    }
  });
}

test('Linux supervisor preserves cancellation and native records when the manager becomes unavailable', async () => {
  const f = await fixture();
  const abort = new AbortController();
  f.state.running = true;
  const originalInspect = f.driver.inspect;
  f.driver.inspect = async (unit) => {
    if (f.state.targetStarted) {
      abort.abort();
      throw new Error('Fake unavailable manager.');
    }
    return originalInspect(unit);
  };
  try {
    await assert.rejects(
      executeLinuxSandbox({ ...f.options, signal: abort.signal }, f.driver),
      (error: unknown) =>
        error instanceof ProcessError &&
        error.kind === 'termination' &&
        error.cause instanceof AggregateError &&
        error.cause.errors.some(
          (cause: unknown) => cause instanceof ProcessError && cause.kind === 'aborted',
        ),
    );
    assert.equal(f.state.targetStarted, true);
    assert.equal(f.state.released, false);
    await access(join(f.state.directory, 'owner.json'));
  } finally {
    await f.cleanup();
  }
});

test('Linux supervisor timeout terminates the native unit and retains the timeout cause', async () => {
  const f = await fixture();
  f.state.running = true;
  try {
    await assert.rejects(
      executeLinuxSandbox({ ...f.options, timeoutMs: 150 }, f.driver),
      (error: unknown) => error instanceof ProcessError && error.kind === 'timeout',
    );
    assert.equal(f.state.targetStarted, true);
    assert.equal(f.state.killed, true);
    assert.equal(f.state.released, true);
  } finally {
    await f.cleanup();
  }
});

test('Linux supervisor keeps capture failure observed before a later cancellation as the primary cause', async () => {
  const f = await fixture();
  const abort = new AbortController();
  const failure = new ProcessError('output-limit', 'First observed capture failure.');
  f.state.wrapperFailure = failure;
  const originalStart = f.driver.start;
  f.driver.start = async (request) => {
    try {
      return await originalStart(request);
    } catch (error) {
      setTimeout(() => abort.abort(), 0);
      throw error;
    }
  };
  try {
    await assert.rejects(
      executeLinuxSandbox({ ...f.options, signal: abort.signal }, f.driver),
      (error: unknown) => error === failure,
    );
    assert.equal(abort.signal.aborted, true);
    assert.equal(f.state.killed, true);
    assert.equal(f.state.released, true);
  } finally {
    await f.cleanup();
  }
});

test('Linux supervisor never publishes GO after delayed ownership exhausts the startup deadline', async () => {
  const f = await fixture();
  const originalCapture = f.driver.captureCgroup;
  f.driver.captureCgroup = async (unit) => {
    await delay(STARTUP_MS + 25);
    return originalCapture(unit);
  };
  try {
    await assert.rejects(
      executeLinuxSandbox({ ...f.options, timeoutMs: STARTUP_MS * 2 }, f.driver),
      (error: unknown) =>
        error instanceof ProcessError && error.kind === 'spawn' && /startup/.test(error.message),
    );
    assert.equal(f.state.targetStarted, false);
    assert.equal(f.state.killed, true);
    assert.equal(f.state.released, true);
  } finally {
    await f.cleanup();
  }
});

test('Linux supervisor refuses completion evidence received after its shutdown proof deadline', async () => {
  const f = await fixture();
  const originalEmpty = f.driver.cgroupEmpty;
  f.driver.cgroupEmpty = async (identity) => {
    await delay(STOP_MS + 25);
    return originalEmpty(identity);
  };
  try {
    await assert.rejects(
      executeLinuxSandbox({ ...f.options, timeoutMs: STOP_MS * 3 }, f.driver),
      (error: unknown) =>
        error instanceof ProcessError &&
        error.kind === 'termination' &&
        error.cause instanceof Error &&
        /shutdown deadline/.test(error.cause.message),
    );
    assert.equal(f.state.released, false);
    await access(join(f.state.directory, 'owner.json'));
  } finally {
    await f.cleanup();
  }
});
