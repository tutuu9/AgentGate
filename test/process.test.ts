import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { execute, ProcessError, resolveCommand } from '../src/adapters/process.ts';

test('execute passes arbitrary input as arguments without a shell', async () => {
  const literal = '$(echo danger); & | > < ` " newline\nUnicode: Тарас';
  const result = await execute({
    command: process.execPath,
    args: ['-e', 'process.stdout.write(process.argv[1]);', literal],
  });
  assert.equal(result.stdout, literal);
  assert.equal(result.exitCode, 0);
  assert.ok(result.durationMs >= 0);
});

test('execute returns nonzero program exits and preserves separated output', async () => {
  const result = await execute({
    command: process.execPath,
    args: ['-e', 'process.stdout.write("out");process.stderr.write("err");process.exitCode=7'],
  });
  assert.equal(result.exitCode, 7);
  assert.equal(result.stdout, 'out');
  assert.equal(result.stderr, 'err');
});

test('execute supplies stdin and does not merge an explicit environment', async () => {
  const result = await execute({
    command: process.execPath,
    args: [
      '-e',
      'process.stdin.pipe(process.stdout);process.stderr.write(String(process.env.AGENTGATE_TEST));',
    ],
    input: 'message',
    env: { AGENTGATE_TEST: 'isolated' },
  });
  assert.equal(result.stdout, 'message');
  assert.equal(result.stderr, 'isolated');
});

test('execute bounds combined stdout and stderr without accepting truncation', async () => {
  await assert.rejects(
    execute({
      command: process.execPath,
      args: [
        '-e',
        'process.stdout.write("a".repeat(1024));process.stderr.write("b".repeat(1024));setInterval(()=>{},1000)',
      ],
      maxOutputBytes: 1500,
    }),
    (error: unknown) => error instanceof ProcessError && error.kind === 'output-limit',
  );
});

test('execute fails with a structured timeout and handles already cancelled signals', async () => {
  await assert.rejects(
    execute({
      command: process.execPath,
      args: ['-e', 'setInterval(()=>{},1000)'],
      timeoutMs: 100,
    }),
    (error: unknown) => error instanceof ProcessError && error.kind === 'timeout',
  );
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    execute({ command: process.execPath, args: [], signal: abort.signal }),
    (error: unknown) => error instanceof ProcessError && error.kind === 'aborted',
  );
});

test('cancellation terminates the owned child tree', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentgate-process-'));
  const marker = join(directory, 'grandchild.pid');
  const abort = new AbortController();
  const parent = `const {spawn}=require('node:child_process');const fs=require('node:fs');const p=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});fs.writeFileSync(process.argv[1],String(p.pid));setInterval(()=>{},1000);`;
  const running = execute({
    command: process.execPath,
    args: ['-e', parent, marker],
    signal: abort.signal,
    timeoutMs: 10_000,
  });
  const rejected = assert.rejects(
    running,
    (error: unknown) => error instanceof ProcessError && error.kind === 'aborted',
  );
  let pid: number | undefined;
  try {
    for (let index = 0; index < 100; index++) {
      try {
        pid = Number(await readFile(marker, 'utf8'));
        break;
      } catch {
        await delay(20);
      }
    }
    assert.ok(pid);
    abort.abort();
    await rejected;
    let alive = true;
    for (let index = 0; index < 100 && alive; index++) {
      try {
        process.kill(pid, 0);
        await delay(20);
      } catch {
        alive = false;
      }
    }
    assert.equal(alive, false, 'The child process must not outlive cancellation.');
  } finally {
    abort.abort();
    await rm(directory, { recursive: true, force: true });
  }
});

test('spawn errors reject and arguments containing NUL are rejected', async () => {
  await assert.rejects(
    execute({ command: 'agentgate-missing-executable-987123', args: [] }),
    ProcessError,
  );
  await assert.rejects(resolveCommand(process.execPath, ['bad\0argument']), ProcessError);
});

test('executable resolution excludes cwd and relative PATH entries before spawning', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentgate-executable-'));
  const checkout = join(directory, 'checkout');
  const trusted = join(directory, 'trusted');
  await mkdir(checkout);
  await mkdir(trusted);
  const command = process.platform === 'win32' ? 'agentgate-fixture.exe' : 'agentgate-fixture';
  const installed = join(trusted, command);
  await writeFile(join(checkout, command), 'checkout trap');
  await writeFile(installed, 'trusted fixture');
  if (process.platform !== 'win32') await chmod(installed, 0o700);
  const unsafe = ['', '.', 'relative-bin', checkout].join(delimiter);
  try {
    const result = await resolveCommand(
      command,
      ['literal'],
      { PATH: `${unsafe}${delimiter}${trusted}` },
      checkout,
    );
    assert.equal(result.command, await realpath(installed));
    assert.deepEqual(result.args, ['literal']);
    await assert.rejects(
      resolveCommand(command, [], { PATH: unsafe }, checkout),
      /trusted absolute PATH/,
    );
    await assert.rejects(
      resolveCommand(
        `.${process.platform === 'win32' ? '\\' : '/'}${command}`,
        [],
        { PATH: trusted },
        checkout,
      ),
      /Relative command paths/,
    );
    assert.equal((await resolveCommand(installed, [], {}, checkout)).command, installed);

    const nodeName = basename(process.execPath);
    await writeFile(join(checkout, nodeName), 'untrusted non-executable trap');
    const executed = await execute({
      command: nodeName,
      args: ['-e', 'process.stdout.write("trusted node")'],
      cwd: checkout,
      env: { PATH: `${unsafe}${delimiter}${dirname(process.execPath)}` },
    });
    assert.equal(executed.exitCode, 0);
    assert.equal(executed.stdout, 'trusted node');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  'Windows npm uses the JavaScript entry point and batch scripts are rejected',
  { skip: process.platform !== 'win32' },
  async () => {
    const resolved = await resolveCommand('npm', ['--version']);
    assert.equal(resolved.command, process.execPath);
    assert.match(resolved.args[0]!, /npm-cli\.js$/);
    assert.deepEqual(resolved.args.slice(1), ['--version']);
    await assert.rejects(resolveCommand('arbitrary.cmd', []), ProcessError);
  },
);
