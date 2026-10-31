import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { RepoSchema, RunSchema, type RepoProfile, type Run } from './contracts.ts';
import { scrubForStorage } from './safety.ts';

const LockSchema = z.object({
  pid: z.number().int().positive(),
  nonce: z.string().uuid(),
  createdAt: z.string(),
});
type LockRecord = z.infer<typeof LockSchema>;
const directories = ['repos', 'runs', 'events', 'worktrees'] as const;

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error ? String(error.code) : undefined;
}

function runId(id: string): string {
  if (!z.string().uuid().safeParse(id).success) throw new Error('Invalid run identifier');
  return id.toLowerCase();
}

function repoName(name: string): string {
  if (
    !RepoSchema.shape.name.safeParse(name).success ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)
  ) {
    throw new Error('Invalid repository name');
  }
  return name.toLowerCase();
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function within(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}

export class FileRunStore {
  readonly home: string;
  private root: string | undefined;
  private readonly fileOperations = new Map<string, Promise<void>>();

  constructor(home: string) {
    this.home = resolve(home);
    if (samePath(this.home, parse(this.home).root))
      throw new Error('Storage home cannot be a filesystem root');
  }

  async init(): Promise<void> {
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    const info = await lstat(this.home);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error('Storage home must be a real directory');
    const root = await realpath(this.home);
    if (this.root && !samePath(root, this.root))
      throw new Error('Storage home changed its location');
    this.root = root;
    if (process.platform !== 'win32') await chmod(this.home, 0o700);
    for (const directory of directories) {
      const path = join(this.home, directory);
      await mkdir(path, { recursive: true, mode: 0o700 });
      await this.assertDirectory(path);
      if (process.platform !== 'win32') await chmod(path, 0o700);
    }
  }

  async saveRepo(repo: RepoProfile): Promise<void> {
    const value = RepoSchema.parse(scrubForStorage(RepoSchema.parse(repo)));
    await this.writeJson(
      await this.path('repos', `${repoName(value.name)}.json`),
      value,
      RepoSchema,
    );
  }

  async getRepo(name: string): Promise<RepoProfile> {
    const key = repoName(name);
    const value = await this.readJson(await this.path('repos', `${key}.json`), RepoSchema);
    if (repoName(value.name) !== key)
      throw new Error('Stored repository identity does not match its filename');
    return value;
  }

  async listRepos(): Promise<RepoProfile[]> {
    const names = await this.list('repos');
    return Promise.all(names.map((name) => this.getRepo(name)));
  }

  async saveRun(run: Run): Promise<void> {
    const value = RunSchema.parse(scrubForStorage(RunSchema.parse(run)));
    await this.writeJson(await this.path('runs', `${runId(value.id)}.json`), value, RunSchema);
  }

  async getRun(id: string): Promise<Run> {
    const key = runId(id);
    const value = await this.readJson(await this.path('runs', `${key}.json`), RunSchema);
    if (runId(value.id) !== key) throw new Error('Stored run identity does not match its filename');
    return value;
  }

  async listRuns(): Promise<Run[]> {
    const names = await this.list('runs');
    const runs = await Promise.all(names.map((name) => this.getRun(name)));
    return runs.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async appendEvent(id: string, event: Record<string, unknown>): Promise<void> {
    const key = runId(id);
    await this.getRun(key);
    const value = z.record(z.string(), z.unknown()).parse(scrubForStorage(event));
    const content = `${JSON.stringify({ ...value, timestamp: new Date().toISOString() })}\n`;
    const path = await this.path('events', `${key}.jsonl`);
    await this.assertFile(path, true);
    const file = await open(
      path,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      await this.assertOpenFile(path, file);
      if (process.platform !== 'win32') await file.chmod(0o600);
      await file.writeFile(content, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
  }

  async acquireLock(): Promise<() => Promise<void>> {
    await this.ready();
    const path = join(this.home, 'run.lock');
    try {
      return await this.createLease(path);
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
    }
    let record: LockRecord;
    try {
      record = await this.readJson(path, LockSchema);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return await this.createLease(path);
      throw error;
    }
    if (this.processExists(record.pid))
      throw new Error(`Another AgentGate process holds the run lock (PID ${record.pid})`);
    throw new Error(
      `Stale run lock from PID ${record.pid}. A worker or check may still be running. ` +
        'Verify that its entire process tree has stopped or restart the machine, back up the state, ' +
        `then explicitly remove only ${path} before resuming. No run or worktree was removed.`,
    );
  }

  async deleteRun(id: string): Promise<void> {
    const key = runId(id);
    await this.getRun(key);
    const events = await this.path('events', `${key}.jsonl`);
    if (await this.assertFile(events, true)) await unlink(events);
    const run = await this.path('runs', `${key}.json`);
    await this.assertFile(run);
    await unlink(run);
  }

  private async ready(): Promise<void> {
    if (!this.root) await this.init();
    await this.assertDirectory(this.home);
  }

  private async path(directory: (typeof directories)[number], name: string): Promise<string> {
    await this.ready();
    const parent = join(this.home, directory);
    await this.assertDirectory(parent);
    const path = join(parent, name);
    if (!within(parent, path) || dirname(path) !== parent)
      throw new Error('Storage path escaped its directory');
    return path;
  }

  private async assertDirectory(path: string): Promise<void> {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error('Storage directory must not be a symlink or special file');
    const canonical = await realpath(path);
    const expected = resolve(this.root ?? this.home, relative(this.home, path));
    if (!samePath(canonical, expected) || !within(this.root ?? this.home, canonical)) {
      throw new Error('Storage directory escaped its original location');
    }
  }

  private async assertFile(path: string, missingAllowed = false): Promise<boolean> {
    await this.assertDirectory(dirname(path));
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
        throw new Error('Storage files must not be links or special files');
      return true;
    } catch (error) {
      if (missingAllowed && errorCode(error) === 'ENOENT') return false;
      throw error;
    }
  }

  private async assertOpenFile(
    path: string,
    file: Awaited<ReturnType<typeof open>>,
  ): Promise<void> {
    await this.assertFile(path);
    const [opened, current] = await Promise.all([file.stat(), lstat(path)]);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.ino !== current.ino ||
      opened.dev !== current.dev
    ) {
      throw new Error('Storage file changed while opening it');
    }
  }

  private async readJson<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    return this.withFile(path, () => this.readJsonUnlocked(path, schema));
  }

  private async readJsonUnlocked<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    await this.assertFile(path);
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let text: string;
    try {
      await this.assertOpenFile(path, file);
      text = await file.readFile('utf8');
    } finally {
      await file.close();
    }
    try {
      return schema.parse(JSON.parse(text));
    } catch {
      throw new Error(
        'Stored data is invalid; preserve it and recover explicitly instead of resetting it',
      );
    }
  }

  private async writeJson<T>(path: string, value: T, schema: z.ZodType<T>): Promise<void> {
    return this.withFile(path, () => this.writeJsonUnlocked(path, value, schema));
  }

  private async writeJsonUnlocked<T>(path: string, value: T, schema: z.ZodType<T>): Promise<void> {
    if (await this.assertFile(path, true)) await this.readJsonUnlocked(path, schema);
    const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
    const file = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      try {
        await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
        await file.sync();
      } finally {
        await file.close();
      }
      await this.replaceFile(temporary, path);
    } catch (error) {
      await this.assertDirectory(dirname(temporary));
      await unlink(temporary).catch((cleanupError: unknown) => {
        if (errorCode(cleanupError) !== 'ENOENT') throw cleanupError;
      });
      throw error;
    }
  }

  /** Polling readers must close their handles before an atomic replacement on Windows. */
  private async withFile<T>(path: string, action: () => Promise<T>): Promise<T> {
    const key = process.platform === 'win32' ? path.toLowerCase() : path;
    const previous = this.fileOperations.get(key) ?? Promise.resolve();
    const operation = previous.then(action);
    const completed = operation.then(
      () => undefined,
      () => undefined,
    );
    this.fileOperations.set(key, completed);
    try {
      return await operation;
    } finally {
      if (this.fileOperations.get(key) === completed) this.fileOperations.delete(key);
    }
  }

  private async replaceFile(temporary: string, path: string): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      // A separate CLI reader can briefly hold a Windows handle despite our local queue.
      // Revalidate the destination on each retry; an invalid boundary is never retried.
      await this.assertFile(path, true);
      try {
        await rename(temporary, path);
        return;
      } catch (error) {
        if (
          process.platform !== 'win32' ||
          !['EPERM', 'EACCES'].includes(errorCode(error) ?? '') ||
          attempt >= 7
        ) {
          throw error;
        }
        await delay(10 * 2 ** attempt);
      }
    }
  }

  private async list(directory: 'repos' | 'runs'): Promise<string[]> {
    await this.ready();
    const path = join(this.home, directory);
    await this.assertDirectory(path);
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .filter((entry) => entry.name.endsWith('.json'))
      .map((entry) => entry.name.slice(0, -5))
      .sort();
  }

  private processExists(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if (errorCode(error) === 'ESRCH') return false;
      if (errorCode(error) === 'EPERM') return true;
      throw new Error('Cannot establish whether the lock owner is alive', { cause: error });
    }
  }

  private async createLease(path: string): Promise<() => Promise<void>> {
    await this.assertFile(path, true);
    const record: LockRecord = {
      pid: process.pid,
      nonce: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    const file = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      await file.writeFile(JSON.stringify(record), 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    let released = false;
    return async () => {
      if (released) return;
      await this.ready();
      const current = await this.readJson(path, LockSchema);
      if (current.nonce !== record.nonce || current.pid !== record.pid)
        throw new Error('Lock ownership changed; refusing to release it');
      await this.assertFile(path);
      await unlink(path);
      released = true;
    };
  }
}
