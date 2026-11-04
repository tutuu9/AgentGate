import { lstat, realpath, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';

const project = await realpath(new URL('../', import.meta.url));
const output = join(project, 'dist');
const entry = await lstat(output).catch((error) => {
  if (error.code === 'ENOENT') return undefined;
  throw error;
});

if (entry) {
  const target = await realpath(output);
  if (!entry.isDirectory() || entry.isSymbolicLink() || relative(project, target) !== 'dist') {
    throw new Error("Refusing to clean dist: expected this project's build-output directory.");
  }
  await rm(target, { recursive: true });
}
