import { renameSync } from 'node:fs';
import { lstat, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

export const SUPERVISOR_EXIT = 200;
export const STARTUP_MS = 10_000;
export const STOP_MS = 7_000;
export const IdentitySchema = z.object({
  pid: z.number().int().positive(),
  startTime: z.string().regex(/^\d+$/),
});
export const RequestSchema = z.object({
  nonce: z.uuid(),
  unit: z.string().regex(/^agentgate-[0-9a-f-]{36}\.service$/),
  controller: IdentitySchema,
  command: z.string().min(1),
  args: z.array(z.string()),
  cwd: z.string().min(1),
  env: z.record(z.string(), z.string()),
});
export const ReadySchema = IdentitySchema.extend({ nonce: z.uuid() });
export const GoSchema = z.object({
  nonce: z.uuid(),
  invocationId: z.string().regex(/^[0-9a-f]{32}$/),
  controlGroup: z.string().startsWith('/'),
  mainPid: z.number().int().positive(),
});
export const ResultSchema = z.discriminatedUnion('kind', [
  z.object({
    nonce: z.uuid(),
    kind: z.literal('exit'),
    exitCode: z.number().int().min(0).max(255),
  }),
  z.object({ nonce: z.uuid(), kind: z.literal('failure'), reason: z.string().max(200) }),
]);
export type SupervisorRequest = z.infer<typeof RequestSchema>;
export type ProcessIdentity = z.infer<typeof IdentitySchema>;

/** The controller owns this directory; workers never receive its path or a read grant. */
export async function writeProtocol(
  directory: string,
  name: string,
  value: unknown,
): Promise<void> {
  const temporary = join(directory, `${name}.tmp`);
  await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
  await rename(temporary, join(directory, name));
}

/** Authorization has one synchronous commit point, after all asynchronous preparation. */
export async function publishGo(
  directory: string,
  value: unknown,
  cancelled: () => boolean,
): Promise<boolean> {
  const temporary = join(directory, 'go.json.tmp');
  await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
  if (cancelled()) return false;
  renameSync(temporary, join(directory, 'go.json'));
  return true;
}

export async function readProtocol<T>(path: string, schema: z.ZodType<T>): Promise<T | undefined> {
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 1024 * 1024)
      throw new Error('Invalid supervisor protocol file.');
    if (process.platform === 'linux' && (entry.uid !== process.getuid!() || entry.mode & 0o077))
      throw new Error('Supervisor protocol file has unsafe ownership or permissions.');
    return schema.parse(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function processIdentity(pid: number): Promise<ProcessIdentity | undefined> {
  try {
    const value = await readFile(`/proc/${pid}/stat`, 'utf8');
    if (!value.startsWith(`${pid} (`)) throw new Error('Invalid process identity.');
    const fields = value
      .slice(value.lastIndexOf(') ') + 2)
      .trim()
      .split(/\s+/);
    if (fields[0] === 'Z' || fields[0] === 'X') return undefined;
    return IdentitySchema.parse({ pid, startTime: fields[19] });
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      ['ENOENT', 'ESRCH'].includes(String(error.code))
    )
      return undefined;
    throw error;
  }
}
