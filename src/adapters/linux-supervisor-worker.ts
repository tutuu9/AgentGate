import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  GoSchema,
  RequestSchema,
  STARTUP_MS,
  SUPERVISOR_EXIT,
  processIdentity,
  readProtocol,
  writeProtocol,
  type SupervisorRequest,
} from './linux-supervisor-protocol.ts';

async function controllerPresent(request: SupervisorRequest): Promise<boolean> {
  const identity = await processIdentity(request.controller.pid);
  return identity?.startTime === request.controller.startTime;
}

/** Trusted host-side process. Its exit causes systemd to kill every member of the unit. */
export async function runLinuxSupervisor(directory: string): Promise<never> {
  let nonce: string | undefined;
  let completion: Promise<never> | undefined;
  const finish = (
    result: { kind: 'exit'; exitCode: number } | { kind: 'failure'; reason: string },
  ) =>
    (completion ??= (async () => {
      try {
        if (nonce) await writeProtocol(directory, 'result.json', { nonce, ...result });
      } finally {
        // This reserved infrastructure failure retains the unit until controller verification.
        process.exit(SUPERVISOR_EXIT);
      }
    })());
  try {
    const request = await readProtocol(join(directory, 'request.json'), RequestSchema);
    if (!request) throw new Error('Missing supervisor request.');
    nonce = request.nonce;
    const identity = await processIdentity(process.pid);
    if (!identity) throw new Error('Cannot establish supervisor identity.');
    await writeProtocol(directory, 'ready.json', { nonce, ...identity });
    const deadline = Date.now() + STARTUP_MS;
    while (true) {
      if (!(await controllerPresent(request))) {
        await finish({ kind: 'failure', reason: 'controller-lost' });
        break;
      }
      const go = await readProtocol(join(directory, 'go.json'), GoSchema);
      if (go) {
        if (go.nonce !== nonce || go.mainPid !== process.pid)
          throw new Error('Invalid supervisor launch authorization.');
        const cgroups = await readFile('/proc/self/cgroup', 'utf8');
        if (!cgroups.split('\n').includes(`0::${go.controlGroup}`))
          throw new Error('Supervisor cgroup differs from the authorized unit.');
        break;
      }
      if (Date.now() >= deadline) {
        await finish({ kind: 'failure', reason: 'startup-timeout' });
        break;
      }
      await delay(25);
    }
    if (!(await controllerPresent(request))) {
      await finish({ kind: 'failure', reason: 'controller-lost' });
    } else {
      const child = spawn(request.command, request.args, {
        cwd: request.cwd,
        env: request.env,
        shell: false,
        stdio: 'inherit',
      });
      child.once('error', () => void finish({ kind: 'failure', reason: 'spawn' }));
      child.once(
        'exit',
        (code) =>
          void finish(
            code === null
              ? { kind: 'failure', reason: 'target-signal' }
              : { kind: 'exit', exitCode: code },
          ),
      );
      while (!completion) {
        await delay(100);
        if (!(await controllerPresent(request)))
          await finish({ kind: 'failure', reason: 'controller-lost' });
      }
      await completion;
    }
  } catch {
    await finish({ kind: 'failure', reason: 'supervisor-protocol' });
  }
  process.exit(SUPERVISOR_EXIT);
}
