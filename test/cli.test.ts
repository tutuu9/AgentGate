import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunSchema } from '../src/core/contracts.ts';
import { FileRunStore } from '../src/core/store.ts';

test('CLI help is available without credentials or state initialization', () => {
  const result = spawnSync(process.execPath, ['src/cli/main.ts', '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /agentgate run/);
});

test('CLI does not offer noninteractive approval bypasses', () => {
  const result = spawnSync(
    process.execPath,
    ['src/cli/main.ts', 'run', 'https://github.com/a/b/issues/1', '--repo', 'example'],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /interactive terminal/);
  const bypass = spawnSync(process.execPath, ['src/cli/main.ts', 'run', '--yes'], {
    encoding: 'utf8',
  });
  assert.notEqual(bypass.status, 0);
  assert.match(bypass.stderr, /Unknown option/);
});

test('inspect includes unstaged and new files, but never changes a live run index', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'agentgate-cli-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = new FileRunStore(home);
  await store.init();
  const id = randomUUID();
  const worktree = join(home, 'worktrees', id);
  await mkdir(worktree);
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: worktree, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-b', 'main');
  git('config', 'user.name', 'AgentGate Test');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'commit.gpgSign', 'false');
  await writeFile(join(worktree, 'existing.ts'), 'export const value = 1;\n');
  git('add', '.');
  git('-c', 'core.hooksPath=', 'commit', '-m', 'test: initialize inspection fixture');
  const baseCommit = git('rev-parse', 'HEAD');
  await store.saveRun(
    RunSchema.parse({
      schemaVersion: 1,
      id,
      worktree,
      baseCommit,
      branch: 'main',
      status: 'blocked',
      repo: {
        name: 'fixture',
        path: worktree,
        fullName: 'example/fixture',
        baseBranch: 'main',
        checks: [{ name: 'test', command: 'node', args: ['--test'] }],
      },
      issue: {
        number: 1,
        url: 'https://github.com/example/fixture/issues/1',
        title: 'Fixture',
        body: '',
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  await writeFile(join(worktree, 'existing.ts'), 'export const value = 2;\n');
  await writeFile(join(worktree, 'new.ts'), 'export const fresh = true;\n');
  const inspect = () =>
    spawnSync(process.execPath, ['src/cli/main.ts', 'inspect', id, '--json', '--home', home], {
      encoding: 'utf8',
    });
  const release = await store.acquireLock();
  try {
    const locked = inspect();
    assert.equal(locked.status, 0, locked.stderr);
    assert.match(JSON.parse(locked.stdout).diff, /Diff unavailable.*run lock/);
    assert.equal(git('diff', '--cached', '--name-only'), '');
  } finally {
    await release();
  }
  const result = inspect();
  assert.equal(result.status, 0, result.stderr);
  const diff = JSON.parse(result.stdout).diff;
  assert.match(diff, /\+export const value = 2;/);
  assert.match(diff, /\+export const fresh = true;/);
});
