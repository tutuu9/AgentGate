import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ImplementationSchema, PlanSchema, ReviewSchema, RunSchema } from './contracts.ts';
import type {
  AgentRunner,
  GitHubGateway,
  Run,
  SandboxRunner,
  UserInteraction,
} from './contracts.ts';
import { FileRunStore } from './store.ts';
import { approvalFingerprint, assertWithinScope, redact } from './safety.ts';
import { hasUncertainTermination } from './errors.ts';

const ACTIVE_LIMIT_MS = 60 * 60 * 1000;

export class WorkflowBlocked extends Error {}

export interface WorkflowOptions {
  store: FileRunStore;
  agent: AgentRunner;
  sandbox: SandboxRunner;
  git: GitHubGateway;
  ui: UserInteraction;
  activeLimitMs?: number;
}

export class Workflow {
  private readonly options: WorkflowOptions;

  constructor(options: WorkflowOptions) {
    this.options = options;
  }

  async start(repoName: string, issueUrl: string, signal?: AbortSignal): Promise<Run> {
    signal?.throwIfAborted();
    const { store, git } = this.options;
    await store.init();
    const release = await store.acquireLock();
    let run: Run | undefined;
    let retainLock = false;
    try {
      await this.preflight(signal);
      const repo = await store.getRepo(repoName);
      await this.assertSeparateStorage(repo.path);
      const issue = await git.issue(issueUrl, repo, signal);
      const baseCommit = await git.baseCommit(repo, signal);
      const id = randomUUID();
      run = RunSchema.parse({
        schemaVersion: 1,
        id,
        repo,
        issue: { ...issue, title: redact(issue.title), body: redact(issue.body) },
        baseCommit,
        branch: `agentgate/issue-${issue.number}-${id}`,
        worktree: join(store.home, 'worktrees', id),
        status: 'planning',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      await store.saveRun(run);
      await git.createWorktree(repo, run.worktree, run.branch, baseCommit, signal);
      return await this.advance(run, signal);
    } catch (error) {
      retainLock = hasUncertainTermination(error);
      if (!run) throw error;
      return await this.stop(run, error, signal);
    } finally {
      if (!retainLock) await release();
    }
  }

  async resume(id: string, signal?: AbortSignal): Promise<Run> {
    signal?.throwIfAborted();
    const { store, git } = this.options;
    await store.init();
    const release = await store.acquireLock();
    let retainLock = false;
    const run = await store.getRun(id).catch(async (error: unknown) => {
      await release();
      throw error;
    });
    try {
      if (run.status === 'completed') return run;
      if (run.activeStartedAt !== undefined) {
        const elapsed = Date.now() - run.activeStartedAt;
        run.activeMs += elapsed >= 0 ? elapsed : (this.options.activeLimitMs ?? ACTIVE_LIMIT_MS);
        delete run.activeStartedAt;
        await store.saveRun(run);
      }
      if (run.activeMs >= (this.options.activeLimitMs ?? ACTIVE_LIMIT_MS)) {
        throw new WorkflowBlocked(
          'The active execution budget is exhausted. Start a new explicitly scoped run.',
        );
      }
      await this.preflight(signal);
      const currentRepo = await store.getRepo(run.repo.name);
      if (
        resolve(currentRepo.path) !== resolve(run.repo.path) ||
        currentRepo.fullName !== run.repo.fullName ||
        currentRepo.baseBranch !== run.repo.baseBranch
      ) {
        throw new WorkflowBlocked('Repository identity or base branch changed. Start a new run.');
      }
      await this.assertSeparateStorage(currentRepo.path);
      if (JSON.stringify(currentRepo.checks) !== JSON.stringify(run.repo.checks)) {
        run.repo = currentRepo;
        this.revokePlan(run);
      }
      await git.createWorktree(run.repo, run.worktree, run.branch, run.baseCommit, signal);
      if (run.checkedTree && (await git.snapshot(run.worktree, signal)) !== run.checkedTree) {
        this.revokeResult(run);
        run.checkpoint = 'check';
      }
      return await this.advance(run, signal);
    } catch (error) {
      retainLock = hasUncertainTermination(error);
      return await this.stop(run, error, signal);
    } finally {
      if (!retainLock) await release();
    }
  }

  private async assertSeparateStorage(repoPath: string): Promise<void> {
    const [repo, home] = await Promise.all([realpath(repoPath), realpath(this.options.store.home)]);
    if (isWithin(repo, home) || isWithin(home, repo)) {
      throw new WorkflowBlocked('State and target repositories must be in separate directories.');
    }
  }

  private async preflight(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const checks = await this.options.sandbox.doctor(signal);
    signal?.throwIfAborted();
    if (!checks.length) throw new WorkflowBlocked('No sandbox isolation evidence was returned.');
    const failed = checks.filter((check) => !check.ok);
    if (failed.length)
      throw new WorkflowBlocked(failed.map((check) => `${check.name}: ${check.detail}`).join('\n'));
  }

  private async advance(run: Run, signal?: AbortSignal): Promise<Run> {
    signal?.throwIfAborted();
    const { agent, ui } = this.options;
    if (!run.plan) {
      await this.transition(run, 'planning');
      run.plan = PlanSchema.parse(
        await this.active(run, (stageSignal) => agent.run('plan', { run }, stageSignal), signal),
      );
    }
    while (run.planApproval !== approvalFingerprint(run)) {
      await this.transition(run, 'awaiting_plan');
      const choice = await ui.approvePlan(run);
      signal?.throwIfAborted();
      if (choice === 'reject') {
        await this.transition(run, 'cancelled', 'Plan rejected; worktree preserved.');
        return run;
      }
      if (choice !== 'approve') {
        run.plan = PlanSchema.parse(
          await this.active(
            run,
            (stageSignal) => agent.run('plan', { run, feedback: choice.feedback }, stageSignal),
            signal,
          ),
        );
        this.revokePlan(run);
        continue;
      }
      run.planApproval = approvalFingerprint(run);
      run.checkpoint = 'prepare';
      await this.options.store.saveRun(run);
    }
    if (run.checkpoint === 'plan' || run.checkpoint === 'prepare') {
      await this.transition(run, 'preparing');
      const prepared = await ui.prepared(run);
      signal?.throwIfAborted();
      if (!prepared) return run;
      run.checkpoint = 'implement';
    }
    if (run.checkpoint === 'implement') await this.implement(run, run.repairFeedback, signal);
    while (run.checkpoint === 'check' || run.checkpoint === 'review') {
      if (run.checkpoint === 'check') {
        const failure = await this.check(run, signal);
        if (failure) {
          await this.repair(run, failure, signal);
          continue;
        }
      }
      const failure = await this.review(run, signal);
      if (failure) {
        await this.repair(run, failure, signal);
        continue;
      }
      run.checkpoint = 'publish';
    }
    if (run.checkpoint === 'publish') await this.publish(run, signal);
    return run;
  }

  private async implement(
    run: Run,
    feedback: string | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    this.assertApproved(run);
    await this.transition(run, 'implementing');
    const result = ImplementationSchema.parse(
      await this.active(
        run,
        (stageSignal) => this.options.agent.run('implement', { run, feedback }, stageSignal),
        signal,
      ),
    );
    run.implementationSummary = result.summary;
    await this.scope(run, signal);
    delete run.repairFeedback;
    run.checkpoint = 'check';
    this.revokeResult(run);
    await this.options.store.saveRun(run);
  }

  private async check(run: Run, signal?: AbortSignal): Promise<string | undefined> {
    this.assertApproved(run);
    await this.scope(run, signal);
    await this.transition(run, 'checking');
    const tree = await this.options.git.snapshot(run.worktree, signal);
    run.checks = [];
    for (const spec of run.repo.checks) {
      this.options.ui.show(`Checking ${spec.name}...`);
      const result = await this.active(
        run,
        (stageSignal) => this.options.sandbox.check(spec, run.worktree, stageSignal),
        signal,
      );
      run.checks.push({ ...result, output: redact(result.output) });
      await this.options.store.saveRun(run);
    }
    if ((await this.options.git.snapshot(run.worktree, signal)) !== tree) {
      this.revokeResult(run);
      throw new WorkflowBlocked(
        'Checks changed source files. Inspect the changes and resume to recheck them.',
      );
    }
    const failed = run.checks.filter((check) => check.exitCode !== 0);
    if (failed.length)
      return failed
        .map((check) => `${check.name} failed (${check.exitCode}):\n${check.output}`)
        .join('\n');
    run.checkedTree = tree;
    run.checkpoint = 'review';
    await this.options.store.saveRun(run);
    return undefined;
  }

  private async review(run: Run, signal?: AbortSignal): Promise<string | undefined> {
    await this.assertCurrentTree(run, signal);
    await this.transition(run, 'reviewing');
    const diff = await this.options.git.diff(run.worktree, run.baseCommit, signal);
    run.review = ReviewSchema.parse(
      await this.active(
        run,
        (stageSignal) => this.options.agent.run('review', { run, diff }, stageSignal),
        signal,
      ),
    );
    await this.assertCurrentTree(run, signal);
    await this.options.store.saveRun(run);
    const blockers = run.review.findings.filter((finding) => finding.severity === 'blocking');
    return blockers.length
      ? blockers.map((finding) => `${finding.file}: ${finding.message}`).join('\n')
      : undefined;
  }

  private async repair(run: Run, feedback: string, signal?: AbortSignal): Promise<void> {
    if (run.repairAttempts >= 1)
      throw new WorkflowBlocked(`The automatic repair attempt has been used.\n${feedback}`);
    run.repairAttempts += 1;
    run.repairFeedback = redact(`Fix only these failures within the approved plan:\n${feedback}`);
    run.checkpoint = 'implement';
    await this.options.store.saveRun(run);
    await this.implement(run, run.repairFeedback, signal);
  }

  private async publish(run: Run, signal?: AbortSignal): Promise<void> {
    const { git, ui } = this.options;
    this.assertApproved(run);
    await this.scope(run, signal);
    await this.assertCurrentTree(run, signal);
    if (
      !run.review ||
      run.review.findings.some((finding) => finding.severity === 'blocking') ||
      run.checks.length !== run.repo.checks.length ||
      run.checks.some((check) => check.exitCode !== 0)
    ) {
      throw new WorkflowBlocked(
        'Successful mandatory checks and review are required before publication.',
      );
    }
    if (!run.checkedTree) throw new WorkflowBlocked('No checked tree.');
    if (!run.candidateCommit) {
      run.candidateCommit = await this.active(
        run,
        (stageSignal) =>
          git.commit(
            run.worktree,
            run.checkedTree!,
            `feat: address issue #${run.issue.number}`,
            stageSignal,
          ),
        signal,
      );
    }
    await git.verifyCommit(run.worktree, run.candidateCommit, run.checkedTree, signal);
    await this.transition(run, 'awaiting_publish');
    if (run.publicationApproval !== run.candidateCommit) {
      const diff = await git.diff(run.worktree, run.baseCommit, signal);
      const approved = await ui.approvePublication(run, diff);
      signal?.throwIfAborted();
      if (!approved) return;
      run.publicationApproval = run.candidateCommit;
      await this.options.store.saveRun(run);
    }
    await git.verifyCommit(run.worktree, run.candidateCommit, run.checkedTree, signal);
    await this.transition(run, 'publishing');
    let result = await this.active(
      run,
      (stageSignal) => git.publish(run, !run.ordinaryPrApproved, stageSignal),
      signal,
    );
    if (result.kind === 'draft-unavailable') {
      await this.transition(
        run,
        'awaiting_publish',
        'Draft PR is unavailable. The approved branch may already be pushed.',
      );
      const ordinaryApproved = await ui.approveOrdinaryPr(run);
      signal?.throwIfAborted();
      if (!ordinaryApproved) return;
      run.ordinaryPrApproved = true;
      await this.options.store.saveRun(run);
      await git.verifyCommit(run.worktree, run.candidateCommit, run.checkedTree, signal);
      await this.transition(run, 'publishing');
      result = await this.active(
        run,
        (stageSignal) => git.publish(run, false, stageSignal),
        signal,
      );
    }
    if (result.kind !== 'published') throw new WorkflowBlocked('PR creation did not complete.');
    run.prUrl = result.url;
    await this.transition(run, 'completed', `Pull request: ${result.url}`);
  }

  private async scope(run: Run, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (!run.plan) throw new WorkflowBlocked('No approved plan.');
    await this.options.git.snapshot(run.worktree, signal);
    try {
      assertWithinScope(
        await this.options.git.changes(run.worktree, run.baseCommit, signal),
        run.plan.allowedPaths,
      );
    } catch (error) {
      throw new WorkflowBlocked(
        error instanceof Error ? error.message : 'Changes exceed the approved scope.',
      );
    }
  }

  private assertApproved(run: Run): void {
    if (!run.plan || run.planApproval !== approvalFingerprint(run))
      throw new WorkflowBlocked('Plan, checks or repository changed. Approval is required again.');
  }

  private async assertCurrentTree(run: Run, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (
      !run.checkedTree ||
      (await this.options.git.snapshot(run.worktree, signal)) !== run.checkedTree
    ) {
      this.revokeResult(run);
      run.checkpoint = 'check';
      throw new WorkflowBlocked(
        'Files changed after checks. Resume to check and review the new result.',
      );
    }
  }

  private revokeResult(run: Run): void {
    delete run.checkedTree;
    delete run.candidateCommit;
    delete run.publicationApproval;
    delete run.review;
    run.checks = [];
    run.ordinaryPrApproved = false;
  }

  private revokePlan(run: Run): void {
    delete run.planApproval;
    this.revokeResult(run);
    run.checkpoint = 'prepare';
  }

  private async active<T>(
    run: Run,
    action: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const remaining = (this.options.activeLimitMs ?? ACTIVE_LIMIT_MS) - run.activeMs;
    if (remaining <= 0)
      throw new WorkflowBlocked(
        'The active execution budget is exhausted. Start a new explicitly scoped run.',
      );
    const timeout = AbortSignal.timeout(Math.max(1, Math.ceil(remaining)));
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    combined.throwIfAborted();
    const started = performance.now();
    run.activeStartedAt = Date.now();
    await this.options.store.saveRun(run);
    let failure: unknown;
    let completed: { value: T } | undefined;
    try {
      combined.throwIfAborted();
      const result = await action(combined);
      combined.throwIfAborted();
      completed = { value: result };
    } catch (error) {
      failure = error;
    }
    if (!hasUncertainTermination(failure)) {
      run.activeMs += Math.max(0, performance.now() - started);
      delete run.activeStartedAt;
    }
    try {
      await this.options.store.saveRun(run);
    } catch (saveError) {
      if (!completed)
        throw new AggregateError(
          [failure, saveError],
          'Execution failed and its final state could not be saved.',
          { cause: saveError },
        );
      throw saveError;
    }
    if (!completed) throw failure;
    return completed.value;
  }

  private async transition(run: Run, status: Run['status'], message?: string): Promise<void> {
    run.status = status;
    run.updatedAt = new Date().toISOString();
    if (message) run.message = redact(message);
    else delete run.message;
    await this.options.store.saveRun(run);
    await this.options.store.appendEvent(run.id, {
      at: run.updatedAt,
      status,
      message: run.message,
    });
    this.options.ui.show(`${run.id}: ${status}${message ? `\n${redact(message)}` : ''}`);
  }

  private async stop(run: Run, error: unknown, signal?: AbortSignal): Promise<Run> {
    const message = hasUncertainTermination(error)
      ? 'Process-tree shutdown could not be verified. The execution lock is retained; stop orphaned processes or reboot before manual recovery.'
      : error instanceof Error
        ? error.message
        : 'Unknown execution error';
    const status = signal?.aborted
      ? 'cancelled'
      : error instanceof WorkflowBlocked
        ? 'blocked'
        : 'failed';
    await this.transition(run, status, message);
    return run;
  }
}

function isWithin(parent: string, child: string): boolean {
  const normalizedParent = resolve(parent).replaceAll('\\', '/');
  const normalizedChild = resolve(child).replaceAll('\\', '/');
  const canonicalParent =
    process.platform === 'win32' ? normalizedParent.toLowerCase() : normalizedParent;
  const canonicalChild =
    process.platform === 'win32' ? normalizedChild.toLowerCase() : normalizedChild;
  return canonicalChild === canonicalParent || canonicalChild.startsWith(`${canonicalParent}/`);
}
