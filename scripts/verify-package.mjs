import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Public documentation is reviewed explicitly: update this list when adding a shipped document.
const publicFiles = [
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
  'dist/web/public/index.html',
  'dist/web/public/app.css',
  'dist/web/public/app.js',
];

async function sourceFiles(root, directory = '') {
  const files = [];
  for (const entry of await readdir(join(root, 'src', directory), { withFileTypes: true })) {
    const path = directory ? `${directory}/${entry.name}` : entry.name;
    assert.ok(!entry.isSymbolicLink(), `Source tree contains a symbolic link: ${path}`);
    if (entry.isDirectory()) files.push(...(await sourceFiles(root, path)));
    else if (entry.isFile() && path.endsWith('.ts') && !path.endsWith('.d.ts')) files.push(path);
  }
  return files;
}

export async function expectedPackageFiles(projectRoot) {
  const build = JSON.parse(await readFile(join(projectRoot, 'tsconfig.build.json'), 'utf8'));
  const options = build?.compilerOptions;
  assert.ok(
    options?.rootDir === 'src' &&
      options.outDir === 'dist' &&
      options.declaration === true &&
      options.sourceMap === true,
    'Update package verification for the changed build-output configuration.',
  );
  assert.deepEqual(build.include, ['src/**/*.ts']);
  const sources = await sourceFiles(projectRoot);
  assert.ok(sources.includes('cli/main.ts'), 'The CLI source entrypoint is required.');
  return [
    ...publicFiles,
    ...sources.flatMap((source) => {
      const base = `dist/${source.slice(0, -3)}`;
      return [`${base}.js`, `${base}.js.map`, `${base}.d.ts`];
    }),
  ].sort();
}

function validatePath(path) {
  assert.equal(typeof path, 'string', 'Every package entry must have a path.');
  assert.ok(
    !/[\\:\u0000-\u001f\u007f]/.test(path) &&
      path.split('/').every((part) => part && part !== '.' && part !== '..'),
    `Unsafe package path: ${JSON.stringify(path)}`,
  );
}

export async function verifyPackageManifest(manifest, projectRoot) {
  assert.ok(Array.isArray(manifest) && manifest.length === 1, 'Expected one packed package.');
  const packed = manifest[0];
  const metadata = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));
  assert.ok(typeof metadata.name === 'string' && typeof metadata.version === 'string');
  assert.equal(packed?.name, metadata.name, 'Packed package name does not match package.json.');
  assert.equal(packed?.version, metadata.version, 'Packed version does not match package.json.');
  assert.ok(Array.isArray(packed?.files), 'Packed package must list its files.');
  const paths = packed.files.map((file) => {
    validatePath(file?.path);
    return file.path;
  });
  assert.equal(new Set(paths).size, paths.length, 'Packed package has duplicate paths.');
  const expected = await expectedPackageFiles(projectRoot);
  const missing = expected.filter((path) => !paths.includes(path));
  const unexpected = paths.filter((path) => !expected.includes(path));
  assert.deepEqual({ missing, unexpected }, { missing: [], unexpected: [] });
  return paths.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [manifestPath, root, ...extra] = process.argv.slice(2);
  assert.ok(
    manifestPath && extra.length === 0,
    'Usage: verify-package.mjs <pack.json> [project-root]',
  );
  const manifest = JSON.parse(await readFile(resolve(manifestPath), 'utf8'));
  const count = await verifyPackageManifest(
    manifest,
    root ? resolve(root) : fileURLToPath(new URL('..', import.meta.url)),
  );
  process.stdout.write(`Package manifest contains exactly ${count} expected files.\n`);
}
