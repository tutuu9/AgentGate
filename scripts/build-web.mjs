import { copyFile, mkdir } from 'node:fs/promises';

const output = new URL('../dist/web/public/', import.meta.url);
await mkdir(output, { recursive: true });
for (const name of ['index.html', 'app.css', 'app.js']) {
  await copyFile(new URL(`../src/web/public/${name}`, import.meta.url), new URL(name, output));
}
