import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdtemp,
  open,
  readFile,
  readlink,
  realpath,
  rm,
  statfs,
  type FileHandle,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { DoctorCheck } from '../core/contracts.ts';
import {
  execute,
  ProcessError,
  resolveCommand,
  type ExecuteOptions,
  type ExecuteResult,
} from './process.ts';
import {
  ReadySchema,
  ResultSchema,
  STARTUP_MS,
  STOP_MS,
  SUPERVISOR_EXIT,
  processIdentity,
  publishGo,
  readProtocol,
  writeProtocol,
  type ProcessIdentity,
} from './linux-supervisor-protocol.ts';

export interface LinuxUnit {
  id: string;
  invocationId: string;
  mainPid: number;
  controlGroup: string;
  activeState: string;
  job: string;
  type: string;
  exitType: string;
  killMode: string;
  killSignal: string;
  sendSIGKILL: string;
  restart: string;
  collectMode: string;
  remainAfterExit: string;
  successExitStatus: string;
  restartForceExitStatus: string;
  timeoutStopMs: number;
  runtimeMaxMs: number;
}
export interface CgroupIdentity {
  path: string;
  dev: number;
  ino: number;
}
interface StartRequest {
  directory: string;
  unit: string;
  runtimeMaxMs: number;
  options: ExecuteOptions;
}
/** Offline lifecycle seam. A fake driver never establishes native isolation evidence. */
export interface LinuxSupervisionDriver {
  prerequisites(signal?: AbortSignal): Promise<void>;
  identity(pid: number): Promise<ProcessIdentity | undefined>;
  start(request: StartRequest): Promise<ExecuteResult>;
  inspect(unit: string, timeoutMs?: number): Promise<LinuxUnit | undefined>;
  captureCgroup(unit: LinuxUnit): Promise<CgroupIdentity>;
  cgroupEmpty(identity: CgroupIdentity): Promise<boolean>;
  kill(unit: string, timeoutMs?: number): Promise<void>;
  release(unit: string): Promise<void>;
}

const loaderVariables = [
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'LD_DEBUG',
  'LD_DEBUG_OUTPUT',
  'LD_PROFILE',
  'LD_ORIGIN_PATH',
  'LD_SHOW_AUXV',
  'LD_DYNAMIC_WEAK',
  'LD_HWCAP_MASK',
  'LD_BIND_NOW',
  'LD_BIND_NOT',
  'LD_ASSUME_KERNEL',
  'LD_USE_LOAD_BIAS',
  'LD_TRACE_LOADED_OBJECTS',
  'GCONV_PATH',
  'LOCPATH',
  'GLIBC_TUNABLES',
  'MALLOC_TRACE',
  'MALLOC_CHECK_',
  'NODE_OPTIONS',
  'NODE_PATH',
  'BASH_ENV',
  'ENV',
];
const cgroupHandles = new Map<string, FileHandle>();

function controlEnvironment(): NodeJS.ProcessEnv {
  const runtime = `/run/user/${process.getuid!()}`;
  return {
    PATH: '/usr/bin:/bin',
    HOME: homedir(),
    XDG_RUNTIME_DIR: runtime,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus`,
    LANG: 'C',
    LC_ALL: 'C',
    NO_COLOR: '1',
    SYSTEMD_PAGER: '',
  };
}

async function systemctl(
  args: string[],
  signal?: AbortSignal,
  timeoutMs = STOP_MS,
): Promise<ExecuteResult> {
  return execute({
    command: '/usr/bin/systemctl',
    args: ['--user', '--no-ask-password', ...args],
    env: controlEnvironment(),
    timeoutMs,
    maxOutputBytes: 32 * 1024,
    signal,
  });
}

function duration(value: string | undefined): number {
  if (!value) return NaN;
  let total = 0;
  const units: Record<string, number> = { us: 0.001, ms: 1, s: 1000, min: 60_000, h: 3_600_000 };
  for (const item of value.split(' ')) {
    const match = /^(\d+(?:\.\d+)?)(us|ms|s|min|h)$/.exec(item);
    if (!match) return NaN;
    total += Number(match[1]) * units[match[2]!]!;
  }
  return total;
}

function fields(stdout: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const line of stdout.trim().split('\n')) {
    if (!line) continue;
    const separator = line.indexOf('=');
    if (separator <= 0 || result.has(line.slice(0, separator)))
      throw new Error('Malformed systemd unit properties.');
    result.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return result;
}

const nativeDriver: LinuxSupervisionDriver = {
  async prerequisites(signal) {
    if (process.platform !== 'linux' || process.versions.node.split('.')[0] !== '24')
      throw new Error('Linux supervision requires native Linux and Node.js 24.');
    const uid = process.getuid!();
    if (uid === 0) throw new Error('Run AgentGate as an ordinary user, not root.');
    const runtime = `/run/user/${uid}`;
    const entry = await lstat(runtime);
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== uid || entry.mode & 0o077)
      throw new Error('A private, preconfigured systemd user runtime directory is required.');
    const bus = await lstat(join(runtime, 'bus'));
    if (!bus.isSocket() || bus.uid !== uid)
      throw new Error('A preconfigured systemd user bus is required.');
    if ((await statfs('/sys/fs/cgroup')).type !== 0x63677270)
      throw new Error('A unified cgroup v2 mount is required.');
    for (const tool of [
      '/usr/bin/systemd-run',
      '/usr/bin/systemctl',
      '/usr/bin/env',
      '/bin/bash',
      '/usr/bin/cat',
    ])
      await resolveCommand(tool, [], controlEnvironment());
    const version = await systemctl(['--version'], signal);
    if (version.exitCode || !/^systemd 255(?:\s|$)/.test(version.stdout))
      throw new Error('Linux supervision currently supports systemd 255 only.');
    const manager = await systemctl(['show', '--property=Version'], signal);
    if (manager.exitCode || !/^Version=255(?:[.\s-]|$)/m.test(manager.stdout))
      throw new Error('The systemd 255 user manager is unavailable.');
  },
  identity: processIdentity,
  async start({ directory, unit, runtimeMaxMs, options }) {
    const extension = extname(fileURLToPath(import.meta.url));
    const worker = new URL(`./linux-supervisor-worker${extension}`, import.meta.url).href;
    const script = `import {runLinuxSupervisor} from ${JSON.stringify(worker)};await runLinuxSupervisor(process.argv[1]);`;
    return execute({
      command: '/usr/bin/systemd-run',
      args: [
        '--user',
        '--no-ask-password',
        '--pipe',
        '--wait',
        '--quiet',
        '--expand-environment=no',
        `--unit=${unit}`,
        '--service-type=exec',
        '--property=ExitType=main',
        '--property=KillMode=control-group',
        '--property=KillSignal=SIGKILL',
        '--property=SendSIGKILL=yes',
        '--property=Restart=no',
        '--property=CollectMode=inactive',
        '--property=RemainAfterExit=no',
        '--property=SuccessExitStatus=',
        '--property=RestartForceExitStatus=',
        `--property=TimeoutStopSec=${STOP_MS}ms`,
        `--property=RuntimeMaxSec=${runtimeMaxMs}ms`,
        `--property=UnsetEnvironment=${loaderVariables.join(' ')}`,
        '--',
        '/usr/bin/env',
        '-i',
        process.execPath,
        '--input-type=module',
        '-e',
        script,
        directory,
      ],
      cwd: options.cwd,
      env: controlEnvironment(),
      input: options.input,
      maxOutputBytes: options.maxOutputBytes,
      timeoutMs: runtimeMaxMs + STOP_MS,
      signal: options.signal,
      linuxPipeTransport: true,
    });
  },
  async inspect(unit, timeoutMs) {
    const properties = [
      'Id',
      'LoadState',
      'InvocationID',
      'MainPID',
      'ControlGroup',
      'ActiveState',
      'Job',
      'Type',
      'ExitType',
      'KillMode',
      'KillSignal',
      'SendSIGKILL',
      'Restart',
      'CollectMode',
      'RemainAfterExit',
      'SuccessExitStatus',
      'RestartForceExitStatus',
      'TimeoutStopUSec',
      'RuntimeMaxUSec',
    ];
    const result = await systemctl(
      ['show', `--property=${properties.join(',')}`, '--', unit],
      undefined,
      timeoutMs,
    );
    const values = fields(result.stdout);
    if (values.get('LoadState') === 'not-found') return undefined;
    if (
      result.exitCode ||
      values.get('LoadState') !== 'loaded' ||
      properties.some((property) => !values.has(property))
    )
      throw new Error('Cannot inspect the owned systemd service.');
    const get = (key: string) => values.get(key) ?? '';
    return {
      id: get('Id'),
      invocationId: get('InvocationID'),
      mainPid: Number(get('MainPID')),
      controlGroup: get('ControlGroup'),
      activeState: get('ActiveState'),
      job: get('Job'),
      type: get('Type'),
      exitType: get('ExitType'),
      killMode: get('KillMode'),
      killSignal: get('KillSignal'),
      sendSIGKILL: get('SendSIGKILL'),
      restart: get('Restart'),
      collectMode: get('CollectMode'),
      remainAfterExit: get('RemainAfterExit'),
      successExitStatus: get('SuccessExitStatus'),
      restartForceExitStatus: get('RestartForceExitStatus'),
      timeoutStopMs: duration(get('TimeoutStopUSec')),
      runtimeMaxMs: duration(get('RuntimeMaxUSec')),
    };
  },
  async captureCgroup(unit) {
    const prefix = `/user.slice/user-${process.getuid!()}.slice/user@${process.getuid!()}.service/`;
    if (!unit.controlGroup.startsWith(prefix) || !unit.controlGroup.endsWith(`/${unit.id}`))
      throw new Error('Service cgroup is outside the current user manager.');
    const path = `/sys/fs/cgroup${unit.controlGroup}`;
    if ((await realpath(path)) !== path) throw new Error('Service cgroup path is not canonical.');
    const entry = await lstat(path);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Invalid service cgroup.');
    const members = (await readFile(join(path, 'cgroup.procs'), 'utf8')).trim().split('\n');
    if (!members.includes(String(unit.mainPid)))
      throw new Error('Supervisor is outside its service cgroup.');
    const events = await readFile(join(path, 'cgroup.events'), 'utf8');
    if (!/^populated 1$/m.test(events)) throw new Error('Supervisor cgroup was not populated.');
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const held = await handle.stat();
    if (held.dev !== entry.dev || held.ino !== entry.ino) {
      await handle.close();
      throw new Error('Cgroup identity changed while establishing ownership.');
    }
    cgroupHandles.set(path, handle);
    return { path, dev: entry.dev, ino: entry.ino };
  },
  async cgroupEmpty(identity) {
    try {
      const entry = await lstat(identity.path);
      if (
        entry.dev !== identity.dev ||
        entry.ino !== identity.ino ||
        !entry.isDirectory() ||
        entry.isSymbolicLink()
      )
        throw new Error('Owned cgroup identity changed.');
      return /^populated 0$/m.test(await readFile(join(identity.path, 'cgroup.events'), 'utf8'));
    } catch (error) {
      // Kernel removal requires an empty cgroup. Caller also requires the retained exact unit terminal.
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        const handle = cgroupHandles.get(identity.path);
        if (!handle) throw new Error('Owned cgroup handle is unavailable.', { cause: error });
        const held = await handle.stat();
        return (
          held.dev === identity.dev &&
          held.ino === identity.ino &&
          (await readlink(`/proc/self/fd/${handle.fd}`)) === `${identity.path} (deleted)`
        );
      }
      throw error;
    }
  },
  async kill(unit, timeoutMs) {
    const result = await systemctl(
      ['kill', '--kill-whom=all', '--signal=SIGKILL', '--', unit],
      undefined,
      timeoutMs,
    );
    if (result.exitCode) throw new Error('Cannot terminate the owned systemd service.');
  },
  async release(unit) {
    const result = await systemctl(['reset-failed', '--', unit]);
    if (result.exitCode) throw new Error('Cannot release the verified stopped systemd service.');
    for (const [path, handle] of cgroupHandles) {
      if (path.endsWith(`/${unit}`)) {
        await handle.close();
        cgroupHandles.delete(path);
      }
    }
  },
};

export async function checkLinuxSupervision(signal?: AbortSignal): Promise<DoctorCheck> {
  try {
    await nativeDriver.prerequisites(signal);
    return {
      name: 'linux-process-supervision',
      ok: true,
      detail:
        'Systemd 255 user manager and cgroup v2 prerequisites are available; native lifecycle observations remain mandatory.',
    };
  } catch (error) {
    signal?.throwIfAborted();
    return {
      name: 'linux-process-supervision',
      ok: false,
      detail: error instanceof Error ? error.message : 'Linux process supervision is unavailable.',
    };
  }
}

function validateUnit(unit: LinuxUnit, name: string, runtimeMaxMs: number): void {
  if (
    unit.id !== name ||
    !/^[0-9a-f]{32}$/.test(unit.invocationId) ||
    unit.type !== 'exec' ||
    unit.exitType !== 'main' ||
    unit.killMode !== 'control-group' ||
    unit.killSignal !== '9' ||
    unit.sendSIGKILL !== 'yes' ||
    unit.restart !== 'no' ||
    unit.collectMode !== 'inactive' ||
    unit.remainAfterExit !== 'no' ||
    unit.successExitStatus !== '' ||
    unit.restartForceExitStatus !== '' ||
    unit.timeoutStopMs !== STOP_MS ||
    unit.runtimeMaxMs !== runtimeMaxMs
  )
    throw new Error(
      'The systemd service does not match the required ownership and lifecycle policy.',
    );
}

function uncertain(cause: unknown): ProcessError {
  const error = new ProcessError(
    'termination',
    'Linux service shutdown could not be verified; retain the lock, launcher and supervision records.',
  );
  error.cause = cause;
  return error;
}

/** Resolves only after the exact native service cgroup is empty, including normal target exit. */
export async function executeLinuxSandbox(
  options: ExecuteOptions,
  driver: LinuxSupervisionDriver = nativeDriver,
): Promise<ExecuteResult> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > Number.MAX_SAFE_INTEGER - STARTUP_MS - 2 * STOP_MS
  )
    throw new ProcessError('spawn', 'Process time limit must be a positive safe integer.');
  if (
    options.maxOutputBytes !== undefined &&
    (!Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes <= 0)
  )
    throw new ProcessError('spawn', 'Process output limit must be a positive safe integer.');
  if (!options.cwd || !isAbsolute(options.cwd))
    throw new ProcessError(
      'spawn',
      'Linux sandbox supervision requires an absolute launcher directory.',
    );
  if (!options.env)
    throw new ProcessError(
      'spawn',
      'Linux sandbox supervision requires an explicit isolated environment.',
    );
  const allowedEnvironment = new Set([
    'path',
    'lang',
    'lc_all',
    'systemroot',
    'windir',
    'comspec',
    'pathext',
    'programfiles',
    'programfiles(x86)',
    'systemdrive',
    'processor_architecture',
    'number_of_processors',
    'codex_home',
    'home',
    'temp',
    'tmp',
    'tmpdir',
    'no_color',
    'ci',
    'git_terminal_prompt',
  ]);
  if (
    Object.entries(options.env).some(
      ([name, value]) =>
        value !== undefined &&
        (!allowedEnvironment.has(name.toLowerCase()) ||
          name.includes('\0') ||
          value.includes('\0')),
    )
  )
    throw new ProcessError('spawn', 'Linux sandbox environment contains an unsupported variable.');
  if (options.signal?.aborted) throw new ProcessError('aborted', 'Process cancelled.');
  await driver.prerequisites(options.signal);
  const cwd = await realpath(options.cwd);
  const runtime = await realpath(dirname(cwd));
  if (basename(runtime) !== 'runtime' || !basename(cwd).startsWith('launch-'))
    throw new ProcessError(
      'spawn',
      'Linux sandbox supervision requires an owned runtime launcher.',
    );
  if (process.platform === 'linux') {
    for (const path of [cwd, runtime]) {
      const entry = await lstat(path);
      if (!entry.isDirectory() || entry.uid !== process.getuid!() || entry.mode & 0o077)
        throw new ProcessError(
          'spawn',
          'Supervisor runtime directories must be private and owned by the controller.',
        );
    }
  }
  const selected = await resolveCommand(options.command, options.args, options.env, cwd);
  const controller = await driver.identity(process.pid);
  if (!controller) throw new ProcessError('spawn', 'Cannot establish controller process identity.');
  const nonce = randomUUID();
  const unitName = `agentgate-${nonce}.service`;
  if (await driver.inspect(unitName))
    throw new ProcessError('spawn', 'Supervisor unit name already exists.');
  const directory = await mkdtemp(join(runtime, 'supervision-'));
  const child = relative(runtime, directory);
  if (!child || isAbsolute(child) || child.startsWith('..') || resolve(directory) === runtime)
    throw new ProcessError('spawn', 'Unsafe supervision directory ownership.');
  const runtimeMaxMs = timeoutMs + STARTUP_MS + STOP_MS;
  await writeProtocol(directory, 'request.json', {
    nonce,
    unit: unitName,
    controller,
    command: selected.command,
    args: selected.args,
    cwd,
    env: Object.fromEntries(Object.entries(options.env).filter((entry) => entry[1] !== undefined)),
  });
  if (options.signal?.aborted) {
    await rm(directory, { recursive: true });
    throw new ProcessError('aborted', 'Process cancelled.');
  }
  const started = performance.now();
  const wrapperStop = new AbortController();
  type Outcome = { result: ExecuteResult } | { error: unknown };
  let outcome: Outcome | undefined;
  let cause: unknown;
  let owner:
    | { invocationId: string; controlGroup: string; cgroup: CgroupIdentity; mainPid: number }
    | undefined;
  let killRequested = false;
  let stopStarted: number | undefined;
  let verified = false;
  const noteFailure = (error: unknown) => {
    cause ??= error;
    if (owner) stopStarted ??= performance.now();
  };
  const proofRemaining = () => {
    if (stopStarted === undefined) return STOP_MS;
    const remaining = Math.floor(STOP_MS - (performance.now() - stopStarted));
    if (remaining <= 0)
      throw new Error('Native supervisor did not stop before the shutdown deadline.');
    return remaining;
  };
  const cancel = () => noteFailure(new ProcessError('aborted', 'Process cancelled.'));
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const execution = driver
    .start({
      directory,
      unit: unitName,
      runtimeMaxMs,
      options: { ...options, cwd, signal: wrapperStop.signal },
    })
    .then(
      (result) => {
        outcome = { result };
      },
      (error: unknown) => {
        outcome = { error };
        noteFailure(error);
      },
    );
  try {
    while (true) {
      if (options.signal?.aborted) cancel();
      if (performance.now() - started >= timeoutMs)
        noteFailure(new ProcessError('timeout', 'Process exceeded its time limit.'));
      if (outcome && 'error' in outcome) noteFailure(outcome.error);
      const unit = await driver.inspect(unitName, proofRemaining());
      proofRemaining();
      if (unit) {
        validateUnit(unit, unitName, runtimeMaxMs);
        if (owner && unit.invocationId !== owner.invocationId)
          throw new Error('Supervisor service invocation changed.');
        if (
          owner &&
          unit.controlGroup !== owner.controlGroup &&
          !(unit.controlGroup === '' && ['failed', 'inactive'].includes(unit.activeState))
        )
          throw new Error('Supervisor service cgroup changed.');
        if (
          owner &&
          !['failed', 'inactive'].includes(unit.activeState) &&
          unit.mainPid !== owner.mainPid
        )
          throw new Error('Supervisor main process changed.');
        if (!owner) {
          const ready = await readProtocol(join(directory, 'ready.json'), ReadySchema);
          if (ready) {
            const identity = await driver.identity(ready.pid);
            if (
              ready.nonce !== nonce ||
              ready.pid !== unit.mainPid ||
              identity?.startTime !== ready.startTime
            )
              throw new Error('Supervisor readiness does not match the native main process.');
            owner = {
              invocationId: unit.invocationId,
              controlGroup: unit.controlGroup,
              cgroup: await driver.captureCgroup(unit),
              mainPid: unit.mainPid,
            };
            if (cause) stopStarted ??= performance.now();
            await writeProtocol(directory, 'owner.json', { nonce, unit: unitName, ...owner });
            if (!cause) {
              const published = await publishGo(
                directory,
                {
                  nonce,
                  invocationId: owner.invocationId,
                  controlGroup: owner.controlGroup,
                  mainPid: owner.mainPid,
                },
                () =>
                  options.signal?.aborted === true ||
                  performance.now() - started >= Math.min(timeoutMs, STARTUP_MS),
              );
              if (!published)
                noteFailure(
                  options.signal?.aborted
                    ? new ProcessError('aborted', 'Process cancelled.')
                    : performance.now() - started >= timeoutMs
                      ? new ProcessError('timeout', 'Process exceeded its time limit.')
                      : new ProcessError('spawn', 'Supervisor startup exceeded its time limit.'),
                );
            }
          }
        }
        if (owner) {
          if (['failed', 'inactive', 'deactivating'].includes(unit.activeState))
            stopStarted ??= performance.now();
          if (
            ['failed', 'inactive'].includes(unit.activeState) &&
            !unit.job &&
            (await driver.cgroupEmpty(owner.cgroup))
          ) {
            proofRemaining();
            verified = true;
            break;
          }
          if (cause && !killRequested) {
            killRequested = true;
            stopStarted ??= performance.now();
            try {
              await driver.kill(unitName, proofRemaining());
            } catch {
              /* A racing normal exit is resolved by the next exact-unit observation. */
            }
          }
        }
      } else if (owner)
        throw new Error('Owned systemd service disappeared before shutdown verification.');
      if (!owner && performance.now() - started >= STARTUP_MS)
        throw new Error(
          'Could not establish native supervisor ownership before the startup deadline.',
        );
      proofRemaining();
      await delay(25);
    }
    const drainDeadline = performance.now() + STOP_MS;
    while (!outcome && performance.now() < drainDeadline) await delay(10);
    if (!outcome)
      throw new Error('Supervisor output transport did not close after verified native shutdown.');
    if ('error' in outcome) cause ??= outcome.error;
    if (performance.now() - started >= timeoutMs)
      cause ??= new ProcessError('timeout', 'Process exceeded its time limit.');
    if (!cause) {
      const result = await readProtocol(join(directory, 'result.json'), ResultSchema);
      if (!result || result.nonce !== nonce)
        throw new Error('Missing trusted supervisor completion record.');
      if (result.kind === 'failure')
        cause = new ProcessError('spawn', `Linux supervisor failed: ${result.reason}.`);
      else if ('result' in outcome && outcome.result.exitCode === SUPERVISOR_EXIT) {
        await driver.release(unitName);
        await rm(directory, { recursive: true });
        if (cause) throw cause;
        return {
          ...outcome.result,
          exitCode: result.exitCode,
          durationMs: performance.now() - started,
        };
      } else throw new Error('Unexpected supervisor transport exit status.');
    }
    await driver.release(unitName);
    await rm(directory, { recursive: true });
    throw cause;
  } catch (error) {
    if (verified && error === cause) throw error;
    // Never abandon a known live service merely because its capture wrapper failed.
    if (owner && !killRequested && !verified) {
      try {
        stopStarted ??= performance.now();
        const unit = await driver.inspect(unitName, proofRemaining());
        if (unit?.invocationId === owner.invocationId)
          await driver.kill(unitName, proofRemaining());
      } catch {
        /* Retained records are the recovery authority when stopping is unavailable. */
      }
    }
    wrapperStop.abort();
    // Existing execute() has a bounded termination deadline. The native service is tracked separately.
    await execution;
    const failure = uncertain(cause ?? error);
    if (cause && error !== cause) failure.cause = new AggregateError([cause, error]);
    throw failure;
  } finally {
    options.signal?.removeEventListener('abort', cancel);
  }
}
