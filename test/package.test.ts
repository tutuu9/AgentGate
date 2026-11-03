import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';

const verifier = fileURLToPath(new URL('../scripts/verify-package.mjs', import.meta.url));
const intendedFiles = [
  'package.json',
  'README.md',
  'LICENSE',
  'AGENTS.md',
  'CLAUDE.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'CHANGELOG.md',
  '.env.example',
  'docs/acceptance.md',
  'docs/architecture.md',
  'docs/decisions.md',
  'docs/roadmap.md',
  'docs/web-acceptance.md',
  'dist/cli/main.js',
  'dist/cli/main.js.map',
  'dist/cli/main.d.ts',
  'dist/core/value.js',
  'dist/core/value.js.map',
  'dist/core/value.d.ts',
  'dist/web/public/index.html',
  'dist/web/public/app.css',
  'dist/web/public/app.js',
];

async function fixture(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agentgate-package-manifest-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = {
    'package.json': JSON.stringify({ name: 'agentgate-fixture', version: '0.0.0-fixture' }),
    'tsconfig.build.json': JSON.stringify({
      compilerOptions: { rootDir: 'src', outDir: 'dist', declaration: true, sourceMap: true },
      include: ['src/**/*.ts'],
    }),
    'src/cli/main.ts': 'export {};\n',
    'src/core/value.ts': 'export const value = 1;\n',
    'src/types.d.ts': 'declare const external: string;\n',
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

function manifest(paths = intendedFiles) {
  return [
    {
      name: 'agentgate-fixture',
      version: '0.0.0-fixture',
      files: paths.map((path) => ({ path })),
    },
  ];
}

async function verify(root: string, value: unknown) {
  const path = join(root, 'pack.json');
  await writeFile(path, JSON.stringify(value));
  const result = spawnSync(process.execPath, [verifier, path, root], {
    cwd: tmpdir(),
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.ifError(result.error);
  return result;
}

test('package manifest accepts only current source outputs, web assets, and public documents', async (t) => {
  const root = await fixture(t);
  const result = await verify(root, manifest());
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /exactly 23 expected files/);

  await rm(join(root, 'src/core/value.ts'));
  const stale = await verify(root, manifest());
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /unexpected/);
  assert.match(stale.stderr, /dist\/core\/value.js/);
});

test('package manifest rejects missing required artifacts and unreviewed files', async (t) => {
  const root = await fixture(t);
  for (const path of [
    'dist/cli/main.js',
    'dist/web/public/app.js',
    'dist/web/public/app.css',
    'dist/web/public/index.html',
    'package.json',
    'README.md',
    'docs/acceptance.md',
  ]) {
    await t.test(`missing ${path}`, async () => {
      const result = await verify(root, manifest(intendedFiles.filter((file) => file !== path)));
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /missing/);
    });
  }
  for (const path of [
    'dist/stale.js',
    'dist/debug.log',
    '.env',
    '.agentgate/state.json',
    '.git/config',
    'node_modules/example/index.js',
    'test/fixture.ts',
    'docs/private-notes.md',
  ]) {
    await t.test(`unexpected ${path}`, async () => {
      const result = await verify(root, manifest([...intendedFiles, path]));
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /unexpected/);
    });
  }
});

test('package manifest rejects unsafe paths, duplicates, and malformed metadata', async (t) => {
  const root = await fixture(t);
  for (const path of [
    '../outside',
    '/absolute',
    'dist\\main.js',
    'dist/./main.js',
    'dist//main.js',
  ]) {
    const result = await verify(root, manifest([...intendedFiles, path]));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unsafe package path/);
  }
  const duplicate = await verify(root, manifest([...intendedFiles, 'package.json']));
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /duplicate paths/);
  const wrongVersion = manifest();
  wrongVersion[0]!.version = '0.0.0-another-package';
  const mismatch = await verify(root, wrongVersion);
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /version does not match/);
  for (const value of [{}, [], [null], [{ files: [] }], [...manifest(), ...manifest()]]) {
    assert.notEqual((await verify(root, value)).status, 0);
  }
});

test('package verification refuses an unsupported build-output configuration', async (t) => {
  const root = await fixture(t);
  await writeFile(
    join(root, 'tsconfig.build.json'),
    JSON.stringify({
      compilerOptions: {
        rootDir: 'src',
        outDir: 'other-output',
        declaration: true,
        sourceMap: true,
      },
      include: ['src/**/*.ts'],
    }),
  );
  const result = await verify(root, manifest());
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /changed build-output configuration/);
});
