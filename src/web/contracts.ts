import { z } from 'zod';
import { ModelOptionsSchema } from '../adapters/agent-prompt.ts';
import { checkProviderSelection, ProviderSelectionShape } from '../adapters/providers.ts';
import { RepoSchema, type RepoProfile, type Run } from '../core/contracts.ts';
import type { PullRequestDraft } from '../core/publication.ts';

const ResumeRequestShape = ModelOptionsSchema.extend(ProviderSelectionShape).extend({
  requestId: z.string().uuid(),
});
export const ResumeRequestSchema = ResumeRequestShape.strict().superRefine(checkProviderSelection);
export const StartRequestSchema = ResumeRequestShape.extend({
  repo: RepoSchema.shape.name,
  issueUrl: z.string().url().max(2_048),
})
  .strict()
  .superRefine(checkProviderSelection);
export const PromptReplySchema = z
  .object({
    binding: z.string().min(1).max(256),
    choice: z.enum(['approve', 'reject', 'feedback']),
    feedback: z.string().trim().min(1).max(16_384).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.choice === 'feedback') !== (value.feedback !== undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['feedback'],
        message: 'Feedback is required only for a feedback response.',
      });
    }
  });

export type StartRequest = z.infer<typeof StartRequestSchema>;
export type ResumeRequest = z.infer<typeof ResumeRequestSchema>;
export type PromptReply = z.infer<typeof PromptReplySchema>;

export interface WebOperation {
  id: string;
  kind: 'start' | 'resume';
  requestId: string;
  status: 'running' | 'completed' | 'failed' | 'cancelling';
  runId?: string;
  error?: string;
  resultStatus?: Run['status'];
}

export interface PendingPrompt {
  id: string;
  operationId: string;
  kind: 'plan' | 'prepared' | 'publication' | 'ordinary-pr';
  run: Run;
  binding: string;
  diff?: string;
  proposal?: PullRequestDraft;
}

export interface RunSummary {
  id: string;
  repo: Pick<RepoProfile, 'name' | 'fullName'>;
  issue: Pick<Run['issue'], 'number' | 'title' | 'url'>;
  status: Run['status'];
  createdAt: string;
  updatedAt: string;
  message?: string;
  prUrl?: string;
}

export interface WebState {
  repos: RepoProfile[];
  runs: RunSummary[];
  operation: WebOperation | null;
  prompt: PendingPrompt | null;
  busy: boolean;
  messages: string[];
}

export class WebError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'WebError';
    this.status = status;
  }
}
