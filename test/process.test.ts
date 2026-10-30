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

test(
  'Linux pipe transport gives the command three FIFO descriptors',
  { skip: process.platform !== 'linux' },
  async () => {
    const result = await execute({
      command: process.execPath,
      args: [
        '-e',
        `const fs=require('node:fs');process.stdout.write(JSON.stringify([0,1,2].map(fd=>({fifo:fs.fstatSync(fd).isFIFO(),socket:fs.fstatSync(fd).isSocket()}))));`,
      ],
      linuxPipeTransport: true,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, '');
    assert.deepEqual(
      JSON.parse(result.stdout),
      Array.from({ length: 3 }, () => ({ fifo: true, socket: false })),
    );
  },
);

test(
  'Linux pipe transport preserves large stdin, separate outputs, literal argv, and exit status',
  { skip: process.platform !== 'linux' },
  async () => {
    const args = ['', ' spaced ', '$(echo unsafe); & | > < ` "\nUnicode: Тарас', '--flag=value'];
    const input = 'stdin Unicode Тарас; $(echo ignored)\n'.repeat(8192);
    const stdoutTail = 'o'.repeat(512 * 1024);
    const stderr = 'e'.repeat(768 * 1024);
    const result = await execute({
      command: process.execPath,
      args: [
        '-e',
        `process.stdout.write(JSON.stringify(process.argv.slice(1))+'\\n');
process.stderr.write('e'.repeat(768*1024));
const chunks=[];process.stdin.on('data',chunk=>chunks.push(chunk));
process.stdin.on('end',()=>{process.stdout.write(Buffer.concat(chunks));process.stdout.write('o'.repeat(512*1024));process.stderr.write('tail');process.exitCode=37;});`,
        ...args,
      ],
      input,
      timeoutMs: 10_000,
      linuxPipeTransport: true,
    });
    assert.equal(result.exitCode, 37);
    assert.equal(result.stdout, `${JSON.stringify(args)}\n${input}${stdoutTail}`);
    assert.equal(result.stderr, `${stderr}tail`);
  },
);

test(
  'Linux pipe transport ignores injected Bash startup files and shell options',
  { skip: process.platform !== 'linux' },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentgate-pipe-env-'));
    const startup = join(directory, 'startup.sh');
    const marker = join(directory, 'injected.txt');
    await writeFile(
      startup,
      'printf injected > "$AGENTGATE_INJECTION_MARKER"\nprintf unwanted-output\n',
    );
    try {
      const result = await execute({
        command: process.execPath,
        args: [
          '-e',
          'process.stdout.write(JSON.stringify({uid:process.getuid(),euid:process.geteuid()}));',
        ],
        env: {
          PATH: '/usr/bin:/bin',
          BASH_ENV: startup,
          ENV: startup,
          SHELLOPTS: 'xtrace',
          BASHOPTS: 'expand_aliases',
          'BASH_FUNC_wait%%':
            '() { printf injected > "$AGENTGATE_INJECTION_MARKER"; builtin wait "$@"; }',
          AGENTGATE_INJECTION_MARKER: marker,
        },
        linuxPipeTransport: true,
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.stderr, '');
      assert.deepEqual(JSON.parse(result.stdout), {
        uid: process.getuid!(),
        euid: process.geteuid!(),
      });
      await assert.rejects(
        readFile(marker),
        (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT',
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'Linux pipe transport preserves early child exit despite unread large input',
  { skip: process.platform !== 'linux' },
  async () => {
    const result = await execute({
      command: process.execPath,
      args: ['-e', 'process.stdin.destroy();process.stdout.write("early");process.exitCode=9;'],
      input: 'x'.repeat(2 * 1024 * 1024),
      timeoutMs: 10_000,
      maxOutputBytes: 1024,
      linuxPipeTransport: true,
    });
    assert.equal(result.exitCode, 9);
    assert.equal(result.stdout, 'early');
    assert.equal(result.stderr, '');
  },
);

async function linuxDescendantStopped(pid: number): Promise<boolean> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    // A killed orphan may await reaping by init; a zombie cannot execute or keep writing.
    return ['Z', 'X'].includes(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]!);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return true;
    throw error;
  }
}

for (const reason of ['output-limit', 'aborted', 'timeout'] as const) {
  test(
    `Linux pipe transport ${reason} stops the owned descendant`,
    { skip: process.platform !== 'linux' },
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'agentgate-pipe-stop-'));
      const marker = join(directory, 'heartbeat.json');
      const child = `const fs=require('node:fs');const [marker,reason]=process.argv.slice(1);let counter=0;
setInterval(()=>{fs.writeFileSync(marker,JSON.stringify({pid:process.pid,counter:++counter}));if(reason==='output-limit'&&counter===3){process.stdout.write('a'.repeat(2048));process.stderr.write('b'.repeat(2048));}},25);
setTimeout(()=>process.exit(0),30000);`;
      const parent = `const {spawn}=require('node:child_process');const [marker,reason,script]=process.argv.slice(1);
spawn(process.execPath,['-e',script,marker,reason],{shell:false,stdio:'inherit'});setTimeout(()=>process.exit(0),30000);`;
      const abort = new AbortController();
      const running = execute({
        command: process.execPath,
        args: ['-e', parent, marker, reason, child],
        signal: abort.signal,
        timeoutMs: reason === 'timeout' ? 2000 : 10_000,
        maxOutputBytes: reason === 'output-limit' ? 3000 : 8192,
        linuxPipeTransport: true,
      }).then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      let stopped = false;
      try {
        let pid: number | undefined;
        for (let index = 0; index < 200 && pid === undefined; index++) {
          try {
            const heartbeat = JSON.parse(await readFile(marker, 'utf8')) as {
              pid: number;
              counter: number;
            };
            if (Number.isSafeInteger(heartbeat.pid) && heartbeat.pid > 0 && heartbeat.counter >= 2)
              pid = heartbeat.pid;
          } catch (error) {
            if (
              !(error instanceof SyntaxError) &&
              !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
            )
              throw error;
          }
          if (pid === undefined) await delay(20);
        }
        assert.ok(pid, 'The descendant must be running before termination is tested.');
        if (reason === 'aborted') abort.abort();
        const outcome = await running;
        assert.ok('error' in outcome && outcome.error instanceof ProcessError);
        assert.equal(outcome.error.kind, reason);
        for (let index = 0; index < 100 && !stopped; index++) {
          stopped = await linuxDescendantStopped(pid);
          if (!stopped) await delay(20);
        }
        assert.ok(stopped, 'The descendant must stop before its safety self-exit.');
        const heartbeat = await readFile(marker, 'utf8');
        await delay(150);
        assert.equal(await readFile(marker, 'utf8'), heartbeat);
      } finally {
        abort.abort();
        await running;
        if (stopped) await rm(directory, { recursive: true, force: true });
      }
    },
  );
}
