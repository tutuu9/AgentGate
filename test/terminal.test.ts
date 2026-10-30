import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

// Use readline's real terminal-mode byte parser in a separate process. No private reader
// access or model calls; native PTY cancellation remains a separate acceptance check.
const interruptFixture = `
process.stdout.isTTY = true;
const { TerminalInteraction } = await import(process.argv[1]);
const abort = new AbortController();
let interrupts = 0;
const ui = new TerminalInteraction(abort.signal, () => {
  interrupts += 1;
  abort.abort(new Error('Cancelled by the user.'));
});
const deadline = setTimeout(() => {
  process.stderr.write('The first Ctrl+C did not cancel the operation.\\n');
  process.exitCode = 1;
  ui.close();
}, 2000);
try {
  if (process.argv[2] === 'prompt') {
    try {
      await ui.confirm('Approve publication?');
      throw new Error('Cancelled input must never resolve as an approval answer.');
    } catch (error) {
      if (error.name !== 'AbortError') throw error;
    }
  } else {
    await new Promise(resolve => abort.signal.addEventListener('abort', resolve, { once: true }));
  }
  process.stdout.write('RESULT=' + JSON.stringify({ aborted: abort.signal.aborted, interrupts }) + '\\n');
} finally {
  clearTimeout(deadline);
  ui.close();
}
`;

for (const mode of ['prompt', 'worker']) {
  test(`one terminal-mode Ctrl+C cancels ${mode === 'prompt' ? 'an approval prompt' : 'work between prompts'}`, () => {
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        interruptFixture,
        new URL('../src/cli/terminal.ts', import.meta.url).href,
        mode,
      ],
      { encoding: 'utf8', input: '\u0003', timeout: 5000 },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /RESULT=\{"aborted":true,"interrupts":1\}/);
  });
}
