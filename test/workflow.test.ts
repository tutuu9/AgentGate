import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileRunStore } from '../src/core/store.ts';
import { Workflow } from '../src/core/workflow.ts';
import { RepoSchema } from '../src/core/contracts.ts';
import type {
  AgentRunner,
  AgentResultMap,
  AgentStage,
  AgentContext,
  GitHubGateway,
  Run,
  SandboxRunner,
  UserInteraction,
} from '../src/core/contracts.ts';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agentgate-workflow-'));
  await mkdir(join(root, 'repo'));
  const store = new FileRunStore(join(root, 'state'));
  await store.init();
  await store.saveRepo(
    RepoSchema.parse({
      name: 'example',
      path: join(root, 'repo'),
      fullName: 'owner/example',
      baseBranch: 'main',
      checks: [{ name: 'unit', command: 'node', args: ['--test'] }],
    }),
  );
  const state = {
    tree: 'tree-a',
    files: [{ path: 'src/service.ts', status: 'M' }],
    stages: [] as string[],
    checkCalls: 0,
    reviewCalls: 0,
    publishCalls: 0,
    planPrompts: 0,
    publicationPrompts: 0,
    failChecks: 0,
    blockReviews: 0,
    rejectPlan: false,
    prepared: true,
    approvePublish: true,
    ordinary: false,
    draftUnavailable: false,
    draftAttempts: [] as boolean[],
    changeOnApproval: false,
    publishErrorOnce: false,
    doctorReady: true,
  };
  const git: GitHubGateway = {
    async identify() {
      return { fullName: 'owner/example', baseBranch: 'main' };
    },
    async issue(url) {
      return { url, number: 1, title: 'Fix service', body: 'Return the correct value.' };
    },
    async baseCommit() {
      return 'a'.repeat(40);
    },
    async createWorktree() {},
    async snapshot() {
      return state.tree;
    },
    async changes() {
      return state.files;
    },
    async diff() {
      return `diff ${state.tree}`;
    },
    async commit(_path, tree) {
      assert.equal(tree, state.tree);
      return `commit-${tree}`;
    },
    async verifyCommit(_path, commit, tree) {
      assert.equal(state.tree, tree, 'Tree changed');
      assert.equal(commit, `commit-${tree}`);
    },
    async publish(_run, draft) {
      state.publishCalls += 1;
      state.draftAttempts.push(draft);
      if (state.publishErrorOnce) {
        state.publishErrorOnce = false;
        throw new Error('Connection lost after push');
      }
      if (draft && state.draftUnavailable) return { kind: 'draft-unavailable' };
      return { kind: 'published', url: 'https://github.com/owner/example/pull/2' };
    },
    async cleanup() {},
  };
  const agent: AgentRunner = {
    async run<S extends AgentStage>(
      stage: S,
      _context: AgentContext,
      signal?: AbortSignal,
    ): Promise<AgentResultMap[S]> {
      signal?.throwIfAborted();
      state.stages.push(stage);
      const result =
        stage === 'plan'
          ? {
              objective: 'Fix service',
              steps: ['Update return value'],
              allowedPaths: ['src'],
              acceptanceCriteria: ['Unit checks pass'],
              risks: [],
            }
          : stage === 'implement'
            ? { summary: 'Corrected the service.' }
            : {
                summary: 'Reviewed the diff.',
                findings:
                  state.reviewCalls++ < state.blockReviews
                    ? [{ severity: 'blocking', file: 'src/service.ts', message: 'Still wrong.' }]
                    : [],
              };
      return result as AgentResultMap[S];
    },
  };
  const sandbox: SandboxRunner = {
    async doctor() {
      return [{ name: 'isolation', ok: state.doctorReady, detail: 'Fixture only' }];
    },
    async check(spec) {
      return {
        name: spec.name,
        exitCode: state.checkCalls++ < state.failChecks ? 1 : 0,
        output: 'test result',
        durationMs: 1,
      };
    },
  };
  const ui: UserInteraction = {
    show() {},
    async approvePlan() {
      state.planPrompts += 1;
      return state.rejectPlan ? 'reject' : 'approve';
    },
    async prepared() {
      return state.prepared;
    },
    async approvePublication() {
      state.publicationPrompts += 1;
      if (state.changeOnApproval) state.tree = 'tampered';
      return state.approvePublish;
    },
    async approveOrdinaryPr() {
      return state.ordinary;
    },
  };
  const workflow = new Workflow({ store, git, agent, sandbox, ui });
  return {
    root,
    store,
    state,
    workflow,
    agent,
    git,
    sandbox,
    ui,
    start: () => workflow.start('example', 'https://github.com/owner/example/issues/1'),
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

test('complete workflow uses separate plan and commit approvals', async (t) => {
  const f = await fixture();
  t.after(f.dispose);
  const result = await f.start();
  assert.equal(result.status, 'completed', result.message);
  assert.equal(result.publicationApproval, result.candidateCommit);
  assert.equal(f.state.planPrompts, 1);
  assert.equal(f.state.publicationPrompts, 1);
  assert.deepEqual(f.state.stages, ['plan', 'implement', 'review']);
  assert.equal((await f.store.getRun(result.id)).prUrl, result.prUrl);
});

test('rejected plan never starts implementation or publication', async (t) => {
  const f = await fixture();
  t.after(f.dispose);
  f.state.rejectPlan = true;
  assert.equal((await f.start()).status, 'cancelled');
  assert.deepEqual(f.state.stages, ['plan']);
  assert.equal(f.state.publishCalls, 0);
});

test('dependencies require user readiness before implementation', async (t) => {
  const f = await fixture();
  t.after(f.dispose);
  f.state.prepared = false;
  const run = await f.start();
  assert.equal(run.status, 'preparing');
  f.state.prepared = true;
  assert.equal((await f.workflow.resume(run.id)).status, 'completed');
  assert.equal(f.state.planPrompts, 1);
});

test('a failed check gets one repair and a fresh set of checks', async (t) => {
  const f = await fixture();
  t.after(f.dispose);
  f.state.failChecks = 1;
  const run = await f.start();
  assert.equal(run.status, 'completed');
  assert.equal(run.repairAttempts, 1);
  assert.equal(f.state.checkCalls, 2);
  assert.deepEqual(f.state.stages, ['plan', 'implement', 'implement', 'review']);
});

test('repair budget persists across resume and cannot create a retry loop', async (t) => {
  const f = await fixture();
  t.after(f.dispose);
  f.state.failChecks = 99;
  const run = await f.start();
  assert.equal(run.status, 'blocked');
  assert.equal(run.repairAttempts, 1);
  assert.equal((await f.workflow.resume(run.id)).status, 'blocked');
  assert.equal(f.state.stages.filter((stage) => stage === 'implement').length, 2);
  assert.equal(f.state.publishCalls, 0);
});

test('blocking review consumes the same one-repair budget and reruns checks/review', async (t) => {
  const f = await fixture();
  t.after(f.dispose);
  f.state.blockReviews = 1;
  const run = await f.start();
  assert.equal(run.status, 'completed');
  assert.equal(run.repairAttempts, 1);
  assert.equal(f.state.checkCalls, 2);
  assert.equal(f.state.reviewCalls, 2);
});

test('changed tree after inspection invalidates old checks and candidate on resume', async (t) => {
  const f = await fixture();
  t.after(f.dispose);
  f.state.approvePublish = false;
  const run = await f.start();
  assert.equal(run.status, 'awaiting_publish');
  f.state.tree = 'tree-b';
  f.state.approvePublish = true;
  const resumed = await f.workflow.resume(run.id);
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.candidateCommit, 'commit-tree-b');
  assert.equal(f.state.checkCalls, 2);
  assert.equal(f.state.reviewCalls, 2);
});

test('changing files during publication approval prevents push', async (t) => {
  const f = await fixture();
  t.after(f.dispose);
  f.state.changeOnApproval = true;
  const run = await f.start();
  assert.equal(run.status, 'failed');
  assert.equal(f.state.publishCalls, 0);
});

test('a partial publication retries only the already-approved candidate', async (t) => {
  const f = await fixture();
  t.after(f.dispose);
  f.state.publishErrorOnce = true;
  const run = await f.start();
  assert.equal(run.status, 'failed');
  const resumed = await f.workflow.resume(run.id);
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.candidateCommit, run.candidateCommit);
  assert.equal(f.state.publicationPrompts, 1);
});

test('ordinary PR fallback requires its own approval', async (t) => {
  const f = await fixture();
  t.after(f.dispose);
  f.state.draftUnavailable = true;
  const run = await f.start();
  assert.equal(run.status, 'awaiting_publish');
  assert.equal(run.ordinaryPrApproved, false);
  assert.deepEqual(f.state.draftAttempts, [true]);
  f.state.ordinary = true;
  const resumed = await f.workflow.resume(run.id);
  assert.equal(resumed.status, 'completed');
  assert.deepEqual(f.state.draftAttempts, [true, true, false]);
});

test('out-of-scope files block the run before checks and publication', async (t) => {
  const f = await fixture();
  t.after(f.dispose);
  f.state.files = [{ path: 'outside.ts', status: 'A' }];
  assert.equal((await f.start()).status, 'blocked');
  assert.equal(f.state.checkCalls, 0);
  assert.equal(f.state.publishCalls, 0);
});

test('unavailable sandbox fails closed before the first model call', async (t) => {
  const f = await fixture();
  t.after(f.dispose);
  f.state.doctorReady = false;
  await assert.rejects(f.start, /isolation/);
  assert.deepEqual(f.state.stages, []);
  assert.equal((await f.store.listRuns()).length, 0);
});

test('changed configured checks require plan approval again', async (t) => {
  const f = await fixture();
  t.after(f.dispose);
  f.state.approvePublish = false;
  const run = await f.start();
  const repo = await f.store.getRepo('example');
  repo.checks[0]!.args.push('additional.test.js');
  await f.store.saveRepo(repo);
  f.state.approvePublish = true;
  assert.equal((await f.workflow.resume(run.id)).status, 'completed');
  assert.equal(f.state.planPrompts, 2);
});

test('malformed model output does not persist a false plan approval', async (t) => {
  const f = await fixture();
  t.after(f.dispose);
  f.agent.run = async <S extends AgentStage>() =>
    ({ unexpected: true }) as unknown as AgentResultMap[S];
  const run = await f.start();
  assert.equal(run.status, 'failed');
  assert.equal(run.planApproval, undefined);
  assert.equal(f.state.publishCalls, 0);
});

test('abort preserves a cancelled run and releases the lock', async (t) => {
  const f = await fixture();
  t.after(f.dispose);
  const controller = new AbortController();
  f.agent.run = async <S extends AgentStage>(
    _stage: S,
    _context: AgentContext,
    signal?: AbortSignal,
  ) => {
    controller.abort(new Error('cancelled'));
    signal?.throwIfAborted();
    return {} as AgentResultMap[S];
  };
  const run = await f.workflow.start(
    'example',
    'https://github.com/owner/example/issues/1',
    controller.signal,
  );
  assert.equal(run.status, 'cancelled');
  const release = await f.store.acquireLock();
  await release();
});

test('exhausted active budget cannot publish an approved result', async (t) => {
  const f = await fixture();
  t.after(f.dispose);
  f.state.approvePublish = false;
  const run: Run = await f.start();
  run.activeMs = 3_600_000;
  await f.store.saveRun(run);
  f.state.approvePublish = true;
  assert.equal((await f.workflow.resume(run.id)).status, 'blocked');
  assert.equal(f.state.publishCalls, 0);
});

test('abort during preflight prevents repository operations and leaves the lock reusable', async (t) => {
  const f = await fixture();
  t.after(f.dispose);
  const controller = new AbortController();
  let fetched = false;
  f.git.baseCommit = async () => {
    fetched = true;
    return 'a'.repeat(40);
  };
  f.sandbox.doctor = async (signal) => {
    assert.equal(signal, controller.signal);
    controller.abort(new Error('Stop preflight'));
    return [{ name: 'isolation', ok: true, detail: 'fixture' }];
  };
  await assert.rejects(
    f.workflow.start('example', 'https://github.com/owner/example/issues/1', controller.signal),
    /Stop preflight/,
  );
  assert.equal(fetched, false);
  assert.equal(f.state.publishCalls, 0);
  const release = await f.store.acquireLock();
  await release();
});

test('publication receives cancellation instead of completing remote writes after an abort', async (t) => {
  const f = await fixture();
  t.after(f.dispose);
  const controller = new AbortController();
  f.git.publish = async (_run, _draft, signal) => {
    assert.ok(signal);
    controller.abort(new Error('Stop remote operations'));
    signal.throwIfAborted();
    f.state.publishCalls++;
    return { kind: 'published', url: 'https://github.com/owner/example/pull/2' };
  };
  const run = await f.workflow.start(
    'example',
    'https://github.com/owner/example/issues/1',
    controller.signal,
  );
  assert.equal(run.status, 'cancelled');
  assert.equal(f.state.publishCalls, 0);
});

test('interrupted repair retains its failure context and consumes no second repair attempt', async (t) => {
  const f = await fixture();
  t.after(f.dispose);
  f.state.failChecks = 1;
  const controller = new AbortController();
  const original = f.agent.run.bind(f.agent);
  const feedback: string[] = [];
  f.agent.run = async <S extends AgentStage>(
    stage: S,
    context: AgentContext,
    signal?: AbortSignal,
  ): Promise<AgentResultMap[S]> => {
    if (stage === 'implement' && context.feedback) {
      feedback.push(context.feedback);
      if (feedback.length === 1) {
        controller.abort(new Error('Repair interrupted'));
        signal?.throwIfAborted();
      }
    }
    return original(stage, context, signal);
  };
  const run = await f.workflow.start(
    'example',
    'https://github.com/owner/example/issues/1',
    controller.signal,
  );
  assert.equal(run.status, 'cancelled');
  assert.equal(run.repairAttempts, 1);
  assert.match((await f.store.getRun(run.id)).repairFeedback ?? '', /unit failed/);
  const resumed = await f.workflow.resume(run.id);
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.repairAttempts, 1);
  assert.equal(resumed.repairFeedback, undefined);
  assert.equal(feedback.length, 2);
  assert.equal(feedback[0], feedback[1]);
});

test('execution start is durable and an unclosed action is charged on resume', async (t) => {
  const f = await fixture();
  t.after(f.dispose);
  f.state.approvePublish = false;
  const original = f.agent.run.bind(f.agent);
  f.agent.run = async <S extends AgentStage>(
    stage: S,
    context: AgentContext,
    signal?: AbortSignal,
  ): Promise<AgentResultMap[S]> => {
    const persisted = await f.store.getRun(context.run.id);
    assert.equal(typeof persisted.activeStartedAt, 'number');
    return original(stage, context, signal);
  };
  const run = await f.start();
  assert.equal(run.activeStartedAt, undefined);
  run.activeMs = 0;
  run.activeStartedAt = Date.now() - 3_600_001;
  await f.store.saveRun(run);
  f.state.approvePublish = true;
  const resumed = await f.workflow.resume(run.id);
  assert.equal(resumed.status, 'blocked');
  assert.ok(resumed.activeMs >= 3_600_000);
  assert.equal(resumed.activeStartedAt, undefined);
  assert.equal(f.state.publishCalls, 0);
});

test('uncertain termination nested in cleanup errors retains the execution lock', async (t) => {
  const f = await fixture();
  t.after(f.dispose);
  const termination = Object.assign(new Error('Could not stop worker tree'), {
    kind: 'termination',
  });
  f.agent.run = async () => {
    throw new AggregateError(
      [new Error('Cleanup failed', { cause: termination })],
      'Operation failed',
    );
  };
  const run = await f.start();
  assert.equal(run.status, 'failed');
  assert.match(run.message ?? '', /lock is retained/);
  assert.equal(typeof run.activeStartedAt, 'number');
  await assert.rejects(f.store.acquireLock(), /lock|process/i);
  assert.equal(f.state.publishCalls, 0);
});

test('a parent directory alias cannot place controller state inside the target repository', async (t) => {
  const f = await fixture();
  t.after(f.dispose);
  f.state.approvePublish = false;
  const run = await f.start();
  const repo = await f.store.getRepo('example');
  const physical = join(repo.path, 'nested-state');
  const alias = join(f.root, 'state-alias');
  await mkdir(physical);
  await symlink(physical, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const store = new FileRunStore(join(alias, 'state'));
  await store.init();
  await store.saveRepo(repo);
  await store.saveRun(run);
  const workflow = new Workflow({
    store,
    git: f.git,
    agent: f.agent,
    sandbox: f.sandbox,
    ui: f.ui,
  });
  const previousStages = f.state.stages.length;
  await assert.rejects(
    workflow.start('example', 'https://github.com/owner/example/issues/1'),
    /separate directories/,
  );
  const resumed = await workflow.resume(run.id);
  assert.equal(resumed.status, 'blocked');
  assert.match(resumed.message ?? '', /separate directories/);
  assert.equal(f.state.stages.length, previousStages);
  assert.equal(f.state.publishCalls, 0);
});
