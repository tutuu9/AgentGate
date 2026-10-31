import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { webFixture, type RunView } from './helpers/web-fixture.ts';
import type { WebOperation } from '../src/web/contracts.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

test('web workflow requires plan, dependency, and exact-commit publication decisions', async (t) => {
  const f = await webFixture(t);
  const operation = await f.start({
    ...f.startBody(),
    model: 'gpt-6.1-sol',
    reasoningEffort: 'high',
  });
  const plan = await f.prompt('plan');
  assert.equal(plan.run.planApproval, undefined);
  assert.deepEqual(f.state.stages, ['plan']);
  assert.equal(f.state.publishCalls, 0);
  await f.respond(plan, 'approve');
  const prepared = await f.prompt('prepared');
  assert.equal(prepared.run.status, 'preparing');
  assert.deepEqual(f.state.stages, ['plan']);
  await f.respond(prepared, 'approve');
  const publication = await f.prompt('publication');
  assert.equal(publication.binding, publication.run.candidateCommit);
  assert.equal(publication.diff, 'diff tree-a');
  assert.equal(publication.run.checks[0]?.output, 'Unit checks passed.');
  assert.equal(publication.run.review?.summary, 'Reviewed the diff.');
  assert.match(publication.proposal?.body ?? '', /Closes #1/);
  assert.equal(f.state.publishCalls, 0);
  await f.respond(publication, 'approve');
  const finished = await f.finished(operation.id);
  assert.equal(finished.resultStatus, 'completed');
  const run = await f.store.getRun(publication.run.id);
  assert.equal(run.publicationApproval, run.candidateCommit);
  assert.equal(run.prUrl, 'https://github.com/owner/example/pull/2');
  assert.deepEqual(f.state.stages, ['plan', 'implement', 'review']);
  assert.deepEqual(f.state.modelOptions, [{ model: 'gpt-6.1-sol', reasoningEffort: 'high' }]);
});

test('plan feedback creates a fresh decision and rejection never implements', async (t) => {
  const f = await webFixture(t);
  const operation = await f.start();
  const original = await f.prompt('plan');
  await f.respond(original, 'feedback', 'Keep the existing signature.');
  const revised = (
    await f.waitFor(f.getState, (s) => s.prompt?.kind === 'plan' && s.prompt.id !== original.id)
  ).prompt!;
  assert.notEqual(revised.binding, original.binding);
  assert.deepEqual(f.state.feedback, ['Keep the existing signature.']);
  assert.equal(
    (
      await f.send(`/api/prompts/${original.id}/respond`, {
        method: 'POST',
        body: { binding: original.binding, choice: 'approve' },
      })
    ).status,
    409,
  );
  await f.respond(revised, 'reject');
  assert.equal((await f.finished(operation.id)).resultStatus, 'cancelled');
  assert.deepEqual(f.state.stages, ['plan', 'plan']);
  assert.equal(f.state.publishCalls, 0);
});

test('declined dependencies pause until an explicit resume and new readiness decision', async (t) => {
  const f = await webFixture(t);
  const operation = await f.start();
  await f.respond(await f.prompt('plan'), 'approve');
  const prepared = await f.prompt('prepared');
  await f.respond(prepared, 'reject');
  assert.equal((await f.finished(operation.id)).resultStatus, 'preparing');
  assert.equal((await f.getState()).prompt, null);
  assert.deepEqual(f.state.stages, ['plan']);
  const resumed = await f.json<WebOperation>(`/api/runs/${prepared.run.id}/resume`, {
    method: 'POST',
    body: { requestId: randomUUID() },
  });
  const next = await f.prompt('prepared');
  assert.notEqual(next.id, prepared.id);
  await f.respond(next, 'approve');
  await f.respond(await f.prompt('publication'), 'reject');
  assert.equal((await f.finished(resumed.id)).resultStatus, 'awaiting_publish');
  assert.equal(f.state.publishCalls, 0);
});

test('ordinary PR fallback needs distinct consent for the already-approved commit', async (t) => {
  const f = await webFixture(t);
  f.state.draftUnavailable = true;
  const { operation, pending } = await f.publication();
  await f.respond(pending, 'approve');
  const ordinary = await f.prompt('ordinary-pr');
  assert.notEqual(ordinary.id, pending.id);
  assert.equal(ordinary.binding, pending.binding);
  assert.equal(ordinary.diff, pending.diff);
  assert.deepEqual(f.state.draftAttempts, [true]);
  await f.respond(ordinary, 'approve');
  assert.equal((await f.finished(operation.id)).resultStatus, 'completed');
  assert.deepEqual(f.state.draftAttempts, [true, false]);
  assert.equal((await f.store.getRun(pending.run.id)).ordinaryPrApproved, true);
});

test('wrong commit and consumed prompt responses cannot authorize publication', async (t) => {
  const f = await webFixture(t);
  const { operation, pending } = await f.publication();
  const wrong = await f.send(`/api/prompts/${pending.id}/respond`, {
    method: 'POST',
    body: { binding: 'c'.repeat(40), choice: 'approve' },
  });
  assert.equal(wrong.status, 409);
  assert.equal(f.state.publishCalls, 0);
  assert.equal((await f.getState()).prompt?.id, pending.id);
  await f.respond(pending, 'reject');
  await f.finished(operation.id);
  const duplicate = await f.send(`/api/prompts/${pending.id}/respond`, {
    method: 'POST',
    body: { binding: pending.binding, choice: 'approve' },
  });
  assert.equal(duplicate.status, 409);
  assert.equal(f.state.publishCalls, 0);
});

test('request retries are idempotent during and after execution and conflicting requests are refused', async (t) => {
  const f = await webFixture(t);
  const body = f.startBody();
  const attempts = await Promise.all([f.start(body), f.start(body)]);
  assert.equal(attempts[0]!.id, attempts[1]!.id);
  const plan = await f.prompt('plan');
  const overlap = await f.send('/api/runs', { method: 'POST', body: f.startBody() });
  assert.equal(overlap.status, 409);
  const changed = await f.send('/api/runs', {
    method: 'POST',
    body: { ...body, issueUrl: 'https://github.com/owner/example/issues/2' },
  });
  assert.equal(changed.status, 409);
  await f.respond(plan, 'reject');
  await f.finished(attempts[0]!.id);
  const replay = await f.start(body);
  assert.equal(replay.id, attempts[0]!.id);
  assert.equal((await f.store.listRuns()).length, 1);
  assert.deepEqual(f.state.stages, ['plan']);
});

test('an external CLI run lock blocks web execution without claiming an approval', async (t) => {
  const f = await webFixture(t);
  const release = await f.store.acquireLock();
  try {
    const operation = await f.start();
    const done = await f.finished(operation.id);
    assert.equal(done.status, 'failed');
    assert.match(done.error ?? '', /run lock/);
    assert.deepEqual(await f.store.listRuns(), []);
    assert.deepEqual(f.state.stages, []);
    assert.equal((await f.getState()).prompt, null);
  } finally {
    await release();
  }
});

test('preflight failure reports an operation error without creating a run', async (t) => {
  const f = await webFixture(t);
  f.state.doctorReady = false;
  const operation = await f.start();
  const result = await f.finished(operation.id);
  assert.equal(result.status, 'failed');
  assert.equal(result.runId, undefined);
  assert.match(result.error ?? '', /fixture/);
  assert.equal((await f.getState()).busy, false);
  assert.deepEqual(await f.store.listRuns(), []);
  assert.deepEqual(f.state.stages, []);
});

test('cancellation during preflight stops before a run exists', async (t) => {
  const f = await webFixture(t);
  const entered = deferred();
  f.sandbox.doctor = async (signal) => {
    entered.resolve();
    assert.ok(signal);
    await new Promise<void>((_resolve, reject) => {
      signal.throwIfAborted();
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    return [];
  };
  const operation = await f.start();
  await entered.promise;
  await f.json(`/api/operations/${operation.id}/cancel`, { method: 'POST', body: {} });
  assert.equal((await f.finished(operation.id)).status, 'failed');
  assert.deepEqual(await f.store.listRuns(), []);
  const release = await f.store.acquireLock();
  await release();
});

test('refresh preserves a prompt while cancellation settles it and releases a safe lock', async (t) => {
  const f = await webFixture(t);
  const operation = await f.start();
  const plan = await f.prompt('plan');
  for (let i = 0; i < 3; i++) {
    assert.equal((await f.getState()).prompt?.id, plan.id);
    assert.equal((await f.json<RunView>(`/api/runs/${plan.run.id}`)).run.status, 'awaiting_plan');
  }
  await f.json(`/api/operations/${operation.id}/cancel`, { method: 'POST', body: {} });
  assert.equal((await f.finished(operation.id)).resultStatus, 'cancelled');
  assert.equal((await f.getState()).prompt, null);
  const release = await f.store.acquireLock();
  await release();
  assert.equal(
    (
      await f.send(`/api/prompts/${plan.id}/respond`, {
        method: 'POST',
        body: { binding: plan.binding, choice: 'approve' },
      })
    ).status,
    409,
  );
});

test('server restart rotates authentication and requires explicit resume with a fresh prompt', async (t) => {
  const f = await webFixture(t);
  await f.start();
  const plan = await f.prompt('plan');
  const originalToken = new URL(f.server.url).hash.slice('#token='.length);
  await f.restart();
  assert.equal(
    (await f.send('/api/state', { headers: { 'X-AgentGate-Token': originalToken } })).status,
    401,
  );
  const idle = await f.getState();
  assert.equal(idle.prompt, null);
  assert.equal(idle.busy, false);
  assert.deepEqual(f.state.stages, ['plan']);
  await f.json(`/api/runs/${plan.run.id}/resume`, {
    method: 'POST',
    body: { requestId: randomUUID() },
  });
  const renewed = await f.prompt('plan');
  assert.notEqual(renewed.id, plan.id);
  assert.equal(renewed.run.id, plan.run.id);
  assert.deepEqual(f.state.stages, ['plan']);
});

test('uncertain workflow termination retains its lease across server shutdown', async (t) => {
  const f = await webFixture(t);
  f.state.implementationError = Object.assign(
    new Error('Native descendant shutdown is unverified'),
    { kind: 'termination' },
  );
  const operation = await f.start();
  await f.respond(await f.prompt('plan'), 'approve');
  const prepared = await f.prompt('prepared');
  await f.respond(prepared, 'approve');
  const stopped = await f.finished(operation.id);
  assert.equal(stopped.resultStatus, 'failed');
  assert.match(
    (await f.store.getRun(prepared.run.id)).message ?? '',
    /shutdown could not be verified/,
  );
  await f.server.close();
  await access(join(f.store.home, 'run.lock'));
  await assert.rejects(f.store.acquireLock(), /run lock/);
});

test('active run inspection never snapshots the worktree; idle inspection takes the shared lock', async (t) => {
  const f = await webFixture(t);
  const { operation, pending } = await f.publication();
  const snapshots = f.state.snapshotCalls;
  const activeView = await f.json<RunView>(`/api/runs/${pending.run.id}`);
  assert.equal(activeView.diff, pending.diff);
  await f.getState();
  const activeInspection = await f.send(`/api/runs/${pending.run.id}/inspect`, {
    method: 'POST',
    body: {},
  });
  assert.equal(activeInspection.status, 409);
  assert.equal(f.state.snapshotCalls, snapshots);
  await f.respond(pending, 'reject');
  await f.finished(operation.id);
  const beforeIdle = f.state.snapshotCalls;
  const release = await f.store.acquireLock();
  try {
    const locked = await f.send(`/api/runs/${pending.run.id}/inspect`, {
      method: 'POST',
      body: {},
    });
    assert.ok(locked.status >= 400);
    assert.equal(f.state.snapshotCalls, beforeIdle);
  } finally {
    await release();
  }
  const inspected = await f.json<{ diff: string }>(`/api/runs/${pending.run.id}/inspect`, {
    method: 'POST',
    body: {},
  });
  assert.equal(inspected.diff, 'diff tree-a');
  assert.equal(f.state.snapshotCalls, beforeIdle + 1);
});

test('inspection reserves the operation slot before awaiting its snapshot', async (t) => {
  const f = await webFixture(t);
  const operation = await f.start();
  const plan = await f.prompt('plan');
  await f.respond(plan, 'reject');
  await f.finished(operation.id);
  const entered = deferred();
  const proceed = deferred();
  const originalSnapshot = f.git.snapshot;
  f.git.snapshot = async (...args) => {
    entered.resolve();
    await proceed.promise;
    return originalSnapshot(...args);
  };
  const inspection = f.send(`/api/runs/${plan.run.id}/inspect`, { method: 'POST', body: {} });
  try {
    await entered.promise;
    assert.equal((await f.getState()).busy, true);
    assert.equal((await f.send('/api/runs', { method: 'POST', body: f.startBody() })).status, 409);
    assert.equal(
      (
        await f.send(`/api/runs/${plan.run.id}/resume`, {
          method: 'POST',
          body: { requestId: randomUUID() },
        })
      ).status,
      409,
    );
  } finally {
    proceed.resolve();
  }
  assert.equal((await inspection).status, 200);
  assert.equal((await f.getState()).busy, false);
});

test('HTTP reads and blocked inspection leave a live Git index untouched', async (t) => {
  const f = await webFixture(t);
  const operation = await f.start();
  const plan = await f.prompt('plan');
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: plan.run.worktree, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-b', 'main');
  git('config', 'user.name', 'AgentGate Test');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'commit.gpgSign', 'false');
  await writeFile(join(plan.run.worktree, 'existing.ts'), 'export const value = 1;\n');
  git('add', '.');
  git('-c', 'core.hooksPath=', 'commit', '-m', 'test: initialize web inspection fixture');
  await writeFile(join(plan.run.worktree, 'existing.ts'), 'export const value = 2;\n');
  await writeFile(join(plan.run.worktree, 'new.ts'), 'export const fresh = true;\n');
  f.git.snapshot = async () => {
    git('add', '--all');
    return git('write-tree');
  };
  await f.getState();
  await f.json<RunView>(`/api/runs/${plan.run.id}`);
  assert.equal(
    (await f.send(`/api/runs/${plan.run.id}/inspect`, { method: 'POST', body: {} })).status,
    409,
  );
  assert.equal(git('diff', '--cached', '--name-only'), '');
  await f.respond(plan, 'reject');
  await f.finished(operation.id);
});

test('loopback HTTP API requires its token, canonical Host and same-origin JSON mutations', async (t) => {
  const f = await webFixture(t);
  for (const headers of [{ 'X-AgentGate-Token': undefined }, { 'X-AgentGate-Token': 'incorrect' }])
    assert.equal((await f.send('/api/state', { headers })).status, 401);
  for (const host of ['attacker.invalid', 'localhost', '127.0.0.1', '127.0.0.1.attacker.invalid']) {
    assert.ok((await f.send('/api/state', { headers: { Host: host } })).status >= 400);
  }
  for (const origin of [
    undefined,
    'null',
    'https://attacker.invalid',
    `${f.server.origin}.attacker.invalid`,
  ]) {
    const result = await f.send('/api/runs', {
      method: 'POST',
      body: f.startBody(),
      headers: { Origin: origin },
    });
    assert.equal(result.status, 403);
  }
  assert.equal(
    (await f.send('/api/state', { headers: { Origin: 'https://attacker.invalid' } })).status,
    403,
  );
  assert.equal(
    (
      await f.send('/api/runs', {
        method: 'POST',
        body: f.startBody(),
        headers: { 'Content-Type': 'text/plain' },
      })
    ).status,
    415,
  );
  const preflight = await f.send('/api/runs', {
    method: 'OPTIONS',
    headers: { Origin: 'https://attacker.invalid', 'Access-Control-Request-Method': 'POST' },
  });
  assert.equal(preflight.headers['access-control-allow-origin'], undefined);
  assert.deepEqual(await f.store.listRuns(), []);
});

test('malformed, oversized and authority-bearing bodies fail before workflow execution', async (t) => {
  const f = await webFixture(t);
  const malformed = await f.send('/api/runs', { method: 'POST', raw: '{' });
  assert.equal(malformed.status, 400);
  const oversized = await f.send('/api/runs', {
    method: 'POST',
    raw: JSON.stringify({ data: 'x'.repeat(65_537) }),
  });
  assert.equal(oversized.status, 413);
  for (const extra of [
    { publicationApproval: 'b'.repeat(40) },
    { planApproval: 'forged' },
    { ordinaryPrApproved: true },
    { repo: '../state' },
    { model: 'bad model' },
    { reasoningEffort: 'unknown' },
  ]) {
    const rejected = await f.send('/api/runs', {
      method: 'POST',
      body: { ...f.startBody(), ...extra },
    });
    assert.equal(rejected.status, 400, rejected.text);
  }
  assert.deepEqual(f.state.stages, []);
  assert.deepEqual(await f.store.listRuns(), []);
});

test('static responses restrict browser privileges and API data is scrubbed', async (t) => {
  const f = await webFixture(t);
  f.state.issueTitle = '<img src=x onerror=alert(1)>';
  f.state.issueBody = 'password=do-not-display';
  const page = await f.send('/');
  assert.equal(page.status, 200);
  assert.match(String(page.headers['content-security-policy']), /frame-ancestors 'none'/);
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
  assert.equal(page.headers['referrer-policy'], 'no-referrer');
  assert.match(String(page.headers['cache-control']), /no-store/);
  assert.equal(page.headers['access-control-allow-origin'], undefined);
  for (const path of ['/AGENTS.md', '/src/core/store.ts', '/.git/config', '/api/files']) {
    assert.equal((await f.send(path)).status, 404);
  }
  await f.start();
  const plan = await f.prompt('plan');
  assert.equal(plan.run.issue.title, '<img src=x onerror=alert(1)>');
  const response = await f.send(`/api/runs/${plan.run.id}`);
  assert.doesNotMatch(response.text, /do-not-display/);
  assert.match(response.text, /REDACTED/);
  assert.match(String(response.headers['content-type']), /application\/json/);
});
