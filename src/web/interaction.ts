import { randomUUID } from 'node:crypto';
import type { Run, UserInteraction } from '../core/contracts.ts';
import { buildPullRequestDraft } from '../core/publication.ts';
import { approvalFingerprint, cleanTerminal, scrubForStorage } from '../core/safety.ts';
import { PromptReplySchema, WebError, type PendingPrompt, type PromptReply } from './contracts.ts';

/** Return detached, scrubbed display data without exposing a live workflow object. */
export function browserCopy<T>(value: T): T {
  function clean(item: unknown): unknown {
    if (typeof item === 'string') return cleanTerminal(item);
    if (Array.isArray(item)) return item.map(clean);
    if (item !== null && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, clean(child)]));
    }
    return item;
  }
  return clean(scrubForStorage(value)) as T;
}

interface PendingAnswer {
  prompt: PendingPrompt;
  resolve: (reply: PromptReply) => void;
  reject: (error: unknown) => void;
}

interface InteractionOptions {
  operationId: string;
  signal: AbortSignal;
  onPrompt: (prompt: PendingPrompt) => void;
  onMessage: (text: string) => void;
}

export class BrowserInteraction implements UserInteraction {
  private pending: PendingAnswer | undefined;
  private publication: { commit: string; diff: string } | undefined;
  private readonly options: InteractionOptions;

  constructor(options: InteractionOptions) {
    this.options = options;
  }

  get prompt(): PendingPrompt | null {
    return this.pending ? structuredClone(this.pending.prompt) : null;
  }

  show(text: string): void {
    this.options.onMessage(cleanTerminal(text));
  }

  async approvePlan(run: Run): Promise<'approve' | 'reject' | { feedback: string }> {
    const reply = await this.ask({ kind: 'plan', run, binding: approvalFingerprint(run) });
    return reply.choice === 'feedback' ? { feedback: reply.feedback! } : reply.choice;
  }

  async prepared(run: Run): Promise<boolean> {
    const reply = await this.ask({ kind: 'prepared', run, binding: approvalFingerprint(run) });
    return reply.choice === 'approve';
  }

  async approvePublication(run: Run, diff: string): Promise<boolean> {
    this.publication = browserCopy({ commit: candidateCommit(run), diff });
    const reply = await this.ask({
      kind: 'publication',
      run,
      binding: candidateCommit(run),
      diff,
      proposal: buildPullRequestDraft(run),
    });
    return reply.choice === 'approve';
  }

  async approveOrdinaryPr(run: Run): Promise<boolean> {
    const commit = candidateCommit(run);
    const reply = await this.ask({
      kind: 'ordinary-pr',
      run,
      binding: commit,
      ...(this.publication?.commit === commit ? { diff: this.publication.diff } : {}),
      proposal: buildPullRequestDraft(run),
    });
    return reply.choice === 'approve';
  }

  respond(id: string, input: PromptReply): void {
    const reply = PromptReplySchema.parse(input);
    const pending = this.pending;
    if (!pending || pending.prompt.id !== id) {
      throw new WebError(409, 'This confirmation is no longer pending. Refresh the run.');
    }
    if (reply.binding !== pending.prompt.binding) {
      throw new WebError(409, 'The plan or commit does not match this confirmation.');
    }
    if (reply.choice === 'feedback' && pending.prompt.kind !== 'plan') {
      throw new WebError(400, 'Only a plan confirmation accepts feedback.');
    }
    // Consume before resuming the workflow so a second request cannot reuse the approval.
    this.pending = undefined;
    pending.resolve(reply);
  }

  close(): void {
    const pending = this.pending;
    this.pending = undefined;
    this.publication = undefined;
    pending?.reject(new Error('The operation ended before this confirmation was answered.'));
  }

  private ask(input: Omit<PendingPrompt, 'id' | 'operationId'>): Promise<PromptReply> {
    const { signal, operationId, onPrompt } = this.options;
    signal.throwIfAborted();
    if (this.pending) throw new Error('An operation cannot wait for two confirmations.');
    const prompt = browserCopy({ ...input, id: randomUUID(), operationId });
    return new Promise<PromptReply>((resolve, reject) => {
      const finish = () => signal.removeEventListener('abort', abort);
      const abort = () => {
        if (this.pending?.prompt.id === prompt.id) this.pending = undefined;
        finish();
        reject(signal.reason ?? new Error('Cancelled by the user.'));
      };
      this.pending = {
        prompt,
        resolve: (reply) => {
          finish();
          resolve(reply);
        },
        reject: (error) => {
          finish();
          reject(error);
        },
      };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      try {
        onPrompt(structuredClone(prompt));
      } catch (error) {
        this.pending = undefined;
        finish();
        reject(error);
      }
    });
  }
}

function candidateCommit(run: Run): string {
  if (!run.candidateCommit) throw new Error('No exact candidate commit is available.');
  return run.candidateCommit;
}
