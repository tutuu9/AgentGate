import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import test from 'node:test';
import { RunSchema, type Run } from '../src/core/contracts.ts';
import { buildPullRequestDraft } from '../src/core/publication.ts';
import {
  approvalFingerprint,
  assertWithinScope,
  cleanTerminal,
  isSensitivePath,
  redact,
  scrubForStorage,
} from '../src/core/safety.ts';

function run(): Run {
  return RunSchema.parse({
    schemaVersion: 1,
    id: randomUUID(),
    repo: {
      name: 'example',
      path: resolve('example'),
      fullName: 'owner/example',
      baseBranch: 'main',
      checks: [{ name: 'test', command: 'node', args: ['--test'] }],
    },
    issue: {
      url: 'https://github.com/owner/example/issues/1',
      number: 1,
      title: 'Fix greeting',
      body: 'Return the expected greeting',
    },
    baseCommit: 'a'.repeat(40),
    branch: 'agentgate/1',
    worktree: resolve('worktree'),
    status: 'awaiting_plan',
    createdAt: '2026-10-30T00:00:00Z',
    updatedAt: '2026-10-30T00:00:00Z',
    plan: {
      objective: 'Fix greeting',
      steps: ['Update greeting'],
      allowedPaths: ['src/'],
      acceptanceCriteria: ['Tests pass'],
      risks: [],
    },
  });
}

test('publication describes the approved objective after recovery from an infrastructure failure', () => {
  const recovered = run();
  recovered.implementationSummary =
    'No changes made: checks could not start before controller repair.';
  recovered.checks = [{ name: 'test', exitCode: 0, output: 'Tests passed', durationMs: 10 }];
  recovered.review = { summary: 'The change matches the approved plan.', findings: [] };

  const proposal = buildPullRequestDraft(recovered);

  assert.ok(proposal.body.includes('Fix greeting'));
  assert.ok(proposal.body.includes('- test: passed'));
  assert.ok(proposal.body.includes(recovered.review.summary));
  assert.ok(!proposal.body.includes(recovered.implementationSummary));
});

test('redaction masks recognizable credentials and explicitly configured values, not Git hashes', () => {
  const hash = 'a1b2c3d4'.repeat(5);
  const github = `ghp_${'x'.repeat(36)}`;
  const anthropic = `sk-ant-${'y'.repeat(40)}`;
  const text = `${github} ${anthropic} Bearer abc.def.ghi password="unsafe value" https://user:pass@example.com ${hash} custom-secret`;
  const output = redact(text, ['custom-secret']);
  assert.ok(output.includes(hash));
  for (const secret of [
    github,
    anthropic,
    'abc.def.ghi',
    'unsafe value',
    'user:pass',
    'custom-secret',
  ])
    assert.ok(!output.includes(secret));
});

test('sensitive environment values are redacted without exposing their names or values', () => {
  const name = 'AGENTGATE_TEST_SECRET';
  const previous = process.env[name];
  process.env[name] = 'fixture-sensitive-value';
  try {
    assert.equal(redact('prefix fixture-sensitive-value suffix'), 'prefix [REDACTED] suffix');
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
});

test('private key blocks and nested event credentials never reach serialized storage', () => {
  const event = {
    type: 'check.completed',
    output: '-----BEGIN PRIVATE KEY-----\nfixture-only\n-----END PRIVATE KEY-----',
    nested: {
      api_key: 'not-a-real-key',
      authorization: 'anything',
      raw_reasoning: 'private deliberation',
      tokenUsage: 42,
    },
    items: [{ access_token: 'private-session' }],
    hash: 'b'.repeat(40),
  };
  const output = JSON.stringify(scrubForStorage(event));
  for (const secret of [
    'fixture-only',
    'not-a-real-key',
    'anything',
    'private deliberation',
    'private-session',
  ])
    assert.ok(!output.includes(secret));
  assert.ok(output.includes('"tokenUsage":42'));
  assert.ok(output.includes('b'.repeat(40)));
  assert.deepEqual(scrubForStorage({ type: 'reasoning.delta', text: 'must not persist' }), {
    type: 'omitted',
    category: 'reasoning',
  });
});

test('storage rejects cycles and executable or non-JSON objects', () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => scrubForStorage(cyclic), /cycles/);
  assert.throws(() => scrubForStorage({ callback: () => true }), /JSON/);
  assert.throws(() => scrubForStorage(new Date()), /plain objects/);
});

test('terminal output cannot inject colors, links, cursor controls or bidi overrides', () => {
  const value =
    '\x1b[31mred\x1b[0m\x1b]8;;https://example.com\x07link\x1b]8;;\x07\r\nnext\b\u202ereversed';
  const output = cleanTerminal(value);
  assert.equal(output, 'redlink\nnextreversed');
  assert.ok(!output.includes('\x1b'));
  assert.equal(cleanTerminal(`ghp_${'x'.repeat(18)}\x1b[0m${'x'.repeat(18)}`), '[REDACTED]');
});

test('redaction handles structured text, JWTs and database URL passwords', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmaXh0dXJlIn0.fixtureSignature';
  const output = redact(
    `{"password":"private-value"} postgres://user:private-value@localhost ${jwt}`,
  );
  assert.ok(!output.includes('private-value'));
  assert.ok(!output.includes(jwt));
});

test('scope matching uses exact paths and directory boundaries', () => {
  assert.doesNotThrow(() =>
    assertWithinScope(
      [
        { path: 'src/main.ts', status: 'M' },
        { path: 'README.md', status: 'A' },
      ],
      ['src/', 'README.md'],
    ),
  );
  assert.throws(
    () => assertWithinScope([{ path: 'src-other/main.ts', status: 'M' }], ['src']),
    /outside/,
  );
  assert.throws(
    () => assertWithinScope([{ path: 'README.md.backup', status: 'M' }], ['README.md']),
    /outside/,
  );
  assert.throws(() => assertWithinScope([{ path: 'src/main.ts', status: 'M' }], []), /required/);
});

test('scope rejects traversal, absolute paths, shell-pattern paths and ambiguous separators', () => {
  for (const path of [
    '../outside',
    '/src/main.ts',
    'src/../secret',
    'src\\main.ts',
    'C:/src',
    'src//main.ts',
    'src/./main.ts',
    'src/*',
    'src/file\u0000.ts',
  ]) {
    assert.throws(() => assertWithinScope([{ path, status: 'M' }], ['src']), /repository-relative/);
    assert.throws(() => assertWithinScope([], [path]), /repository-relative/);
  }
});

test('publication exclusions identify secrets while allowing safe environment examples', () => {
  for (const path of [
    '.env',
    'src/.env.local',
    '.codex/auth.json',
    '.aws/credentials',
    '.ssh/id_ed25519',
    '.git/config',
    'keys/server.key',
    'credentials.json',
  ])
    assert.equal(isSensitivePath(path), true, path);
  for (const path of ['.env.example', 'docs/.env.example', 'src/auth.ts', 'README.md'])
    assert.equal(isSensitivePath(path), false, path);
});

test('approval binds scope, issue, repository, base, workspace and every check setting', () => {
  const original = run();
  const fingerprint = approvalFingerprint(original);
  const edits: Array<(candidate: Run) => void> = [
    (value) => {
      value.repo.fullName = 'another/repo';
    },
    (value) => {
      value.repo.path = resolve('another');
    },
    (value) => {
      value.repo.baseBranch = 'develop';
    },
    (value) => {
      value.baseCommit = 'c'.repeat(40);
    },
    (value) => {
      value.issue.url = 'https://github.com/owner/example/issues/2';
    },
    (value) => {
      value.issue.body = 'Changed scope';
    },
    (value) => {
      value.plan!.allowedPaths = ['test/'];
    },
    (value) => {
      value.plan!.steps.push('An extra step');
    },
    (value) => {
      value.repo.checks[0]!.args.push('--changed');
    },
    (value) => {
      value.repo.checks[0]!.timeoutMs = 100;
    },
    (value) => {
      value.worktree = resolve('elsewhere');
    },
    (value) => {
      value.branch = 'another-branch';
    },
  ];
  for (const edit of edits) {
    const candidate = structuredClone(original);
    edit(candidate);
    assert.notEqual(approvalFingerprint(candidate), fingerprint);
  }
  original.status = 'checking';
  original.updatedAt = '2026-10-31T00:00:00Z';
  original.checks = [{ name: 'test', exitCode: 0, output: 'passed', durationMs: 1 }];
  assert.equal(approvalFingerprint(original), fingerprint);
});

test('approval survives storage redaction and key-order differences', () => {
  const original = run();
  original.issue.body = `Example ghp_${'x'.repeat(36)}`;
  const persisted = RunSchema.parse(scrubForStorage(original));
  assert.equal(approvalFingerprint(original), approvalFingerprint(persisted));
  persisted.plan = {
    risks: [],
    acceptanceCriteria: ['Tests pass'],
    allowedPaths: ['src/'],
    steps: ['Update greeting'],
    objective: 'Fix greeting',
  };
  assert.equal(approvalFingerprint(original), approvalFingerprint(persisted));
  delete persisted.plan;
  assert.throws(() => approvalFingerprint(persisted), /plan is required/);
});
