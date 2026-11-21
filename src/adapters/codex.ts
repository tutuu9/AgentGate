import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type {
  AgentContext,
  AgentResultMap,
  AgentRunner,
  AgentStage,
  SandboxRunner,
} from '../core/contracts.ts';
import { hasUncertainTermination } from '../core/errors.ts';
import {
  buildAgentPrompt,
  ModelOptionsSchema,
  STAGE_SCHEMA,
  type ModelOptions,
} from './agent-prompt.ts';
import { execute, type Executor } from './process.ts';
import {
  CodexSandbox,
  createSandboxSession,
  cleanupPreservingError,
  executeSandbox,
  type CodexOptions,
} from './sandbox.ts';

export const CodexModelOptionsSchema = ModelOptionsSchema;
export { buildAgentPrompt };

interface RunnerOptions extends CodexOptions, ModelOptions {
  /** Tests may supply a fake doctor; this is never evidence of real isolation. */
  sandbox?: Pick<SandboxRunner, 'doctor'>;
}

/** Keep only the final structured agent message, never persist raw JSONL or reasoning. */
export function parseAgentOutput<S extends AgentStage>(
  stage: S,
  output: string,
): AgentResultMap[S] {
  let completed = false;
  let finalText: string | undefined;
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      throw new Error('Codex returned malformed JSONL; no result was accepted.');
    }
    if (!event || typeof event !== 'object' || !('type' in event) || typeof event.type !== 'string')
      throw new Error('Codex returned an invalid event envelope.');
    if (event.type === 'turn.failed' || event.type === 'error')
      throw new Error('Codex reported a failed turn; its raw transcript was discarded.');
    if (event.type === 'turn.completed') completed = true;
    if (event.type === 'item.completed' && 'item' in event) {
      const item = event.item;
      if (
        item &&
        typeof item === 'object' &&
        'type' in item &&
        item.type === 'agent_message' &&
        'text' in item &&
        typeof item.text === 'string'
      )
        finalText = item.text;
    }
  }
  if (!completed || !finalText)
    throw new Error('Codex did not complete with a structured final response.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(finalText);
  } catch {
    throw new Error('Codex final response was not valid JSON.');
  }
  const result = STAGE_SCHEMA[stage].safeParse(parsed);
  if (!result.success)
    throw new Error(`Codex ${stage} response did not satisfy the agreed schema.`);
  return result.data as AgentResultMap[S];
}

export class CodexRunner implements AgentRunner {
  private readonly home: string;
  private readonly codexPath: string;
  private readonly executor: Executor;
  private readonly sandbox: Pick<SandboxRunner, 'doctor'>;
  private readonly modelArgs: string[];

  constructor(options: RunnerOptions) {
    const { model, reasoningEffort } = CodexModelOptionsSchema.parse(options);
    this.home = resolve(options.home);
    this.codexPath = options.codexPath ?? 'codex';
    this.executor = options.executor ?? execute;
    this.sandbox = options.sandbox ?? new CodexSandbox(options);
    this.modelArgs = [
      ...(model ? ['--model', model] : []),
      ...(reasoningEffort
        ? ['-c', `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`]
        : []),
    ];
  }

  async run<S extends AgentStage>(
    stage: S,
    context: AgentContext,
    signal?: AbortSignal,
  ): Promise<AgentResultMap[S]> {
    if (stage !== 'plan' && (!context.run.plan || !context.run.planApproval))
      throw new Error('An approved plan is required for implementation and review.');
    if (signal?.aborted) throw new Error('Agent stage cancelled.');
    const checks = await this.sandbox.doctor(signal);
    signal?.throwIfAborted();
    if (!checks.length || checks.some((check) => !check.ok))
      throw new Error(
        `Codex execution blocked: ${
          checks
            .filter((check) => !check.ok)
            .map((check) => `${check.name}: ${check.detail}`)
            .join(' ') || 'No isolation evidence.'
        }`,
      );
    const session = await createSandboxSession(
      this.home,
      context.run.worktree,
      stage === 'implement',
      this.codexPath,
    );
    let failed = false;
    let uncertain = false;
    try {
      signal?.throwIfAborted();
      const schemaPath = join(session.launcher, 'response.schema.json');
      await writeFile(schemaPath, JSON.stringify(z.toJSONSchema(STAGE_SCHEMA[stage])), {
        mode: 0o600,
      });
      // A custom permission profile enforces stricter reads than the broad legacy sandbox flag.
      // Do not pass --sandbox alongside it: that would select a different permission policy.
      const result = await executeSandbox(
        {
          command: session.codexExecutable ?? this.codexPath,
          args: [
            ...session.configArgs,
            '-a',
            'never',
            'exec',
            ...this.modelArgs,
            '--ignore-user-config',
            '--ignore-rules',
            '--strict-config',
            '--skip-git-repo-check',
            '--ephemeral',
            '--json',
            '--color',
            'never',
            '--output-schema',
            schemaPath,
            '-C',
            session.launcher,
            '-',
          ],
          cwd: session.launcher,
          env: session.env,
          input: buildAgentPrompt(stage, context),
          timeoutMs: 30 * 60_000,
          maxOutputBytes: 4 * 1024 * 1024,
          signal,
        },
        this.executor,
      );
      if (result.exitCode !== 0)
        throw new Error(
          `Codex ${stage} exited with code ${result.exitCode}; raw model output was discarded.`,
        );
      return parseAgentOutput(stage, result.stdout);
    } catch (error) {
      failed = true;
      uncertain = hasUncertainTermination(error);
      throw error;
    } finally {
      if (!uncertain) await cleanupPreservingError(() => session.cleanup(), failed);
    }
  }
}
