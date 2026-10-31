import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AgentRunner, GitHubGateway, Run, SandboxRunner } from '../core/contracts.ts';
import { hasUncertainTermination } from '../core/errors.ts';
import { cleanTerminal } from '../core/safety.ts';
import { FileRunStore } from '../core/store.ts';
import { Workflow } from '../core/workflow.ts';
import {
  ResumeRequestSchema,
  StartRequestSchema,
  WebError,
  type CodexModelOptions,
  type PendingPrompt,
  type PromptReply,
  type ResumeRequest,
  type RunSummary,
  type StartRequest,
  type WebOperation,
  type WebState,
} from './contracts.ts';
import { BrowserInteraction, browserCopy } from './interaction.ts';

export interface WebControllerOptions {
  store: FileRunStore;
  git: GitHubGateway;
  sandbox: SandboxRunner;
  createAgent: (options: CodexModelOptions) => AgentRunner;
}

interface Reservation {
  abort: AbortController;
  completion: Promise<void>;
}

interface ActiveOperation extends Reservation {
  operation: WebOperation;
  ui: BrowserInteraction;
}

interface RequestRecord {
  signature: string;
  operationId: string;
}

export class WebController {
  private readonly options: WebControllerOptions;
  private readonly operations = new Map<string, WebOperation>();
  private readonly requests = new Map<string, RequestRecord>();
  private readonly publicationDiffs = new Map<string, { commit: string; diff: string }>();
  private reservation: Reservation | undefined;
  private active: ActiveOperation | undefined;
  private latest: WebOperation | undefined;
  private messages: string[] = [];
  private closing = false;

  constructor(options: WebControllerOptions) {
    this.options = options;
  }

  async state(): Promise<WebState> {
    const [repos, runs] = await Promise.all([
      this.options.store.listRepos(),
      this.options.store.listRuns(),
    ]);
    return browserCopy({
      repos,
      runs: runs.map(summarizeRun),
      operation: this.latest ?? null,
      prompt: this.active?.ui.prompt ?? null,
      busy: this.reservation !== undefined,
      messages: this.messages,
    });
  }

  async getRun(id: string): Promise<{ run: Run; diff?: string }> {
    const run = await this.options.store.getRun(identifier(id));
    const cached = this.publicationDiffs.get(run.id);
    return browserCopy({
      run,
      ...(cached && cached.commit === run.candidateCommit ? { diff: cached.diff } : {}),
    });
  }

  getOperation(id: string): WebOperation {
    const operation = this.operations.get(identifier(id));
    if (!operation) throw new WebError(404, 'Operation not found in this server session.');
    return browserCopy(operation);
  }

  start(input: StartRequest): WebOperation {
    const request = StartRequestSchema.parse(input);
    return this.begin('start', request);
  }

  resume(id: string, input: ResumeRequest): WebOperation {
    const request = ResumeRequestSchema.parse(input);
    return this.begin('resume', request, identifier(id));
  }

  cancel(id: string): void {
    const operationId = identifier(id);
    const active = this.active;
    if (!active || active.operation.id !== operationId) {
      throw new WebError(409, 'This operation is no longer running in this server.');
    }
    active.operation.status = 'cancelling';
    active.abort.abort(new Error('Cancelled by the user.'));
  }

  respond(promptId: string, reply: PromptReply): void {
    if (!this.active) throw new WebError(409, 'There is no pending confirmation.');
    this.active.ui.respond(identifier(promptId), reply);
  }

  async inspect(id: string): Promise<{ diff: string }> {
    const runId = identifier(id);
    this.assertAvailable();
    const reservation: Reservation = {
      abort: new AbortController(),
      completion: Promise.resolve(),
    };
    // Inspection stages files, so it participates in the same synchronous reservation.
    this.reservation = reservation;
    const inspection = this.inspectUnderLock(runId, reservation.abort.signal).finally(() => {
      if (this.reservation === reservation) this.reservation = undefined;
    });
    reservation.completion = inspection.then(
      () => undefined,
      () => undefined,
    );
    return inspection;
  }

  async close(): Promise<void> {
    this.closing = true;
    const reservation = this.reservation;
    if (this.active) this.active.operation.status = 'cancelling';
    reservation?.abort.abort(new Error('The local web server is shutting down.'));
    await reservation?.completion;
  }

  private begin(
    kind: WebOperation['kind'],
    request: StartRequest | ResumeRequest,
    runId?: string,
  ): WebOperation {
    if (this.closing) throw new WebError(503, 'The local web server is shutting down.');
    const signature = JSON.stringify({ kind, runId, ...request });
    const previous = this.requests.get(request.requestId);
    if (previous) {
      if (previous.signature !== signature) {
        throw new WebError(409, 'This request identifier was already used with different inputs.');
      }
      return this.getOperation(previous.operationId);
    }
    this.assertAvailable();
    const operation: WebOperation = {
      id: randomUUID(),
      kind,
      requestId: request.requestId,
      status: 'running',
      ...(runId ? { runId } : {}),
    };
    const abort = new AbortController();
    const ui = new BrowserInteraction({
      operationId: operation.id,
      signal: abort.signal,
      onPrompt: (prompt) => this.capturePrompt(operation, prompt),
      onMessage: (text) => this.recordMessage(text),
    });
    const active: ActiveOperation = {
      operation,
      abort,
      ui,
      completion: Promise.resolve(),
    };
    this.reservation = active;
    this.active = active;
    this.latest = operation;
    this.messages = [];
    if (runId) this.publicationDiffs.delete(runId);
    this.operations.set(operation.id, operation);
    this.requests.set(request.requestId, { signature, operationId: operation.id });
    active.completion = Promise.resolve().then(() => this.execute(active, request, runId));
    return browserCopy(operation);
  }

  private async execute(
    active: ActiveOperation,
    request: StartRequest | ResumeRequest,
    runId?: string,
  ): Promise<void> {
    const { operation, abort, ui } = active;
    try {
      abort.signal.throwIfAborted();
      const workflow = new Workflow({
        store: this.options.store,
        git: this.options.git,
        sandbox: this.options.sandbox,
        agent: this.options.createAgent({
          model: request.model,
          reasoningEffort: request.reasoningEffort,
        }),
        ui,
      });
      const run =
        operation.kind === 'resume'
          ? await workflow.resume(runId!, abort.signal)
          : await workflow.start(
              (request as StartRequest).repo,
              (request as StartRequest).issueUrl,
              abort.signal,
            );
      operation.runId = run.id;
      operation.resultStatus = run.status;
      operation.status = 'completed';
    } catch (error) {
      operation.status = 'failed';
      operation.error = errorMessage(error);
    } finally {
      ui.close();
      if (this.active === active) this.active = undefined;
      if (this.reservation === active) this.reservation = undefined;
    }
  }

  private capturePrompt(operation: WebOperation, prompt: PendingPrompt): void {
    operation.runId = prompt.run.id;
    if (prompt.kind === 'publication' && prompt.diff !== undefined) {
      this.publicationDiffs.set(prompt.run.id, { commit: prompt.binding, diff: prompt.diff });
    }
  }

  private recordMessage(text: string): void {
    const safe = cleanTerminal(text);
    this.messages.push(safe.length > 8_192 ? `${safe.slice(0, 8_192)}\n[Message truncated]` : safe);
    if (this.messages.length > 100) this.messages.shift();
  }

  private assertAvailable(): void {
    if (this.closing) throw new WebError(503, 'The local web server is shutting down.');
    if (this.reservation) throw new WebError(409, 'Another operation is already running.');
  }

  private async inspectUnderLock(id: string, signal: AbortSignal): Promise<{ diff: string }> {
    signal.throwIfAborted();
    const release = await this.options.store.acquireLock();
    let retain = false;
    try {
      signal.throwIfAborted();
      const run = await this.options.store.getRun(id);
      await this.options.git.snapshot(run.worktree, signal);
      return browserCopy({
        diff: await this.options.git.diff(run.worktree, run.baseCommit, signal),
      });
    } catch (error) {
      retain = hasUncertainTermination(error);
      if (retain) {
        throw new Error(
          'Process shutdown could not be verified. The run lock is retained; follow the documented stale-lock recovery before another execution.',
          { cause: error },
        );
      }
      throw error;
    } finally {
      if (!retain) await release();
    }
  }
}

function identifier(value: string): string {
  return z.string().uuid().parse(value).toLowerCase();
}

function errorMessage(error: unknown): string {
  return cleanTerminal(error instanceof Error ? error.message : 'Unknown execution error');
}

function summarizeRun(run: Run): RunSummary {
  return {
    id: run.id,
    repo: { name: run.repo.name, fullName: run.repo.fullName },
    issue: { number: run.issue.number, title: run.issue.title, url: run.issue.url },
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    message: run.message,
    prUrl: run.prUrl,
  };
}
