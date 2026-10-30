import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type { Run, UserInteraction } from '../core/contracts.ts';
import { cleanTerminal, redact } from '../core/safety.ts';
import { buildPullRequestDraft } from '../core/publication.ts';

export class TerminalInteraction implements UserInteraction {
  private readonly reader = createInterface({ input: stdin, output: stdout });
  private readonly signal?: AbortSignal;

  constructor(signal?: AbortSignal) {
    this.signal = signal;
  }

  show(text: string): void {
    stdout.write(`${cleanTerminal(redact(text))}\n`);
  }

  async confirm(question: string): Promise<boolean> {
    const answer = await this.reader.question(`${cleanTerminal(question)} [y/N] `, {
      signal: this.signal,
    });
    return ['y', 'yes'].includes(answer.trim().toLowerCase());
  }

  async approvePlan(run: Run): Promise<'approve' | 'reject' | { feedback: string }> {
    this.show(
      `Repository: ${run.repo.fullName}\nIssue: ${run.issue.url}\nBase: ${run.baseCommit}\nWorktree: ${run.worktree}`,
    );
    this.show(
      `Plan:\n${JSON.stringify(run.plan, null, 2)}\nMandatory checks:\n${JSON.stringify(run.repo.checks, null, 2)}`,
    );
    const answer = await this.reader.question(
      'Type approve, reject, or feedback to revise the plan: ',
      { signal: this.signal },
    );
    if (answer.trim().toLowerCase() === 'approve') return 'approve';
    if (!answer.trim() || answer.trim().toLowerCase() === 'reject') return 'reject';
    return { feedback: answer.trim() };
  }

  async prepared(run: Run): Promise<boolean> {
    this.show(
      `Prepare dependencies yourself in:\n${run.worktree}\nFor an npm project with a lockfile, review the project and run npm ci there. Agent/check commands will have no network access. Do not copy production secrets into this worktree.`,
    );
    return this.confirm('Are the dependencies ready and the approved checks able to run offline?');
  }

  async approvePublication(run: Run, diff: string): Promise<boolean> {
    const proposal = buildPullRequestDraft(run);
    this.show(`Diff against ${run.baseCommit}:\n${diff}`);
    for (const check of run.checks)
      this.show(`${check.name}: exit ${check.exitCode}\n${check.output}`);
    this.show(
      `Review:\n${JSON.stringify(run.review, null, 2)}\nLatest agent-stage report: ${run.implementationSummary ?? ''}\nRepository: ${run.repo.fullName}\nBranch: ${run.branch}\nCommit: ${run.candidateCommit}\nIssue: ${run.issue.url}`,
    );
    this.show(`Pull request title:\n${proposal.title}\n\nPull request body:\n${proposal.body}`);
    return this.confirm('Push this exact commit and create a draft pull request?');
  }

  async approveOrdinaryPr(run: Run): Promise<boolean> {
    const proposal = buildPullRequestDraft(run);
    this.show(
      `GitHub cannot create a draft PR here. The approved branch may already be pushed.\nCommit: ${run.candidateCommit}`,
    );
    this.show(`Pull request title:\n${proposal.title}\n\nPull request body:\n${proposal.body}`);
    return this.confirm('Create an ordinary (ready-for-review) PR for this exact commit instead?');
  }

  close(): void {
    this.reader.close();
  }
}
