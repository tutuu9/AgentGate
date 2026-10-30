import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { arch, platform, release, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { CODEX_VERSION, createSandboxSession } from '../../src/adapters/sandbox.ts';
import { execute, ProcessError, resolveCommand } from '../../src/adapters/process.ts';
import { hasUncertainTermination } from '../../src/core/errors.ts';
import { cleanTerminal, redact } from '../../src/core/safety.ts';
import { FileRunStore } from '../../src/core/store.ts';

// Manual native toolchain acceptance, not an authenticated workflow or a model test.
// Fresh fixtures are retained outside the checkout; no credentials are copied.
const abort = new AbortController();
const interrupt = () => abort.abort(new Error('Toolchain acceptance cancelled.'));
const emit = (value: unknown) =>
  process.stdout.write(`${cleanTerminal(redact(JSON.stringify(value)))}\n`);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const source = `export function clamp(value: number, minimum: number, maximum: number): number {
  if (minimum > maximum) throw new RangeError('Reversed bounds');
  return Math.min(maximum, Math.max(minimum, value));
}
`;
const tests = `import assert from 'node:assert/strict';
import test from 'node:test';
import { clamp } from '../src/clamp.ts';
test('clamps valid input and rejects reversed bounds', () => {
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(11, 0, 10), 10);
  assert.equal(clamp(8, 5, 5), 5);
  assert.throws(() => clamp(5, 10, 0), RangeError);
});
`;

function inside(parent: string, path: string): boolean {
  const child = relative(parent, path);
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`));
}

async function checkedDirectory(path: string): Promise<string> {
  for (let current = resolve(path); ; current = dirname(current)) {
    const entry = await lstat(current);
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw new Error('Toolchain fixture directories must not be redirected.');
    if (dirname(current) === current) return realpath(path);
  }
}

async function prepareFixture(workspace: string): Promise<void> {
  const dependencies = await checkedDirectory(join(projectRoot, 'node_modules'));
  await cp(dependencies, join(workspace, 'node_modules'), {
    recursive: true,
    errorOnExist: true,
    force: false,
    verbatimSymlinks: true,
    async filter(path) {
      abort.signal.throwIfAborted();
      if (!inside(dependencies, path)) throw new Error('Dependency source escaped its directory.');
      if ((await lstat(path)).isSymbolicLink()) {
        if (isAbsolute(await readlink(path)) || !inside(dependencies, await realpath(path)))
          throw new Error('Dependency link leaves the prepared dependency tree.');
      }
      return true;
    },
  });
  await mkdir(join(workspace, 'src'));
  await mkdir(join(workspace, 'test'));
  const files: Record<string, string> = {
    'package.json': JSON.stringify({
      name: 'agentgate-offline-toolchain-fixture',
      private: true,
      type: 'module',
      scripts: {
        lint: 'node node_modules/eslint/bin/eslint.js src test',
        typecheck: 'node node_modules/typescript/bin/tsc --noEmit',
        test: 'node --test test/*.test.ts',
        build: 'node node_modules/typescript/bin/tsc',
      },
    }),
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        target: 'ES2023',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        rewriteRelativeImportExtensions: true,
        skipLibCheck: true,
        types: ['node'],
        outDir: 'dist',
      },
      include: ['src/**/*.ts', 'test/**/*.ts'],
    }),
    'eslint.config.js': `import js from '@eslint/js';
import tseslint from 'typescript-eslint';
export default tseslint.config(js.configs.recommended, ...tseslint.configs.recommended);
`,
    'src/clamp.ts': source,
    'test/clamp.test.ts': tests,
  };
  for (const [name, contents] of Object.entries(files))
    await writeFile(join(workspace, name), contents, { flag: 'wx' });
}

async function runCheck(codexPath: string, home: string, workspace: string, name: string) {
  const session = await createSandboxSession(home, workspace, true, codexPath);
  let uncertain = false;
  try {
    const command = await resolveCommand('npm', ['run', name], session.env, workspace);
    // Match the production check launch: resolve externally, then change cwd inside the sandbox.
    const trampoline = `const {spawn}=require('node:child_process');const [cwd,cmd,...args]=process.argv.slice(1);process.chdir(cwd);const p=spawn(cmd,args,{shell:false,stdio:'inherit',windowsHide:true});p.on('error',()=>process.exit(127));p.on('exit',(code)=>process.exit(code??1));`;
    return await execute({
      command: session.codexExecutable ?? codexPath,
      args: [
        ...session.configArgs,
        'sandbox',
        '--include-managed-config',
        '-P',
        session.profile,
        '-C',
        session.launcher,
        '--',
        process.execPath,
        '-e',
        trampoline,
        workspace,
        command.command,
        ...command.args,
      ],
      cwd: session.launcher,
      env: session.env,
      signal: abort.signal,
      timeoutMs: 120_000,
      maxOutputBytes: 128 * 1024,
    });
  } catch (error) {
    uncertain = hasUncertainTermination(error);
    throw error;
  } finally {
    if (!uncertain) await session.cleanup();
  }
}

async function verifyVersion(codexPath: string, home: string): Promise<void> {
  const session = await createSandboxSession(home, undefined, false, codexPath);
  let uncertain = false;
  try {
    const result = await execute({
      command: session.codexExecutable ?? codexPath,
      args: [...session.configArgs, '--version'],
      cwd: session.launcher,
      env: session.env,
      signal: abort.signal,
      timeoutMs: 10_000,
      maxOutputBytes: 4096,
    });
    if (result.exitCode !== 0 || result.stdout.trim() !== `codex-cli ${CODEX_VERSION}`)
      throw new Error(`Native Codex ${CODEX_VERSION} is required; version output discarded.`);
  } catch (error) {
    uncertain = hasUncertainTermination(error);
    throw error;
  } finally {
    if (!uncertain) await session.cleanup();
  }
}

async function verifyCancellation(
  codexPath: string,
  home: string,
  workspace: string,
): Promise<void> {
  const session = await createSandboxSession(home, workspace, true, codexPath);
  const nonce = randomUUID();
  const heartbeat = join(workspace, `cancellation-${nonce}.json`);
  const child = `const fs=require('node:fs');const [path,nonce]=process.argv.slice(1);let counter=0;
setInterval(()=>{counter++;fs.writeFileSync(path,JSON.stringify({nonce,counter}),{flag:counter===1?'wx':'w'})},25);
setTimeout(()=>process.exit(0),30000);`;
  const parent = `const {spawn}=require('node:child_process');
const [path,nonce,script]=process.argv.slice(1);
spawn(process.execPath,['-e',script,path,nonce],{shell:false,windowsHide:true,stdio:'inherit'});
setTimeout(()=>process.exit(0),30000);`;
  const cancellation = new AbortController();
  const started = Date.now();
  let uncertain = false;
  const execution = execute({
    command: session.codexExecutable ?? codexPath,
    args: [
      ...session.configArgs,
      'sandbox',
      '--include-managed-config',
      '-P',
      session.profile,
      '-C',
      session.launcher,
      '--',
      process.execPath,
      '-e',
      parent,
      heartbeat,
      nonce,
      child,
    ],
    cwd: session.launcher,
    env: session.env,
    signal: AbortSignal.any([abort.signal, cancellation.signal]),
    timeoutMs: 25_000,
    maxOutputBytes: 8192,
  }).then(
    (result) => ({ result }),
    (error: unknown) => ({ error }),
  );
  const stop = async () => {
    cancellation.abort();
    const outcome = await execution;
    if ('error' in outcome && hasUncertainTermination(outcome.error)) {
      uncertain = true;
      throw outcome.error;
    }
    return outcome;
  };
  try {
    let ready = false;
    while (Date.now() - started < 10_000) {
      abort.signal.throwIfAborted();
      try {
        const value: unknown = JSON.parse(await readFile(heartbeat, 'utf8'));
        ready =
          typeof value === 'object' &&
          value !== null &&
          'nonce' in value &&
          value.nonce === nonce &&
          'counter' in value &&
          typeof value.counter === 'number' &&
          Number.isSafeInteger(value.counter) &&
          value.counter >= 3;
      } catch (error) {
        if (
          !(error instanceof SyntaxError) &&
          !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
        )
          throw error;
      }
      if (ready) break;
      await delay(25, undefined, { signal: abort.signal });
    }
    assert.ok(ready, 'Native descendant heartbeat did not start.');
    const outcome = await stop();
    assert.ok('error' in outcome && outcome.error instanceof ProcessError);
    assert.equal(outcome.error.kind, 'aborted');
    const stoppedHeartbeat = await readFile(heartbeat, 'utf8');
    await delay(750, undefined, { signal: abort.signal });
    if ((await readFile(heartbeat, 'utf8')) !== stoppedHeartbeat)
      throw new ProcessError('termination', 'Native descendant kept writing after cancellation.');
    assert.ok(Date.now() - started < 20_000, 'Observation reached the safety self-exit window.');
    // No sandbox PID is treated as a host PID; native execution closed and writes stopped.
    await unlink(heartbeat);
    emit({
      phase: 'native-cancellation',
      executionClosedAfterAbort: true,
      descendantHeartbeatStopped: true,
      observedBeforeSafetyExit: true,
      hostPidAssumed: false,
      modelInvoked: false,
    });
  } catch (error) {
    uncertain = hasUncertainTermination(error);
    throw error;
  } finally {
    await stop();
    if (!uncertain) await session.cleanup();
  }
}

async function main(): Promise<void> {
  if (process.versions.node.split('.')[0] !== '24') throw new Error('Node.js 24 is required.');
  if (process.argv.length !== 3 || !isAbsolute(process.argv[2]!))
    throw new Error('Usage: node test/manual/verify-toolchain.ts <absolute-native-codex-path>');
  const codexPath = await realpath(process.argv[2]!);
  if (!(await lstat(codexPath)).isFile()) throw new Error('Native Codex executable unavailable.');
  const temporary = await checkedDirectory(tmpdir());
  const home = await checkedDirectory(await mkdtemp(join(temporary, 'agentgate-toolchain-state-')));
  const workspace = await checkedDirectory(
    await mkdtemp(join(temporary, 'agentgate-toolchain-project-')),
  );
  if (inside(projectRoot, home) || inside(home, workspace) || inside(workspace, home))
    throw new Error('Acceptance state and fixture must be separate.');
  const store = new FileRunStore(home);
  await store.init();
  const unlock = await store.acquireLock();
  let uncertain = false;
  try {
    await verifyVersion(codexPath, home);
    emit({
      phase: 'environment',
      os: platform(),
      osVersion: release(),
      architecture: arch(),
      nodeVersion: process.version,
      codexVersion: CODEX_VERSION,
      home,
      workspace,
      fixturesRetained: true,
      modelInvoked: false,
      authenticatedWorkflow: false,
    });
    await prepareFixture(workspace);
    for (const name of ['lint', 'typecheck', 'test', 'build']) {
      const result = await runCheck(codexPath, home, workspace, name);
      emit({ phase: 'check', name, ...result });
      assert.equal(result.exitCode, 0, `Offline npm ${name} failed.`);
    }
    assert.match(
      await readFile(join(workspace, 'dist/src/clamp.js'), 'utf8'),
      /export function clamp/,
    );
    const failures = [
      {
        name: 'lint',
        path: 'src/clamp.ts',
        contents: `${source}\nconst unusedFixtureValue = 1;\n`,
        restore: source,
        diagnostic: /unusedFixtureValue.*never used/,
      },
      {
        name: 'typecheck',
        path: 'src/clamp.ts',
        contents: `${source}\nexport const invalidFixtureValue: number = 'wrong';\n`,
        restore: source,
        diagnostic: /TS2322/,
      },
      {
        name: 'test',
        path: 'test/clamp.test.ts',
        contents: tests.replace('clamp(-1, 0, 10), 0', 'clamp(-1, 0, 10), 99'),
        restore: tests,
        diagnostic: /ERR_ASSERTION/,
      },
    ];
    for (const failure of failures) {
      const path = join(workspace, failure.path);
      await writeFile(path, failure.contents);
      try {
        const result = await runCheck(codexPath, home, workspace, failure.name);
        emit({ phase: 'expected-failure', name: failure.name, ...result });
        assert.notEqual(result.exitCode, 0, `Injected ${failure.name} failure was not detected.`);
        assert.match(`${result.stdout}\n${result.stderr}`, failure.diagnostic);
      } catch (error) {
        uncertain = hasUncertainTermination(error);
        throw error;
      } finally {
        if (!uncertain) await writeFile(path, failure.restore);
      }
    }
    await verifyCancellation(codexPath, home, workspace);
    emit({ result: 'passed', modelInvoked: false, authenticatedWorkflow: false });
  } catch (error) {
    uncertain = hasUncertainTermination(error);
    throw error;
  } finally {
    if (!uncertain) await unlock();
  }
}

process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);
main()
  .catch((error) => {
    emit({
      result: 'blocked',
      error: error instanceof Error ? error.message : 'Toolchain acceptance failed.',
      uncertainTermination: hasUncertainTermination(error),
      modelInvoked: false,
      authenticatedWorkflow: false,
    });
    process.exitCode = 2;
  })
  .finally(() => {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  });
