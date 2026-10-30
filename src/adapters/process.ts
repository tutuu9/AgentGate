import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { delimiter, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

export interface ExecuteOptions {
  command: string;
  args: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxOutputBytes?: number;
  /** Linux sandbox seccomp rejects socket inspection; supply real pipes instead of socketpairs. */
  linuxPipeTransport?: boolean;
}

export interface ExecuteResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export type Executor = (options: ExecuteOptions) => Promise<ExecuteResult>;
export type ProcessFailure = 'spawn' | 'timeout' | 'aborted' | 'output-limit' | 'termination';

// Only fixed trusted code is interpreted. The selected executable and every argument remain
// positional parameters. Wait for both output relays before the group leader exits.
const LINUX_PIPE_TRANSPORT = `
exec 3>&1 4>&2
exec 5> >(/usr/bin/cat >&4 3>&- 4>&-)
stderr_pid=$!
/usr/bin/cat 3>&- 4>&- 5>&- | "$@" 2>&5 3>&- 4>&- 5>&- | /usr/bin/cat >&3 3>&- 4>&- 5>&-
statuses=("\${PIPESTATUS[@]}")
exec 5>&-
wait "$stderr_pid"
stderr_status=$?
if (( statuses[2] != 0 || stderr_status != 0 || (statuses[0] != 0 && statuses[0] != 141) )); then
  exit 125
fi
exit "\${statuses[1]}"
`;

export class ProcessError extends Error {
  readonly kind: ProcessFailure;

  constructor(kind: ProcessFailure, message: string) {
    super(message);
    this.name = 'ProcessError';
    this.kind = kind;
  }
}

function isWithin(directory: string, path: string): boolean {
  const child = relative(directory, path);
  return (
    !child ||
    (!isAbsolute(child) &&
      child !== '..' &&
      !child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))
  );
}

async function executableFile(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve before changing cwd: Windows must never search an untrusted checkout for executables. */
export async function resolveCommand(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Promise<{ command: string; args: string[] }> {
  if (!command || command.includes('\0') || args.some((argument) => argument.includes('\0'))) {
    throw new ProcessError('spawn', 'Command and arguments must be valid process arguments.');
  }
  const untrusted = [resolve(cwd), resolve(process.cwd())];
  for (const directory of [...untrusted]) {
    try {
      untrusted.push(await realpath(directory));
    } catch {
      // Spawn will separately report an unavailable working directory.
    }
  }
  const pathValue = Object.entries(env).find(([key]) =>
    process.platform === 'win32' ? key.toLowerCase() === 'path' : key === 'PATH',
  )?.[1];
  const directories = (pathValue ?? '')
    .split(delimiter)
    .filter(
      (directory) => isAbsolute(directory) && !untrusted.some((root) => isWithin(root, directory)),
    );
  if (process.platform === 'win32' && /^(?:npm|npm\.cmd)$/i.test(command)) {
    for (const directory of [dirname(process.execPath), ...directories]) {
      const cli = join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js');
      try {
        const canonical = await realpath(cli);
        if (untrusted.some((root) => isWithin(root, canonical))) continue;
        if (!(await stat(canonical)).isFile()) continue;
        await access(canonical);
        return { command: process.execPath, args: [canonical, ...args] };
      } catch {
        // Try the next installation directory without executing anything.
      }
    }
    throw new ProcessError('spawn', 'Cannot locate npm-cli.js; install npm with Node.js 24.');
  }
  if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command)) {
    throw new ProcessError('spawn', 'Batch launchers are unsupported; configure an executable.');
  }
  if (isAbsolute(command)) {
    if (process.platform === 'win32' && !/\.(?:exe|com)$/i.test(command))
      throw new ProcessError('spawn', 'Windows commands must be .exe or .com executables.');
    if (!(await executableFile(command)))
      throw new ProcessError('spawn', 'The configured executable is unavailable.');
    return { command, args: [...args] };
  }
  if (/[\\/]/.test(command) || (process.platform === 'win32' && command.includes(':')))
    throw new ProcessError(
      'spawn',
      'Relative command paths are unsupported; configure an absolute executable.',
    );
  const names =
    process.platform === 'win32'
      ? extname(command)
        ? /\.(?:exe|com)$/i.test(command)
          ? [command]
          : []
        : [`${command}.exe`, `${command}.com`]
      : [command];
  for (const directory of directories) {
    for (const name of names) {
      const candidate = join(directory, name);
      try {
        const canonical = await realpath(candidate);
        if (untrusted.some((root) => isWithin(root, canonical))) continue;
        if (await executableFile(canonical)) return { command: canonical, args: [...args] };
      } catch {
        // Continue only through explicit absolute PATH entries; never delegate search to spawn.
      }
    }
  }
  throw new ProcessError('spawn', 'No executable was found in trusted absolute PATH directories.');
}

async function terminateTree(pid: number): Promise<void> {
  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
    return;
  }
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  await new Promise<void>((resolveTermination, reject) => {
    const killer = spawn(
      join(systemRoot, 'System32', 'taskkill.exe'),
      ['/PID', String(pid), '/T', '/F'],
      {
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
      },
    );
    const timer = setTimeout(() => {
      killer.kill();
      reject(new ProcessError('termination', 'Timed out stopping the owned process tree.'));
    }, 5_000);
    killer.once('error', () => {
      clearTimeout(timer);
      reject(new ProcessError('termination', 'Could not stop the owned process tree.'));
    });
    killer.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolveTermination();
      else
        reject(new ProcessError('termination', 'Process-tree termination could not be verified.'));
    });
  });
}

/** Captures bounded output. Nonzero program exits are results; runner failures are errors. */
export async function execute(options: ExecuteOptions): Promise<ExecuteResult> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxOutputBytes = options.maxOutputBytes ?? 4 * 1024 * 1024;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes <= 0
  ) {
    throw new ProcessError('spawn', 'Process limits must be positive safe integers.');
  }
  if (options.signal?.aborted) throw new ProcessError('aborted', 'Process cancelled.');
  let resolved = await resolveCommand(options.command, options.args, options.env, options.cwd);
  if (process.platform === 'linux' && options.linuxPipeTransport) {
    await resolveCommand('/usr/bin/cat', [], options.env, options.cwd);
    // Privileged mode suppresses BASH_ENV, imported functions and shell-option injection;
    // it does not grant privileges or change the controller's user.
    resolved = await resolveCommand(
      '/bin/bash',
      [
        '--noprofile',
        '--norc',
        '-p',
        '-c',
        LINUX_PIPE_TRANSPORT,
        'agentgate-pipes',
        resolved.command,
        ...resolved.args,
      ],
      options.env,
      options.cwd,
    );
  }
  if (options.signal?.aborted) throw new ProcessError('aborted', 'Process cancelled.');
  const started = performance.now();
  return new Promise<ExecuteResult>((resolveResult, reject) => {
    let outputBytes = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let failure: ProcessError | undefined;
    let terminating: Promise<void> | undefined;
    let closed = false;
    let settled = false;
    let stopDeadline: ReturnType<typeof setTimeout> | undefined;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(resolved.command, resolved.args, {
        cwd: options.cwd ? resolve(options.cwd) : undefined,
        env: options.env,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      reject(new ProcessError('spawn', 'The operating system refused to start the process.'));
      return;
    }
    const stop = (reason: ProcessError) => {
      if (failure || closed) return;
      failure = reason;
      stopDeadline = setTimeout(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        reject(
          new ProcessError(
            'termination',
            'The owned process tree did not close after termination; execution is blocked.',
          ),
        );
      }, 7_000);
      if (child.pid) {
        terminating = terminateTree(child.pid).catch(() => {
          failure = new ProcessError(
            'termination',
            'Process-tree termination could not be verified.',
          );
          child.kill('SIGKILL');
        });
      }
    };
    const timer = setTimeout(
      () => stop(new ProcessError('timeout', 'Process exceeded its time limit.')),
      timeoutMs,
    );
    const abort = () => stop(new ProcessError('aborted', 'Process cancelled.'));
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      if (failure) return;
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        stop(new ProcessError('output-limit', 'Process exceeded its combined output limit.'));
      } else target.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE')
        stop(new ProcessError('spawn', 'Could not deliver process input.'));
    });
    child.once('error', () => {
      failure ??= new ProcessError(
        'spawn',
        `Could not start ${isAbsolute(options.command) ? 'the configured executable' : options.command}.`,
      );
    });
    child.once('exit', () => {
      // A process group remains addressable after its leader exits on POSIX.
      if (process.platform !== 'win32' && child.pid && !terminating) {
        terminating = terminateTree(child.pid).catch(() => {
          failure = new ProcessError('termination', 'Could not stop remaining child processes.');
        });
      }
    });
    child.once('close', (code, signal) => {
      closed = true;
      clearTimeout(timer);
      clearTimeout(stopDeadline);
      options.signal?.removeEventListener('abort', abort);
      void (async () => {
        await terminating;
        if (settled) return;
        settled = true;
        if (failure) return reject(failure);
        if (code === null)
          return reject(
            new ProcessError(
              'termination',
              `Process ended without an exit code${signal ? ` (${signal})` : ''}.`,
            ),
          );
        resolveResult({
          exitCode: code,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          durationMs: performance.now() - started,
        });
      })();
    });
    child.stdin.end(options.input);
  });
}
