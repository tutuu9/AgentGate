import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { execute } from '../src/adapters/process.ts';

const project = fileURLToPath(new URL('../', import.meta.url));

async function fixture(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agentgate-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'scripts'));
  await cp(join(project, 'scripts/clean-dist.mjs'), join(root, 'scripts/clean-dist.mjs'));
  return root;
}

function clean(root: string, cwd = root) {
  return spawnSync(process.execPath, [join(root, 'scripts/clean-dist.mjs')], {
    cwd,
    encoding: 'utf8',
    timeout: 10_000,
  });
}

test('cleaning is anchored to the project and preserves source, state, worktrees and link targets', async (t) => {
  const root = await fixture(t);
  const keep = ['src', '.agentgate', 'worktrees', 'unrelated'];
  for (const name of [...keep, 'dist']) {
    await mkdir(join(root, name));
    await writeFile(join(root, name, 'canary.txt'), name);
  }
  await symlink(join(root, 'unrelated'), join(root, 'dist/linked'), 'junction');
  const result = clean(root, join(root, 'unrelated'));
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  await assert.rejects(access(join(root, 'dist')), { code: 'ENOENT' });
  for (const name of keep) {
    assert.equal(await readFile(join(root, name, 'canary.txt'), 'utf8'), name);
  }
  assert.equal(clean(root).status, 0, 'An absent dist is safe on a first build.');
});

test('cleaning refuses a redirected or non-directory output without deleting it', async (t) => {
  const root = await fixture(t);
  const outside = await fixture(t);
  await writeFile(join(outside, 'canary.txt'), 'preserve');
  await symlink(outside, join(root, 'dist'), 'junction');
  const redirected = clean(root);
  assert.ifError(redirected.error);
  assert.notEqual(redirected.status, 0);
  assert.match(redirected.stderr, /Refusing to clean dist/);
  assert.equal(await readFile(join(root, 'dist/canary.txt'), 'utf8'), 'preserve');
  assert.equal(await readFile(join(outside, 'canary.txt'), 'utf8'), 'preserve');
  await rm(join(root, 'dist'));
  await writeFile(join(root, 'dist'), 'preserve non-directory');
  const file = clean(root);
  assert.notEqual(file.status, 0);
  assert.match(file.stderr, /Refusing to clean dist/);
  assert.equal(await readFile(join(root, 'dist'), 'utf8'), 'preserve non-directory');
});

test('a normal build removes stale output before packing the intended files', async (t) => {
  const root = await fixture(t);
  const manifest = JSON.parse(await readFile(join(project, 'package.json'), 'utf8')) as {
    files: string[];
  };
  const inputs = new Set([
    'package.json',
    'tsconfig.json',
    'tsconfig.build.json',
    'src',
    'scripts',
    ...manifest.files.filter((path) => path !== 'dist'),
  ]);
  for (const path of inputs) await cp(join(project, path), join(root, path), { recursive: true });
  await symlink(join(project, 'node_modules'), join(root, 'node_modules'), 'junction');
  await mkdir(join(root, 'dist/removed'), { recursive: true });
  await writeFile(join(root, 'dist/removed/stale.js'), 'synthetic stale build output');
  await writeFile(join(root, 'dist/unexpected.txt'), 'synthetic extra artifact');
  const env: NodeJS.ProcessEnv = {
    SystemRoot: process.env.SystemRoot,
    PATH: process.env.PATH,
    PATHEXT: process.env.PATHEXT,
    HOME: join(root, 'home'),
    USERPROFILE: join(root, 'home'),
    TEMP: tmpdir(),
    TMP: tmpdir(),
    npm_config_cache: join(root, 'npm-cache'),
    npm_config_offline: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
  };
  const build = await execute({
    command: 'npm',
    args: ['run', 'build'],
    cwd: root,
    env,
    timeoutMs: 60_000,
  });
  assert.equal(build.exitCode, 0, build.stdout + build.stderr);
  await assert.rejects(access(join(root, 'dist/removed')), { code: 'ENOENT' });
  await assert.rejects(access(join(root, 'dist/unexpected.txt')), { code: 'ENOENT' });
  const pack = await execute({
    command: 'npm',
    args: ['pack', '--ignore-scripts', '--json'],
    cwd: root,
    env,
    timeoutMs: 30_000,
  });
  assert.equal(pack.exitCode, 0, pack.stderr);
  const report = join(root, 'pack.json');
  await writeFile(report, pack.stdout);
  const verified = spawnSync(
    process.execPath,
    [join(project, 'scripts/verify-package.mjs'), report, root],
    {
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
  assert.ifError(verified.error);
  assert.equal(verified.status, 0, verified.stdout + verified.stderr);
});
