import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isolatedEnvironment,
  packageCommand,
  packageTarget,
  systemExecutable,
} from './package-command.ts';

const target = packageTarget(process.argv.slice(2));
const home = await mkdtemp(join(tmpdir(), 'agentgate-web-package-'));
const invocation = packageCommand(target, ['web', '--port', '0'], isolatedEnvironment(home));
const child = spawn(invocation.command, invocation.args, {
  cwd: home,
  env: invocation.env,
  windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
const exited = once(child, 'close');
let serverUrl: URL | undefined;
try {
  const url = await new Promise<URL>((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(
      () => reject(new Error('Packaged web server did not start.')),
      15_000,
    );
    child.once('error', reject);
    child.once('close', () => {
      clearTimeout(timeout);
      reject(new Error('Packaged web server exited before readiness.'));
    });
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/#token=[A-Za-z0-9_-]+/);
      if (match) {
        clearTimeout(timeout);
        resolve(new URL(match[0]));
      }
    });
  });
  serverUrl = url;
  for (const path of ['/', '/app.js', '/app.css']) {
    const response = await fetch(new URL(path, url), { signal: AbortSignal.timeout(5_000) });
    assert.equal(response.status, 200, `Packaged asset ${path}`);
    assert.ok((await response.text()).length > 0);
  }
  const token = new URLSearchParams(url.hash.slice(1)).get('token');
  assert.ok(token);
  const state = await fetch(new URL('/api/state', url), {
    headers: { 'X-AgentGate-Token': token },
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(state.status, 200);
  const value = await state.json();
  assert.deepEqual(value.repos, []);
  assert.deepEqual(value.runs, []);
  assert.equal(value.busy, false);
  assert.equal(value.prompt, null);
  process.stdout.write(
    'Packaged web server, local assets, and authenticated empty state passed.\n',
  );
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    if (process.platform === 'win32' && target.installedPrefix && child.pid) {
      const stopped = spawnSync(
        systemExecutable('taskkill.exe'),
        ['/pid', String(child.pid), '/T', '/F'],
        { encoding: 'utf8', timeout: 10_000, windowsHide: true },
      );
      assert.ifError(stopped.error);
      assert.equal(stopped.status, 0, stopped.stderr);
    } else child.kill('SIGTERM');
  }
  const timeout = setTimeout(() => child.kill('SIGKILL'), 5_000);
  try {
    await exited;
  } finally {
    clearTimeout(timeout);
  }
  if (serverUrl) {
    await assert.rejects(
      fetch(new URL('/api/state', serverUrl), { signal: AbortSignal.timeout(2_000) }),
    );
  }
  await rm(home, { recursive: true, force: true });
}
