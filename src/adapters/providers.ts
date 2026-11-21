import { z } from 'zod';
import type { AgentRunner } from '../core/contracts.ts';
import { ModelOptionsSchema } from './agent-prompt.ts';
import { ClaudeRunner } from './claude.ts';
import { CodexRunner } from './codex.ts';

export const ProviderSchema = z.enum(['codex', 'claude']);
export type Provider = z.infer<typeof ProviderSchema>;

export const ProviderSelectionShape = {
  provider: ProviderSchema.optional(),
  acceptClaudePermissionBoundary: z.boolean().optional(),
};

/** Claude requires an explicit boundary acceptance; Codex never takes one. */
export function checkProviderSelection(
  value: { provider?: Provider; acceptClaudePermissionBoundary?: boolean },
  context: z.RefinementCtx,
): void {
  const claude = value.provider === 'claude';
  if (claude && value.acceptClaudePermissionBoundary !== true)
    context.addIssue({
      code: 'custom',
      path: ['acceptClaudePermissionBoundary'],
      message:
        'The Claude provider runs without OS-level isolation for its file tools; accept its permission boundary explicitly.',
    });
  if (!claude && value.acceptClaudePermissionBoundary !== undefined)
    context.addIssue({
      code: 'custom',
      path: ['acceptClaudePermissionBoundary'],
      message: 'The Claude permission-boundary acceptance applies only to the Claude provider.',
    });
}

export const AgentSelectionSchema = ModelOptionsSchema.extend(ProviderSelectionShape)
  .strict()
  .superRefine(checkProviderSelection);
export type AgentSelection = z.infer<typeof AgentSelectionSchema>;

export interface ProviderPaths {
  home: string;
  codexPath?: string;
  claudePath?: string;
}

export function createAgentRunner(paths: ProviderPaths, input: AgentSelection): AgentRunner {
  const { provider, acceptClaudePermissionBoundary, ...model } = AgentSelectionSchema.parse(input);
  return provider === 'claude'
    ? new ClaudeRunner({
        home: paths.home,
        claudePath: paths.claudePath,
        acceptPermissionBoundary: acceptClaudePermissionBoundary,
        ...model,
      })
    : new CodexRunner({ home: paths.home, codexPath: paths.codexPath, ...model });
}
