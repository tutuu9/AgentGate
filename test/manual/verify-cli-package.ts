import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function verifyCliMetadata(entrypoint: string): Promise<void> {
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
    const env: NodeJS.ProcessEnv = {
      SystemRoot: process.env.SystemRoot,
      PATH: '',
      HOME: join(fixture, 'home'),
      USERPROFILE: join(fixture, 'home'),
      APPDATA: join(fixture, 'appdata'),
      LOCALAPPDATA: join(fixture, 'localappdata'),
      XDG_CONFIG_HOME: join(fixture, 'config'),
      XDG_STATE_HOME: join(fixture, 'state'),
      AGENTGATE_HOME: join(fixture, 'agentgate-home'),
      CODEX_HOME: join(fixture, 'codex-home'),
      GH_CONFIG_DIR: join(fixture, 'gh-home'),
      AGENTGATE_CODEX_PATH: join(fixture, 'missing-codex'),
      AGENTGATE_GH_PATH: join(fixture, 'missing-gh'),
    };
    for (const args of [['--version'], ['--help'], []]) {
      const result = spawnSync(process.execPath, [cliPath, ...args], {
        cwd: fixture,
        env,
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
  const entrypoint = process.argv[2];
  if (!entrypoint) throw new Error('Provide the AgentGate CLI entrypoint.');
  await verifyCliMetadata(entrypoint);
  process.stdout.write('CLI version and help match package metadata without creating state.\n');
}
