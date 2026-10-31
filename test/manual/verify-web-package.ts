import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const entrypoint = process.argv[2];
if (!entrypoint) throw new Error('Provide the installed AgentGate CLI entrypoint.');
const home = await mkdtemp(join(tmpdir(), 'agentgate-web-package-'));
const child = spawn(process.execPath, [resolve(entrypoint), 'web', '--port', '0', '--home', home], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
const exited = once(child, 'close');
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
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  const timeout = setTimeout(() => child.kill('SIGKILL'), 5_000);
  try {
    await exited;
  } finally {
    clearTimeout(timeout);
  }
  await rm(home, { recursive: true, force: true });
}
