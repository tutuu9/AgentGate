import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import {
  CheckSchema,
  type CheckResult,
  type CheckSpec,
  type DoctorCheck,
  type SandboxRunner,
} from '../core/contracts.ts';
import {
  execute,
  ProcessError,
  resolveCommand,
  type ExecuteResult,
  type Executor,
} from './process.ts';

export const CODEX_VERSION = '0.154.0';
export const DISABLED_FEATURES = [
  'apps',
  'plugins',
  'remote_plugin',
  'hooks',
  'browser_use',
  'browser_use_external',
  'computer_use',
  'image_generation',
  'skill_mcp_dependency_install',
  'multi_agent',
] as const;

export interface CodexOptions {
  home: string;
  codexPath?: string;
  executor?: Executor;
  /** Injection for offline behavior tests, never a replacement for live acceptance evidence. */
  connectivity?: (host: string, port: number, signal?: AbortSignal) => Promise<boolean>;
}

export interface SandboxSession {
  launcher: string;
  profile: string;
  env: NodeJS.ProcessEnv;
  configArgs: string[];
  cleanup(): Promise<void>;
}

/** Cleanup failure must never hide an uncertain process-tree termination. */
export async function cleanupPreservingError(
  cleanup: () => Promise<void>,
  operationFailed: boolean,
): Promise<void> {
  try {
    await cleanup();
  } catch (error) {
    if (!operationFailed) throw error;
  }
}

/** Only infrastructure variables reach agents/checks; never tokens, proxies or shell injection settings. */
export function isolatedEnvironment(
  home: string,
  temporary: string,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const allowed = new Set([
    'path',
    'systemroot',
    'windir',
    'comspec',
    'pathext',
    'programfiles',
    'programfiles(x86)',
    'systemdrive',
    'processor_architecture',
    'number_of_processors',
    'lang',
    'lc_all',
  ]);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (allowed.has(key.toLowerCase()) && value !== undefined) env[key] = value;
  }
  env.CODEX_HOME = join(resolve(home), 'codex');
  env.HOME = homedir();
  if (process.platform === 'win32') env.USERPROFILE = homedir();
  env.TEMP = temporary;
  env.TMP = temporary;
  env.TMPDIR = temporary;
  env.NO_COLOR = '1';
  env.CI = '1';
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

function config(key: string, value: unknown): string[] {
  return ['-c', `${key}=${tomlValue(value)}`];
}

function tomlValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => `${JSON.stringify(key)}=${tomlValue(entry)}`)
      .join(',')}}`;
  const scalar = JSON.stringify(value);
  if (scalar === undefined || value === null)
    throw new Error('Invalid policy configuration value.');
  return scalar;
}

export async function createSandboxSession(
  home: string,
  worktree?: string,
  writable = false,
): Promise<SandboxSession> {
  const root = resolve(home);
  const runtime = join(root, 'runtime');
  for (const owned of [root, runtime, join(root, 'codex')]) {
    await canonicalDirectory(owned, true);
    if (process.platform !== 'win32') await chmod(owned, 0o700);
  }
  const target = worktree ? await canonicalDirectory(resolve(worktree)) : undefined;
  const launcher = await mkdtemp(join(runtime, 'launch-'));
  const temporary = join(launcher, 'tmp');
  await mkdir(temporary, { mode: 0o700 });
  const profile = `agentgate-${randomUUID()}`;
  const prefix = `permissions.${profile}`;
  const env = isolatedEnvironment(root, temporary);
  const filesystem: Record<string, string> = {
    ':root': 'deny',
    ':minimal': 'read',
    [launcher]: 'read',
    [temporary]: 'write',
    [dirname(process.execPath)]: 'read',
    [join(root, 'codex')]: 'deny',
  };
  if (target) {
    filesystem[target] = writable ? 'write' : 'read';
    for (const protectedName of ['.git', '.agents', '.codex', '.aws'])
      filesystem[join(target, protectedName)] = 'read';
  }
  const configArgs = [
    ...config('project_root_markers', []),
    ...config('forced_login_method', 'chatgpt'),
    ...config('model_provider', 'openai'),
    ...config('web_search', 'disabled'),
    ...config('approval_policy', 'never'),
    ...config('allow_login_shell', false),
    ...config('shell_environment_policy.inherit', 'none'),
    ...config('shell_environment_policy.set', env),
    ...config('default_permissions', profile),
    ...config(`${prefix}.filesystem`, filesystem),
    ...config(`${prefix}.network.enabled`, false),
    ...DISABLED_FEATURES.flatMap((feature) => config(`features.${feature}`, false)),
  ];
  if (process.platform === 'win32') configArgs.push(...config('windows.sandbox', 'elevated'));
  return {
    launcher,
    profile,
    env,
    configArgs,
    async cleanup() {
      const child = relative(runtime, launcher);
      if (!child || isAbsolute(child) || child.startsWith('..'))
        throw new Error('Unsafe scratch cleanup path.');
      await canonicalDirectory(runtime);
      await canonicalDirectory(launcher);
      await rm(launcher, { recursive: true, force: true });
    },
  };
}

/** Do not grant or recursively remove a redirected controller directory or worktree. */
async function canonicalDirectory(path: string, create = false): Promise<string> {
  let entry;
  try {
    entry = await lstat(path);
  } catch (error) {
    if (!create || !(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT')
      throw error;
    await canonicalDirectory(dirname(path), true);
    await mkdir(path, { mode: 0o700 });
    entry = await lstat(path);
  }
  if (!entry.isDirectory() || entry.isSymbolicLink() || relative(path, await realpath(path)))
    throw new Error('Sandbox directories must be real canonical directories, without links.');
  return path;
}

export function diagnostic(error: unknown): string {
  if (error instanceof ProcessError) return `${error.kind}: ${error.message}`;
  if (error instanceof Error && /^(EACCES|EPERM|ENOENT):/.test(error.message))
    return error.message.slice(0, 200);
  return 'The prerequisite could not be established.';
}

function sandboxFailure(result: ExecuteResult): string {
  const line = result.stderr
    .split(/\r?\n/)
    .find((entry) =>
      /sandbox failed|CreateRestrictedToken|bwrap|unknown field|invalid|error:|requires|denied/i.test(
        entry,
      ),
    );
  return line
    ? line.replace(/(?:sk-|gh[pousr]_)[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 240)
    : `Sandbox process exited ${result.exitCode}.`;
}

export function redactOutput(output: string): string {
  return output
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,})\b/g,
      '[redacted]',
    )
    .replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s]+/gi, '$1[redacted]')
    .replace(/((?:password|token|secret|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]');
}

async function reachable(host: string, port: number, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  return new Promise((resolveReachable, reject) => {
    const socket = createConnection({ host, port });
    const abort = () => {
      socket.destroy();
      reject(signal?.reason ?? new Error('Connectivity check cancelled.'));
    };
    const finish = (value: boolean) => {
      signal?.removeEventListener('abort', abort);
      socket.destroy();
      resolveReachable(value);
    };
    signal?.addEventListener('abort', abort, { once: true });
    socket.setTimeout(2_500, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

const ProbeSchema = z.object({
  readWorkspace: z.boolean(),
  writeWorkspace: z.boolean(),
  readSentinel: z.boolean(),
  writeOutside: z.boolean(),
  loopback: z.boolean(),
  egress: z.boolean(),
  credentials: z.boolean(),
});

function probeScript(paths: {
  allowed: string;
  sentinel: string;
  outside: string;
  write: string;
  port: number;
}): string {
  // Only controller-generated fixture paths enter this fixed script, never issue/model input.
  return `const fs=require('node:fs');const net=require('node:net');
const p=${JSON.stringify(paths)};
function attempt(fn){try{fn();return true}catch{return false}}
function connect(host,port){return new Promise(resolve=>{const s=net.createConnection({host,port});const done=v=>{s.destroy();resolve(v)};s.setTimeout(2500,()=>done(false));s.once('connect',()=>done(true));s.once('error',()=>done(false))})}
(async()=>{const result={readWorkspace:attempt(()=>fs.readFileSync(p.allowed)),writeWorkspace:attempt(()=>fs.writeFileSync(p.write,'fixture')),readSentinel:attempt(()=>fs.readFileSync(p.sentinel)),writeOutside:attempt(()=>fs.writeFileSync(p.outside,'fixture')),loopback:await connect('127.0.0.1',p.port),egress:await connect('1.1.1.1',443),credentials:['GH_TOKEN','GITHUB_TOKEN','OPENAI_API_KEY','CODEX_API_KEY','ANTHROPIC_API_KEY','SSH_AUTH_SOCK'].some(k=>Boolean(process.env[k]))};console.log(JSON.stringify(result))})().catch(()=>process.exit(2));`;
}

export class CodexSandbox implements SandboxRunner {
  readonly home: string;
  readonly codexPath: string;
  private readonly executor: Executor;
  private readonly connectivity: (
    host: string,
    port: number,
    signal?: AbortSignal,
  ) => Promise<boolean>;

  constructor(options: CodexOptions) {
    this.home = resolve(options.home);
    this.codexPath = options.codexPath ?? 'codex';
    this.executor = options.executor ?? execute;
    this.connectivity = options.connectivity ?? reachable;
  }

  async prerequisites(session: SandboxSession, signal?: AbortSignal): Promise<DoctorCheck[]> {
    const checks: DoctorCheck[] = [];
    const command = async (args: string[]) => {
      signal?.throwIfAborted();
      const result = await this.executor({
        command: this.codexPath,
        args: [...session.configArgs, ...args],
        cwd: session.launcher,
        env: session.env,
        timeoutMs: 15_000,
        maxOutputBytes: 1024 * 1024,
        signal,
      });
      signal?.throwIfAborted();
      return result;
    };
    try {
      const result = await command(['--version']);
      const ok = result.exitCode === 0 && result.stdout.trim() === `codex-cli ${CODEX_VERSION}`;
      checks.push({
        name: 'codex-version',
        ok,
        detail: ok
          ? `Verified Codex CLI ${CODEX_VERSION}.`
          : `Codex CLI ${CODEX_VERSION} is required; other versions need compatibility validation.`,
      });
      if (!ok) return checks;
      const features = await command(['features', 'list']);
      const states = new Map<string, string>(
        features.stdout.split(/\r?\n/).map((line) => {
          const match = /^(\S+)\s+.+\s+(true|false)\s*$/.exec(line);
          return match ? [match[1]!, match[2]!] : ['', ''];
        }),
      );
      const enabled = DISABLED_FEATURES.filter((name) => states.get(name) !== 'false');
      checks.push({
        name: 'codex-integrations',
        ok: features.exitCode === 0 && enabled.length === 0,
        detail:
          features.exitCode !== 0
            ? `Feature configuration failed: ${sandboxFailure(features)}`
            : enabled.length
              ? `Required features could not be disabled: ${enabled.join(', ')}.`
              : 'External integrations, hooks, and subagents are disabled in the effective feature configuration.',
      });
      const mcp = await command(['mcp', 'list', '--json']);
      let mcpDisabled = false;
      try {
        const entries: unknown = JSON.parse(mcp.stdout);
        mcpDisabled =
          Array.isArray(entries) &&
          entries.every(
            (entry) =>
              typeof entry === 'object' &&
              entry !== null &&
              'enabled' in entry &&
              entry.enabled === false,
          );
      } catch {
        /* Invalid configuration output cannot authorize execution. */
      }
      checks.push({
        name: 'codex-mcp',
        ok: mcp.exitCode === 0 && mcpDisabled,
        detail:
          mcp.exitCode !== 0
            ? `MCP configuration failed: ${sandboxFailure(mcp)}`
            : mcpDisabled
              ? 'No enabled direct MCP servers.'
              : 'MCP configuration could not be proven empty/disabled; remove integrations from the AgentGate profile or managed defaults.',
      });
      const auth = await command(['login', 'status']);
      const chatgpt =
        auth.exitCode === 0 &&
        /logged in using chatgpt/i.test(`${auth.stdout}\n${auth.stderr}`) &&
        !/using an? api key/i.test(`${auth.stdout}\n${auth.stderr}`);
      checks.push({
        name: 'codex-auth',
        ok: chatgpt,
        detail: chatgpt
          ? 'The separate AgentGate profile uses ChatGPT authentication.'
          : 'Sign in with ChatGPT using the native Codex login flow and CODEX_HOME set to the AgentGate codex directory. AgentGate never copies credentials or falls back to API billing.',
      });
      const help = await command(['sandbox', '--help']);
      const supported =
        help.exitCode === 0 &&
        help.stdout.includes('--permission-profile') &&
        help.stdout.includes('--include-managed-config');
      checks.push({
        name: 'sandbox-interface',
        ok: supported,
        detail: supported
          ? 'The native permission-profile sandbox interface is available.'
          : 'The expected native sandbox permission-profile interface is unavailable.',
      });
    } catch (error) {
      if (error instanceof ProcessError && error.kind === 'termination') throw error;
      signal?.throwIfAborted();
      checks.push({ name: 'codex-prerequisites', ok: false, detail: diagnostic(error) });
    }
    return checks;
  }

  async doctor(signal?: AbortSignal): Promise<DoctorCheck[]> {
    signal?.throwIfAborted();
    if (process.platform !== 'win32' && process.platform !== 'linux')
      return [
        {
          name: 'platform',
          ok: false,
          detail: 'AgentGate supports native Windows and Linux only.',
        },
      ];
    let session: SandboxSession | undefined;
    let failed = false;
    try {
      session = await createSandboxSession(this.home);
      const checks = await this.prerequisites(session, signal);
      signal?.throwIfAborted();
      if (checks.some((check) => !check.ok && check.name !== 'codex-auth')) return checks;
      if (process.platform === 'win32') {
        const configured = await lstat(join(this.home, 'codex', '.sandbox')).then(
          (entry) => entry.isDirectory() && !entry.isSymbolicLink(),
          () => false,
        );
        checks.push({
          name: 'windows-sandbox-setup',
          ok: configured,
          detail: configured
            ? 'Existing sandbox state found; live probes must still verify isolation.'
            : 'The separate Codex profile has no native sandbox state. Configure the elevated sandbox through native Codex in this profile first; AgentGate never starts administrator setup.',
        });
        if (!configured) return checks;
      }
      checks.push(...(await this.probeIsolation(signal)));
      return checks;
    } catch (error) {
      failed = true;
      if (error instanceof ProcessError && error.kind === 'termination') throw error;
      signal?.throwIfAborted();
      return [{ name: 'sandbox-doctor', ok: false, detail: diagnostic(error) }];
    } finally {
      await cleanupPreservingError(async () => session?.cleanup(), failed);
    }
  }

  private async probeIsolation(signal?: AbortSignal): Promise<DoctorCheck[]> {
    signal?.throwIfAborted();
    const fixture = await mkdtemp(join(this.home, 'runtime', 'probe-'));
    const workspace = join(fixture, 'workspace');
    await mkdir(workspace);
    const allowed = join(workspace, 'allowed.txt');
    const sentinel = join(fixture, 'fake-secret.txt');
    await writeFile(allowed, 'AgentGate sandbox fixture');
    await writeFile(sentinel, `FAKE-SECRET-${randomUUID()}`, { mode: 0o600 });
    const server = createServer((socket) => socket.end());
    const checks: DoctorCheck[] = [];
    let failed = false;
    try {
      await new Promise<void>((resolveListen, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolveListen);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No probe port.');
      signal?.throwIfAborted();
      const egressBaseline = await this.connectivity('1.1.1.1', 443, signal);
      for (const writable of [false, true]) {
        signal?.throwIfAborted();
        const session = await createSandboxSession(this.home, workspace, writable);
        let invocationFailed = false;
        try {
          signal?.throwIfAborted();
          const result = await this.executor({
            command: this.codexPath,
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
              probeScript({
                allowed,
                sentinel,
                outside: join(fixture, 'forbidden-write.txt'),
                write: join(workspace, writable ? 'write-mode.txt' : 'readonly-mode.txt'),
                port: address.port,
              }),
            ],
            cwd: session.launcher,
            env: session.env,
            timeoutMs: 20_000,
            maxOutputBytes: 128 * 1024,
            signal,
          });
          signal?.throwIfAborted();
          if (result.exitCode !== 0) {
            checks.push({
              name: writable ? 'sandbox-write' : 'sandbox-read',
              ok: false,
              detail: sandboxFailure(result),
            });
            break;
          }
          const value = ProbeSchema.safeParse(JSON.parse(result.stdout.trim()));
          if (!value.success) {
            checks.push({
              name: 'sandbox-probe',
              ok: false,
              detail: 'Sandbox probe did not return the expected observation data.',
            });
            break;
          }
          const p = value.data;
          const filesystemOk =
            p.readWorkspace &&
            p.writeWorkspace === writable &&
            !p.readSentinel &&
            !p.writeOutside &&
            !p.credentials;
          checks.push({
            name: writable ? 'sandbox-write' : 'sandbox-read',
            ok: filesystemOk,
            detail: filesystemOk
              ? 'Live fixture verified workspace permissions, denied fake-secret read, denied outside write, and absent credential environment.'
              : 'Live fixture failed a filesystem or environment boundary; execution is blocked.',
          });
          checks.push({
            name: writable ? 'sandbox-write-network' : 'sandbox-read-network',
            ok: egressBaseline && !p.loopback && !p.egress,
            detail: !egressBaseline
              ? 'The controller could not establish the external TCP baseline; network isolation remains unverified.'
              : !p.loopback && !p.egress
                ? 'Live probe blocked loopback and public TCP connections; controller baseline was reachable.'
                : 'The sandbox allowed a network connection; execution is blocked.',
          });
        } catch (error) {
          invocationFailed = true;
          if (error instanceof ProcessError && error.kind === 'termination') throw error;
          signal?.throwIfAborted();
          checks.push({
            name: writable ? 'sandbox-write' : 'sandbox-read',
            ok: false,
            detail: diagnostic(error),
          });
          break;
        } finally {
          await cleanupPreservingError(() => session.cleanup(), invocationFailed);
        }
      }
      return checks;
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      server.close();
      await cleanupPreservingError(async () => {
        const safe = relative(join(this.home, 'runtime'), fixture);
        if (safe && !safe.startsWith('..') && !isAbsolute(safe)) {
          await canonicalDirectory(join(this.home, 'runtime'));
          await canonicalDirectory(fixture);
          await rm(fixture, { recursive: true, force: true });
        }
      }, failed);
    }
  }

  async check(spec: CheckSpec, worktree: string, signal?: AbortSignal): Promise<CheckResult> {
    spec = CheckSchema.parse(spec);
    signal?.throwIfAborted();
    const doctor = await this.doctor(signal);
    signal?.throwIfAborted();
    const blocked = doctor.filter((check) => !check.ok);
    if (!doctor.length || blocked.length)
      throw new Error(
        `Sandbox blocked: ${blocked.map((check) => `${check.name}: ${check.detail}`).join(' ')}`,
      );
    const session = await createSandboxSession(this.home, worktree, true);
    let failed = false;
    try {
      signal?.throwIfAborted();
      const command = await resolveCommand(spec.command, spec.args, session.env, worktree);
      // The fixed Node trampoline changes cwd without exposing the project to Codex config discovery.
      const trampoline = `const {spawn}=require('node:child_process');const [cwd,cmd,...args]=process.argv.slice(1);process.chdir(cwd);const p=spawn(cmd,args,{shell:false,stdio:'inherit',windowsHide:true});p.on('error',()=>process.exit(127));p.on('exit',(code)=>process.exit(code??1));`;
      const result = await this.executor({
        command: this.codexPath,
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
          trampoline,
          resolve(worktree),
          command.command,
          ...command.args,
        ],
        cwd: session.launcher,
        env: session.env,
        timeoutMs: Math.min(spec.timeoutMs, 600_000),
        signal,
      });
      return {
        name: spec.name,
        exitCode: result.exitCode,
        output: redactOutput(`${result.stdout}${result.stderr ? `\n${result.stderr}` : ''}`),
        durationMs: result.durationMs,
      };
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      await cleanupPreservingError(() => session.cleanup(), failed);
    }
  }
}
