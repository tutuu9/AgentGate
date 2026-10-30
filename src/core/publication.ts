import type { Run } from './contracts.ts';
import { cleanTerminal } from './safety.ts';

export interface PullRequestDraft {
  title: string;
  body: string;
}

/** Produce the same scrubbed text for human approval and GitHub publication. */
export function buildPullRequestDraft(run: Run): PullRequestDraft {
  const body = [
    `Closes #${run.issue.number}`,
    run.plan?.objective ?? run.implementationSummary ?? 'AgentGate changes',
    'Validation:',
    ...run.checks.map((check) => `- ${check.name}: ${check.exitCode === 0 ? 'passed' : 'failed'}`),
    `Review: ${run.review?.summary ?? 'See local run evidence.'}`,
    `AgentGate run: ${run.id}`,
  ].join('\n\n');
  return { title: cleanTerminal(run.issue.title), body: cleanTerminal(body) };
}
