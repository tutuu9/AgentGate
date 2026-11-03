import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { test, type TestContext } from 'node:test';
import { ESLint, type Linter } from 'eslint';

const configuration = new URL('../eslint.config.js', import.meta.url);
const projectConfig = (await import(configuration.href)).default as Linter.Config[];

async function fixture(t: TestContext, files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agentgate-toolchain-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return root;
}

test('the lint toolchain selects nested TypeScript files and preserves ignores and diagnostics', async (t) => {
  const valid = 'export const value: number = 42;\n';
  const root = await fixture(t, {
    'src/nested/value.ts': valid,
    'src/.hidden.ts': valid,
    'test/value.test.ts': 'const unused: number = 1;\nexport {};\n',
    'dist/ignored.ts': 'invalid TypeScript syntax !!!',
    'node_modules/fixture/ignored.ts': 'invalid TypeScript syntax !!!',
    'src/not-selected.txt': 'invalid TypeScript syntax !!!',
  });
  const eslint = new ESLint({
    cwd: root,
    overrideConfigFile: true,
    overrideConfig: projectConfig,
  });
  for (const pattern of ['{src,test}/**/*.ts', '**/*.ts']) {
    const results = await eslint.lintFiles([pattern]);
    const paths = results.map((result) => relative(root, result.filePath).replaceAll('\\', '/'));
    assert.deepEqual(paths.sort(), ['src/.hidden.ts', 'src/nested/value.ts', 'test/value.test.ts']);
    for (const result of results) assert.equal(result.fatalErrorCount, 0);
    const diagnostics = results.flatMap((result) =>
      result.messages.map((message) => message.ruleId),
    );
    assert.deepEqual(diagnostics, ['@typescript-eslint/no-unused-vars']);
  }
  assert.equal(await eslint.isPathIgnored(join(root, 'dist/ignored.ts')), true);
  assert.equal(await eslint.isPathIgnored(join(root, 'node_modules/fixture/ignored.ts')), true);
  assert.equal(await eslint.isPathIgnored(join(root, 'src/nested/value.ts')), false);
});

test('the TypeScript project service accepts only files matching its default-project allowlist', async (t) => {
  const source = 'export async function evaluate(): Promise<number> { return await 42; }\n';
  const root = await fixture(t, {
    'tsconfig.json': JSON.stringify({
      compilerOptions: { target: 'ES2023', module: 'NodeNext', strict: true },
      include: ['src/**/*.ts'],
    }),
    'src/included.ts': 'export {};\n',
    '.lint-helper.ts': source,
    'other/not-allowed.ts': source,
  });
  const eslint = new ESLint({
    cwd: root,
    overrideConfigFile: true,
    overrideConfig: [
      ...projectConfig,
      {
        files: ['**/*.ts'],
        languageOptions: {
          parserOptions: {
            projectService: { allowDefaultProject: ['*.ts'] },
            tsconfigRootDir: root,
          },
        },
        rules: { '@typescript-eslint/await-thenable': 'error' },
      },
    ],
  });
  const [allowed] = await eslint.lintText(source, { filePath: join(root, '.lint-helper.ts') });
  assert.ok(allowed);
  assert.equal(allowed.fatalErrorCount, 0);
  assert.deepEqual(
    allowed.messages.map((message) => message.ruleId),
    ['@typescript-eslint/await-thenable'],
  );

  const [denied] = await eslint.lintText(source, { filePath: join(root, 'other/not-allowed.ts') });
  assert.ok(denied);
  assert.equal(denied.fatalErrorCount, 1);
  assert.match(denied.messages[0]!.message, /allowDefaultProject.*does not match/s);
});
