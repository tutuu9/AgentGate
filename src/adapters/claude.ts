import { chmod, lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type {
  AgentContext,
  AgentResultMap,
  AgentRunner,
  AgentStage,
  DoctorCheck,
} from '../core/contracts.ts';
import { hasUncertainTermination } from '../core/errors.ts';
import {
  buildAgentPrompt,
  ModelOptionsSchema,
  STAGE_SCHEMA,
  type ModelOptions,
} from './agent-prompt.ts';
import { execute, type Executor } from './process.ts';
import { cleanupPreservingError, diagnostic, isolatedEnvironment } from './sandbox.ts';

/** Validated on Windows 11 only; other versions need a new compatibility review. */
export const CLAUDE_VERSION = '2.1.287';
export const CLAUDE_SUPPORTED_PLATFORMS: readonly NodeJS.Platform[] = ['win32', 'linux'];

export const CLAUDE_BOUNDARY_NOTICE =
  'Claude Code has no OS-level isolation for its own file tools: AgentGate limits it to file tools inside the worktree through Claude Code permission rules, not an operating-system sandbox.';

const READ_TOOLS = ['Read', 'Glob', 'Grep'] as const;
const EDIT_TOOLS = ['Edit', 'Write'] as const;
// Defense in depth behind --tools and --restricted. Protected paths mirror the Codex profile.
const DENIED_RULES = [
  'Bash',
  'PowerShell',
  'WebFetch',
  'WebSearch',
  'Agent',
  'Task',
  'NotebookEdit',
  ...['.git', '.claude', '.agents', '.codex', '.aws'].flatMap((name) => [
    `Edit(./${name})`,
    `Edit(./${name}/**)`,
  ]),
];
// Keep this minimal: print mode silently ignores a settings file that fails validation.
const SESSION_SETTINGS = {
  forceLoginMethod: 'claudeai',
  disableAllHooks: true,
  permissions: { disableBypassPermissionsMode: 'disable' },
};

export interface ClaudeOptions extends ModelOptions {
  home: string;
  claudePath?: string;
  executor?: Executor;
  /** The user's explicit acceptance that permission rules replace OS isolation for this provider. */
  acceptPermissionBoundary?: boolean;
}

const AuthStatusSchema = z.object({
  loggedIn: z.literal(true),
  authMethod: z.literal('claude.ai'),
  apiProvider: z.literal('firstParty'),
  // Present whenever Claude Code would use an API key; it must stay absent.
  apiKeySource: z.never().optional(),
});

const ResultEnvelopeSchema = z.object({
  type: z.literal('result'),
  subtype: z.string(),
  is_error: z.boolean(),
  structured_output: z.unknown().optional(),
});

/** Keep only the validated structured result; never persist the raw envelope or transcript. */
export function parseClaudeOutput<S extends AgentStage>(
  stage: S,
  output: string,
): AgentResultMap[S] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error('Claude Code returned malformed JSON; no result was accepted.');
  }
  const envelope = ResultEnvelopeSchema.safeParse(parsed);
  if (!envelope.success) throw new Error('Claude Code returned an invalid result envelope.');
  if (envelope.data.is_error || envelope.data.subtype !== 'success')
    throw new Error('Claude Code reported a failed run; its raw output was discarded.');
  if (envelope.data.structured_output === undefined)
    throw new Error('Claude Code did not complete with a structured final response.');
  const result = STAGE_SCHEMA[stage].safeParse(envelope.data.structured_output);
  if (!result.success)
    throw new Error(`Claude Code ${stage} response did not satisfy the agreed schema.`);
  return result.data as AgentResultMap[S];
}

/** Infrastructure variables only, plus the separate AgentGate Claude profile. */
export function claudeEnvironment(
  home: string,
  temporary: string,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = isolatedEnvironment(home, temporary, source);
  delete env.CODEX_HOME;
  delete env.NODE_OPTIONS;
  env.CLAUDE_CONFIG_DIR = claudeConfigDirectory(home);
  env.DISABLE_AUTOUPDATER = '1';
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  return env;
}

export function claudeConfigDirectory(home: string): string {
  return join(resolve(home), 'claude');
}

/** Every argument is controller-owned; task data travels only through stdin. */
export function claudeArguments(stage: AgentStage, schema: string, options: ModelOptions = {}) {
  const tools = stage === 'implement' ? [...READ_TOOLS, ...EDIT_TOOLS] : [...READ_TOOLS];
  return [
    '-p',
    '--restricted',
    '--output-format',
    'json',
    '--json-schema',
    schema,
    '--permission-mode',
    'dontAsk',
    '--permission-prompts',
    'none',
    '--tools',
    tools.join(','),
    ...(stage === 'implement' ? ['--allowedTools', 'Edit(./**)'] : []),
    '--disallowedTools',
    DENIED_RULES.join(','),
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--settings',
    JSON.stringify(SESSION_SETTINGS),
    ...(options.model ? ['--model', options.model] : []),
    ...(options.reasoningEffort ? ['--effort', options.reasoningEffort] : []),
  ];
}

export class ClaudeRunner implements AgentRunner {
  private readonly home: string;
  private readonly claudePath: string;
  private readonly executor: Executor;
  private readonly accepted: boolean;
  private readonly modelOptions: ModelOptions;

  constructor(options: ClaudeOptions) {
    this.modelOptions = ModelOptionsSchema.parse({
      model: options.model,
      reasoningEffort: options.reasoningEffort,
    });
    this.home = resolve(options.home);
    this.claudePath = options.claudePath ?? 'claude';
    this.executor = options.executor ?? execute;
    this.accepted = options.acceptPermissionBoundary === true;
  }

  async doctor(signal?: AbortSignal): Promise<DoctorCheck[]> {
    signal?.throwIfAborted();
    const checks: DoctorCheck[] = [];
    const platform = CLAUDE_SUPPORTED_PLATFORMS.includes(process.platform);
    checks.push({
      name: 'claude-platform',
      ok: platform,
      detail: platform
        ? `Claude Code provider is supported on ${process.platform}.`
        : 'The Claude Code provider supports only Windows and Linux.',
    });
    checks.push({
      name: 'claude-permission-boundary',
      ok: this.accepted,
      detail: this.accepted
        ? `Accepted for this invocation. ${CLAUDE_BOUNDARY_NOTICE}`
        : `${CLAUDE_BOUNDARY_NOTICE} Pass --accept-claude-permission-boundary to accept it explicitly.`,
    });
    if (!platform) return checks;
    const scratch = await this.scratch();
    let uncertain = false;
    try {
      const command = async (args: string[]) => {
        signal?.throwIfAborted();
        const result = await this.executor({
          command: this.claudePath,
          args,
          cwd: scratch.directory,
          env: scratch.env,
          timeoutMs: 20_000,
          maxOutputBytes: 1024 * 1024,
          signal,
        });
        signal?.throwIfAborted();
        return result;
      };
      try {
        const version = await command(['--version']);
        const ok =
          version.exitCode === 0 && version.stdout.trim() === `${CLAUDE_VERSION} (Claude Code)`;
        checks.push({
          name: 'claude-version',
          ok,
          detail: ok
            ? `Verified Claude Code ${CLAUDE_VERSION}.`
            : `Claude Code ${CLAUDE_VERSION} is required; other versions need compatibility validation.`,
        });
        if (!ok) return checks;
        const status = await command(['auth', 'status', '--json']);
        let subscription = false;
        try {
          subscription =
            status.exitCode === 0 && AuthStatusSchema.safeParse(JSON.parse(status.stdout)).success;
        } catch {
          /* Unreadable status output cannot authorize execution. */
        }
        checks.push({
          name: 'claude-auth',
          ok: subscription,
          detail: subscription
            ? 'The separate AgentGate Claude profile uses Claude subscription login.'
            : `Sign in with your Claude subscription using the native Claude Code login, with CLAUDE_CONFIG_DIR set to ${claudeConfigDirectory(this.home)}. AgentGate never copies credentials or falls back to API billing.`,
        });
      } catch (error) {
        uncertain = hasUncertainTermination(error);
        if (uncertain) throw error;
        signal?.throwIfAborted();
        checks.push({ name: 'claude-prerequisites', ok: false, detail: diagnostic(error) });
      }
      return checks;
    } finally {
      if (!uncertain) await scratch.cleanup();
    }
  }

  async run<S extends AgentStage>(
    stage: S,
    context: AgentContext,
    signal?: AbortSignal,
  ): Promise<AgentResultMap[S]> {
    if (stage !== 'plan' && (!context.run.plan || !context.run.planApproval))
      throw new Error('An approved plan is required for implementation and review.');
    if (signal?.aborted) throw new Error('Agent stage cancelled.');
    const checks = await this.doctor(signal);
    signal?.throwIfAborted();
    const blocked = checks.filter((check) => !check.ok);
    if (blocked.length)
      throw new Error(
        `Claude Code execution blocked: ${blocked.map((check) => `${check.name}: ${check.detail}`).join(' ')}`,
      );
    const worktree = await realpath(resolve(context.run.worktree));
    if (!(await lstat(worktree)).isDirectory())
      throw new Error('The run worktree must be a directory.');
    const scratch = await this.scratch();
    let failed = false;
    let uncertain = false;
    try {
      signal?.throwIfAborted();
      const schema = JSON.stringify(z.toJSONSchema(STAGE_SCHEMA[stage]));
      const result = await this.executor({
        command: this.claudePath,
        args: claudeArguments(stage, schema, this.modelOptions),
        cwd: worktree,
        env: scratch.env,
        input: buildAgentPrompt(stage, context),
        timeoutMs: 30 * 60_000,
        maxOutputBytes: 4 * 1024 * 1024,
        signal,
      });
      if (result.exitCode !== 0)
        throw new Error(
          `Claude Code ${stage} exited with code ${result.exitCode}; raw model output was discarded.`,
        );
      return parseClaudeOutput(stage, result.stdout);
    } catch (error) {
      failed = true;
      uncertain = hasUncertainTermination(error);
      throw error;
    } finally {
      if (!uncertain) await cleanupPreservingError(() => scratch.cleanup(), failed);
    }
  }

  /** A private temporary directory per invocation; the config directory is never inside it. */
  private async scratch() {
    const runtime = join(this.home, 'runtime');
    for (const owned of [this.home, runtime, claudeConfigDirectory(this.home)]) {
      await mkdir(owned, { recursive: true, mode: 0o700 });
      if (process.platform !== 'win32') await chmod(owned, 0o700);
    }
    const directory = await mkdtemp(join(runtime, 'claude-'));
    const temporary = join(directory, 'tmp');
    await mkdir(temporary, { mode: 0o700 });
    return {
      directory,
      env: claudeEnvironment(this.home, temporary),
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  }
}
