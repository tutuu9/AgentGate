import assert from 'node:assert/strict';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export interface PackageTarget {
  entrypoint: string;
  installedPrefix?: string;
}

export function packageTarget(args: string[]): PackageTarget {
  if (args.length === 2 && args[0] === '--installed-prefix' && args[1]) {
    const installedPrefix = resolve(args[1]);
    return {
      entrypoint: join(installedPrefix, 'node_modules/agentgate/dist/cli/main.js'),
      installedPrefix,
    };
  }
  if (args.length === 1 && args[0]) return { entrypoint: resolve(args[0]) };
  throw new Error('Provide a CLI entrypoint or --installed-prefix <path>.');
}

export function isolatedEnvironment(fixture: string): NodeJS.ProcessEnv {
  return {
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
}

export function systemExecutable(name: 'cmd.exe' | 'taskkill.exe'): string {
  const root = process.env.SystemRoot;
  assert.ok(root && isAbsolute(root), 'Windows SystemRoot must be absolute.');
  return join(root, 'System32', name);
}

export function packageCommand(
  target: PackageTarget,
  args: string[],
  environment: NodeJS.ProcessEnv,
): {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  windowsVerbatimArguments?: boolean;
} {
  if (!target.installedPrefix) {
    return { command: process.execPath, args: [target.entrypoint, ...args], env: environment };
  }
  const launcher = join(
    target.installedPrefix,
    'node_modules/.bin',
    process.platform === 'win32' ? 'agentgate.cmd' : 'agentgate',
  );
  const env = { ...environment, PATH: dirname(process.execPath) };
  if (process.platform !== 'win32') return { command: launcher, args, env };

  // Only fixed smoke-test options enter cmd syntax; paths remain quoted environment data.
  assert.ok(args.every((argument) => /^[a-z0-9-]+$/.test(argument)));
  assert.ok(!/["\r\n\0]/.test(launcher));
  return {
    command: systemExecutable('cmd.exe'),
    args: ['/d', '/s', '/v:off', '/c', `""%AGENTGATE_PACKAGE_LAUNCHER%" ${args.join(' ')}"`],
    env: { ...env, AGENTGATE_PACKAGE_LAUNCHER: launcher },
    windowsVerbatimArguments: true,
  };
}
