import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isolatedEnvironment, packageCommand, packageTarget } from './package-command.ts';

export async function verifyCliMetadata(
  entrypoint: string,
  installedPrefix?: string,
): Promise<void> {
  const cliPath = resolve(entrypoint);
  const manifest: unknown = JSON.parse(
    await readFile(new URL('../../package.json', pathToFileURL(cliPath)), 'utf8'),
  );
  assert.ok(manifest && typeof manifest === 'object' && 'version' in manifest);
  assert.ok(typeof manifest.version === 'string' && manifest.version.length > 0);
  const version = manifest.version;
  const fixture = await mkdtemp(join(tmpdir(), 'agentgate-cli-package-'));
  try {
    await writeFile(
      join(fixture, 'package.json'),
      JSON.stringify({ name: 'unrelated-cwd', version: '0.0.0-unrelated-cwd' }),
    );
    const env = isolatedEnvironment(fixture);
    for (const args of [['--version'], ['--help'], []]) {
      const invocation = packageCommand({ entrypoint: cliPath, installedPrefix }, args, env);
      const result = spawnSync(invocation.command, invocation.args, {
        cwd: fixture,
        env: invocation.env,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        windowsHide: true,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10_000,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      if (args[0] === '--version') {
        assert.equal(result.stdout, `${version}\n`);
      } else {
        assert.ok(result.stdout.startsWith(`AgentGate ${version} — `));
        assert.match(result.stdout, /--version/);
      }
      assert.deepEqual(await readdir(fixture), ['package.json']);
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const target = packageTarget(process.argv.slice(2));
  await verifyCliMetadata(target.entrypoint, target.installedPrefix);
  process.stdout.write('CLI version and help match package metadata without creating state.\n');
}
