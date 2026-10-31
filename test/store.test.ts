import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, parse, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { RunSchema, type RepoProfile, type Run } from '../src/core/contracts.ts';
import { FileRunStore } from '../src/core/store.ts';

async function fixture(
  t: TestContext,
): Promise<{ store: FileRunStore; root: string; home: string }> {
  const root = await mkdtemp(join(tmpdir(), 'agentgate-store-'));
  t.after(async () => {
    if (
      dirname(resolve(root)) !== resolve(tmpdir()) ||
      !basename(root).startsWith('agentgate-store-')
    )
      throw new Error('Unsafe fixture cleanup path');
    await rm(root, { recursive: true, force: true });
  });
  const home = join(root, 'state');
  const store = new FileRunStore(home);
  await store.init();
  return { store, root, home };
}

function repo(root: string): RepoProfile {
  return {
    name: 'example',
    path: join(root, 'repository'),
    fullName: 'owner/example',
    baseBranch: 'main',
    checks: [{ name: 'test', command: 'node', args: ['--test'], timeoutMs: 1_000 }],
  };
}

function run(root: string): Run {
  return RunSchema.parse({
    schemaVersion: 1,
    id: randomUUID(),
    repo: repo(root),
    issue: {
      url: 'https://github.com/owner/example/issues/1',
      number: 1,
      title: 'Fix greeting',
      body: 'Expected greeting',
    },
    baseCommit: 'a'.repeat(40),
    branch: 'agentgate/1',
    worktree: join(root, 'state', 'worktrees', 'one'),
    status: 'awaiting_plan',
    createdAt: '2026-10-30T00:00:00Z',
    updatedAt: '2026-10-30T00:00:00Z',
  });
}

test('repository profiles and runs persist across store instances', async (t) => {
  const { store, root, home } = await fixture(t);
  const profile = repo(root);
  const value = run(root);
  await store.saveRepo(profile);
  await store.saveRun(value);
  const reopened = new FileRunStore(home);
  assert.deepEqual(await reopened.getRepo('EXAMPLE'), profile);
  assert.deepEqual(await reopened.getRun(value.id), value);
  assert.deepEqual(await reopened.listRepos(), [profile]);
  assert.deepEqual(await reopened.listRuns(), [value]);
});

test('invalid JSON and unsupported schema fail without resetting or overwriting data', async (t) => {
  const { store, root, home } = await fixture(t);
  const value = run(root);
  await store.saveRun(value);
  const file = join(home, 'runs', `${value.id}.json`);
  for (const corrupted of ['{broken', JSON.stringify({ ...value, schemaVersion: 999 })]) {
    await writeFile(file, corrupted);
    await assert.rejects(store.getRun(value.id), /Stored data is invalid/);
    await assert.rejects(store.listRuns(), /Stored data is invalid/);
    await assert.rejects(store.saveRun(value), /Stored data is invalid/);
    assert.equal(await readFile(file, 'utf8'), corrupted);
  }
});

test('filenames cannot redirect operations outside managed storage', async (t) => {
  const { store, home } = await fixture(t);
  for (const id of ['../outside', '..\\outside', '/tmp/outside', 'C:\\outside', 'one/../../two']) {
    await assert.rejects(store.getRun(id), /Invalid run identifier/);
    await assert.rejects(store.deleteRun(id), /Invalid run identifier/);
    await assert.rejects(store.getRepo(id), /Invalid repository name/);
  }
  await assert.rejects(store.getRepo('CON'), /Invalid repository name/);
  assert.throws(() => new FileRunStore(parse(home).root), /filesystem root/);
});

test('stored identities must agree with their filenames', async (t) => {
  const { store, root, home } = await fixture(t);
  const value = run(root);
  await store.saveRun(value);
  await writeFile(
    join(home, 'runs', `${value.id}.json`),
    JSON.stringify({ ...value, id: randomUUID() }),
  );
  await assert.rejects(store.getRun(value.id), /identity/);
});

test('events and saved text scrub nested credentials and raw reasoning but preserve hashes', async (t) => {
  const { store, root, home } = await fixture(t);
  const value = run(root);
  const token = `ghp_${'x'.repeat(36)}`;
  value.message = `Failure with ${token}`;
  await store.saveRun(value);
  await store.appendEvent(value.id, {
    type: 'check',
    output: token,
    payload: { password: 'fixture-password', rawReasoning: 'private deliberation', count: 2 },
    commit: value.baseCommit,
  });
  await store.appendEvent(value.id, { type: 'reasoning.delta', text: 'do not persist' });
  const persisted = await readFile(join(home, 'runs', `${value.id}.json`), 'utf8');
  const events = await readFile(join(home, 'events', `${value.id}.jsonl`), 'utf8');
  for (const secret of [token, 'fixture-password', 'private deliberation', 'do not persist'])
    assert.ok(!(persisted + events).includes(secret));
  assert.ok(events.includes(value.baseCommit));
  assert.equal(events.trim().split('\n').length, 2);
});

test('replacing saved state is atomic and leaves no temporary files', async (t) => {
  const { store, root, home } = await fixture(t);
  const value = run(root);
  await store.saveRun(value);
  for (let index = 0; index < 8; index += 1) {
    value.message = String(index).repeat(5_000);
    const [, observed] = await Promise.all([store.saveRun(value), store.getRun(value.id)]);
    assert.ok(observed.message === undefined || /^(\d)\1*$/.test(observed.message));
  }
  assert.deepEqual(await readdir(join(home, 'runs')), [`${value.id}.json`]);
  assert.equal((await store.getRun(value.id)).message, value.message);
});

test('concurrent status readers cannot interrupt durable run updates', async (t) => {
  const { store, root, home } = await fixture(t);
  const value = run(root);
  value.message = 'Revision 0';
  value.implementationSummary = value.message;
  await store.saveRun(value);
  const read = async () => {
    for (let index = 0; index < 20; index += 1) {
      const [single, listed] = await Promise.all([store.getRun(value.id), store.listRuns()]);
      for (const observed of [single, ...listed]) {
        assert.equal(observed.id, value.id);
        assert.match(observed.message ?? '', /^Revision \d+$/);
        assert.equal(observed.implementationSummary, observed.message);
      }
    }
  };
  const save = async () => {
    for (let index = 1; index <= 20; index += 1) {
      const message = `Revision ${index}`;
      await store.saveRun({ ...value, message, implementationSummary: message });
    }
  };
  await Promise.all([save(), read(), read(), read(), read()]);
  assert.equal((await store.getRun(value.id)).message, 'Revision 20');
  assert.deepEqual(await readdir(join(home, 'runs')), [`${value.id}.json`]);
});

test('a live lock has one owner, including contention from the same PID', async (t) => {
  const { store, home } = await fixture(t);
  const release = await store.acquireLock();
  try {
    await assert.rejects(new FileRunStore(home).acquireLock(), /holds the run lock/);
  } finally {
    await release();
  }
  await release();
  const next = await store.acquireLock();
  await next();
});

test('concurrent acquisition admits exactly one owner', async (t) => {
  const { home } = await fixture(t);
  const results = await Promise.allSettled(
    Array.from({ length: 6 }, () => new FileRunStore(home).acquireLock()),
  );
  const owners = results.filter((result) => result.status === 'fulfilled');
  try {
    assert.equal(owners.length, 1);
  } finally {
    for (const owner of owners) await owner.value();
  }
});

test('dead-PID lock remains blocked because an orphan worker may still be running', async (t) => {
  const { store, root, home } = await fixture(t);
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  await once(child, 'exit');
  assert.ok(child.pid);
  try {
    process.kill(child.pid, 0);
    t.skip('Exited child PID has already been reused');
    return;
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
  }
  const value = run(root);
  value.status = 'implementing';
  await store.saveRun(value);
  const lock = JSON.stringify({ pid: child.pid, nonce: randomUUID(), createdAt: value.createdAt });
  await writeFile(join(home, 'run.lock'), lock);
  await assert.rejects(store.acquireLock(), /Stale run lock.*worker or check/);
  assert.equal((await store.getRun(value.id)).status, 'implementing');
  assert.equal(await readFile(join(home, 'run.lock'), 'utf8'), lock);
});

test('corrupt lock and changed ownership cannot be silently discarded', async (t) => {
  const { store, home } = await fixture(t);
  const release = await store.acquireLock();
  const changed = JSON.stringify({
    pid: process.pid,
    nonce: randomUUID(),
    createdAt: '2026-10-30T00:00:00Z',
  });
  await writeFile(join(home, 'run.lock'), changed);
  await assert.rejects(release(), /ownership changed/);
  assert.equal(await readFile(join(home, 'run.lock'), 'utf8'), changed);
  await writeFile(join(home, 'run.lock'), '{}');
  await assert.rejects(store.acquireLock(), /Stored data is invalid/);
  assert.equal(await readFile(join(home, 'run.lock'), 'utf8'), '{}');
});

test('junction or symlink replacement of a managed directory fails closed', async (t) => {
  const { store, root, home } = await fixture(t);
  const outside = join(root, 'outside');
  await mkdir(outside);
  await rename(join(home, 'runs'), join(home, 'previous-runs'));
  await symlink(outside, join(home, 'runs'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(store.saveRun(run(root)), /symlink|original location/);
  assert.deepEqual(await readdir(outside), []);
});

test('deletion removes only the selected run metadata and events, preserving its worktree', async (t) => {
  const { store, root } = await fixture(t);
  const value = run(root);
  await mkdir(value.worktree, { recursive: true });
  await writeFile(join(value.worktree, 'unpublished.txt'), 'keep this');
  await store.saveRun(value);
  await store.appendEvent(value.id, { type: 'saved' });
  await store.deleteRun(value.id);
  assert.deepEqual(await store.listRuns(), []);
  assert.equal(await readFile(join(value.worktree, 'unpublished.txt'), 'utf8'), 'keep this');
});

test(
  'private storage permissions are applied on Unix',
  { skip: process.platform === 'win32' },
  async (t) => {
    const { store, root, home } = await fixture(t);
    const value = run(root);
    await store.saveRun(value);
    assert.equal((await lstat(home)).mode & 0o777, 0o700);
    assert.equal((await lstat(join(home, 'runs', `${value.id}.json`))).mode & 0o777, 0o600);
  },
);
