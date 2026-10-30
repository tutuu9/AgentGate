import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { test, type TestContext } from 'node:test';
import { GitHubCli } from '../src/adapters/github.ts';
import { execute, type ExecuteOptions, type ExecuteResult } from '../src/adapters/process.ts';
import { RunSchema, type RepoProfile, type Run } from '../src/core/contracts.ts';
import { TerminalInteraction } from '../src/cli/terminal.ts';
import { buildPullRequestDraft } from '../src/core/publication.ts';
import { cleanTerminal } from '../src/core/safety.ts';

const result = (stdout = '', exitCode = 0, stderr = ''): ExecuteResult => ({
  stdout,
  exitCode,
  stderr,
  durationMs: 0,
});

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'agentgate-github-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const home = join(root, 'home');
  await mkdir(source);
  const git = async (args: string[], cwd = source) => {
    const output = await execute({ command: 'git', args, cwd });
    assert.equal(output.exitCode, 0, `Fixture git ${args[0]} failed: ${output.stderr}`);
    return output.stdout.trim();
  };
  await git(['init', '-b', 'main']);
  await git(['config', 'user.name', 'AgentGate Test']);
  await git(['config', 'user.email', 'agentgate@example.invalid']);
  await git(['config', 'commit.gpgSign', 'false']);
  await git(['config', 'core.autocrlf', 'false']);
  await writeFile(join(source, 'README.md'), 'Initial content\n');
  await writeFile(join(source, '.gitignore'), '.env\nignored/\n');
  await git(['add', '.']);
  await git(['commit', '-m', 'test: initial fixture']);
  await git(['remote', 'add', 'origin', 'https://github.com/example/demo.git']);
  const base = await git(['rev-parse', 'HEAD']);
  const calls: ExecuteOptions[] = [];
  const network = {
    head: '',
    pushes: 0,
    creates: 0,
    draftError: '',
    crashAfterCreate: false,
    raceHead: '',
    requests: [] as Record<string, unknown>[],
    issue: {
      number: 7,
      title: 'Fix $(never execute) `a command`',
      body: 'Issue input is untrusted.',
      url: 'https://github.com/Example/Demo/issues/7',
    },
    permission: 'WRITE',
    archived: false,
  };
  const executor = async (options: ExecuteOptions): Promise<ExecuteResult> => {
    calls.push(options);
    const args = options.args;
    if (options.command === process.execPath) {
      if (args[0] === 'auth') return result();
      if (args[0] === 'repo')
        return result(
          JSON.stringify({
            nameWithOwner: 'Example/Demo',
            defaultBranchRef: { name: 'main' },
            viewerPermission: network.permission,
            isArchived: network.archived,
          }),
        );
      if (args[0] === 'issue') return result(JSON.stringify(network.issue));
      if (args[1] === 'list') return result(JSON.stringify(network.requests));
      if (args[1] === 'create') {
        network.creates++;
        if (network.draftError) return result('', 1, network.draftError);
        const branch = args[args.indexOf('--head') + 1];
        network.requests = [
          {
            url: 'https://github.com/Example/Demo/pull/12',
            headRefName: branch,
            baseRefName: 'main',
            headRefOid: network.head,
            isDraft: args.includes('--draft'),
            isCrossRepository: false,
            state: 'OPEN',
          },
        ];
        if (network.crashAfterCreate) {
          network.crashAfterCreate = false;
          return result('', 1, 'connection lost');
        }
        return result('https://github.com/Example/Demo/pull/12\n');
      }
      throw new Error('Unexpected fake gh command.');
    }
    if (args.includes('fetch')) {
      await writeFile(join(source, '.git', 'FETCH_HEAD'), `${base}\n`);
      return result();
    }
    if (args.includes('ls-remote'))
      return result(network.head ? `${network.head}\t${args.at(-1)}\n` : '');
    if (args.includes('push')) {
      network.pushes++;
      if (network.raceHead) network.head = network.raceHead;
      if (network.head) return result('', 1, 'stale info');
      const refspec = args.at(-1) ?? '';
      network.head = refspec.split(':')[0] ?? '';
      return result();
    }
    return execute(options);
  };
  const gateway = new GitHubCli({ home, ghPath: process.execPath, execute: executor });
  const repo: RepoProfile = {
    name: 'demo',
    path: source,
    fullName: 'Example/Demo',
    baseBranch: 'main',
    checks: [{ name: 'unit', command: 'node', args: ['--test'], timeoutMs: 600_000 }],
  };
  const id = randomUUID();
  const branch = `agentgate/issue-7-${id}`;
  const worktree = join(home, 'worktrees', id);
  return {
    root,
    source,
    home,
    base,
    calls,
    network,
    gateway,
    repo,
    worktree,
    branch,
    git,
    id,
    executor,
  };
}

async function candidate(f: Awaited<ReturnType<typeof fixture>>): Promise<Run> {
  await f.gateway.createWorktree(f.repo, f.worktree, f.branch, f.base);
  await writeFile(join(f.worktree, 'change.ts'), 'export const answer = 42;\n');
  const tree = await f.gateway.snapshot(f.worktree);
  const commit = await f.gateway.commit(f.worktree, tree, 'feat: make the approved change');
  return RunSchema.parse({
    schemaVersion: 1,
    id: f.id,
    repo: f.repo,
    issue: f.network.issue,
    baseCommit: f.base,
    branch: f.branch,
    worktree: f.worktree,
    status: 'publishing',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    checkedTree: tree,
    candidateCommit: commit,
    publicationApproval: commit,
  });
}

test('registration checks origin, canonical identity and write permission without exposing auth', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.gateway.identify(f.source), {
    fullName: 'Example/Demo',
    baseBranch: 'main',
  });
  f.network.permission = 'READ';
  await assert.rejects(f.gateway.identify(f.source), /write access/);
  await f.git(['remote', 'set-url', 'origin', 'https://token@github.com/example/demo.git']);
  await assert.rejects(f.gateway.identify(f.source), /without embedded credentials/);
  assert.ok(
    f.calls
      .filter((call) => call.command === process.execPath)
      .every(
        (call) =>
          !call.args.includes('--show-token') && !call.env?.GH_TOKEN && !call.env?.GITHUB_TOKEN,
      ),
  );
});

test('issue validation rejects PRs, other repositories, URL decorations and mismatching data', async (t) => {
  const f = await fixture(t);
  const issue = await f.gateway.issue('https://github.com/example/demo/issues/7', f.repo);
  assert.equal(issue.title, f.network.issue.title);
  const call = f.calls.find((entry) => entry.args[0] === 'issue');
  assert.ok(call);
  assert.equal(call.args[2], '7');
  for (const url of [
    'https://github.com/example/demo/pull/7',
    'https://github.com/other/demo/issues/7',
    'https://github.com/example/demo/issues/7?x=1',
    'https://github.com/example/demo/issues/0',
  ]) {
    await assert.rejects(f.gateway.issue(url, f.repo));
  }
  f.network.issue.number = 8;
  await assert.rejects(
    f.gateway.issue('https://github.com/example/demo/issues/7', f.repo),
    /different/,
  );
});

test('fetch pins the configured remote branch, independent of local dirty files', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.source, 'README.md'), 'Uncommitted user work\n');
  assert.equal(await f.gateway.baseCommit(f.repo), f.base);
  const call = f.calls.find((entry) => entry.args.includes('fetch'));
  assert.ok(call);
  assert.equal(call.args.at(-1), 'refs/heads/main');
  assert.ok(call.args.includes('https://github.com/Example/Demo.git'));
  await f.gateway.createWorktree(f.repo, f.worktree, f.branch, f.base);
  assert.equal(await readFile(join(f.worktree, 'README.md'), 'utf8'), 'Initial content\n');
  assert.equal(await readFile(join(f.source, 'README.md'), 'utf8'), 'Uncommitted user work\n');
});

test('owned worktree creation is idempotent and refuses different ownership', async (t) => {
  const f = await fixture(t);
  await f.gateway.createWorktree(f.repo, f.worktree, f.branch, f.base);
  await writeFile(join(f.worktree, 'pending.txt'), 'Unpublished work');
  await f.gateway.createWorktree(f.repo, f.worktree, f.branch, f.base);
  assert.equal(await readFile(join(f.worktree, 'pending.txt'), 'utf8'), 'Unpublished work');
  await assert.rejects(
    f.gateway.createWorktree(f.repo, f.worktree, `${f.branch}-other`, f.base),
    /ownership/,
  );
  await assert.rejects(
    f.gateway.createWorktree(f.repo, join(f.root, 'outside'), f.branch, f.base),
    /direct children/,
  );
});

test('snapshot includes new and binary files, deletions and modes while respecting ignored files', async (t) => {
  const f = await fixture(t);
  await f.gateway.createWorktree(f.repo, f.worktree, f.branch, f.base);
  await writeFile(join(f.worktree, 'new.ts'), 'export const added = true;\n');
  await writeFile(join(f.worktree, 'asset.bin'), Buffer.from([0, 1, 2, 3]));
  await writeFile(join(f.worktree, '.env'), 'SECRET=not-for-publication');
  await rm(join(f.worktree, 'README.md'));
  const tree = await f.gateway.snapshot(f.worktree);
  const changes = await f.gateway.changes(f.worktree, f.base);
  assert.deepEqual(changes, [
    { path: 'README.md', status: 'D' },
    { path: 'asset.bin', status: 'A' },
    { path: 'new.ts', status: 'A' },
  ]);
  assert.match(await f.gateway.diff(f.worktree, f.base), /Binary files/);
  assert.equal(
    await f.git(['ls-tree', '-r', '--name-only', tree], f.worktree),
    '.gitignore\nasset.bin\nnew.ts',
  );
  if (process.platform === 'win32') {
    await f.git(['config', 'core.fileMode', 'false']);
    await f.git(['update-index', '--chmod=+x', 'new.ts'], f.worktree);
  } else {
    await chmod(join(f.worktree, 'new.ts'), 0o755);
  }
  const executableTree = await f.gateway.snapshot(f.worktree);
  assert.notEqual(executableTree, tree);
  assert.match(
    await f.git(['ls-tree', executableTree, '--', 'new.ts'], f.worktree),
    /^100755 blob /,
  );
});

test('snapshot blocks sensitive files, secret values and executable Git filters before staging', async (t) => {
  const f = await fixture(t);
  await f.gateway.createWorktree(f.repo, f.worktree, f.branch, f.base);
  await writeFile(join(f.worktree, 'auth.json'), '{}');
  await assert.rejects(f.gateway.snapshot(f.worktree), /Sensitive file/);
  await rm(join(f.worktree, 'auth.json'));
  await writeFile(join(f.worktree, 'settings.txt'), `token=${'ghp_' + 'x'.repeat(36)}`);
  await assert.rejects(f.gateway.snapshot(f.worktree), /Potential secret/);
  await rm(join(f.worktree, 'settings.txt'));
  await f.git(['config', 'filter.test.clean', 'never-run-this']);
  await writeFile(join(f.worktree, '.gitattributes'), '*.txt filter=test\n');
  await writeFile(join(f.worktree, 'filtered.txt'), 'This filter must never execute.');
  await assert.rejects(f.gateway.snapshot(f.worktree), /Git filters/);
  await f.gateway.createWorktree(
    f.repo,
    join(f.home, 'worktrees', randomUUID()),
    'agentgate/no-active-filter',
    f.base,
  );
});

test('commit preserves exactly the checked tree and rejects later edits', async (t) => {
  const f = await fixture(t);
  const run = await candidate(f);
  assert.equal(
    await f.git(['rev-parse', `${run.candidateCommit}^{tree}`], f.worktree),
    run.checkedTree,
  );
  await f.gateway.verifyCommit(f.worktree, run.candidateCommit!, run.checkedTree!);
  await writeFile(join(f.worktree, 'late.txt'), 'Unexpected edit');
  await assert.rejects(
    f.gateway.verifyCommit(f.worktree, run.candidateCommit!, run.checkedTree!),
    /no longer match/,
  );
  await assert.rejects(
    f.gateway.commit(f.worktree, run.checkedTree!, 'Do not commit'),
    /changed since/,
  );
});

test('all controller Git mutations disable repository hooks', async (t) => {
  const f = await fixture(t);
  const hooks = join(f.source, '.git', 'hooks');
  const marker = join(f.root, 'hook-ran');
  const script = `#!/bin/sh\necho hook > '${marker.replaceAll('\\', '/')}'\nexit 1\n`;
  for (const name of ['post-checkout', 'pre-commit', 'commit-msg', 'post-commit', 'pre-push']) {
    await writeFile(join(hooks, name), script, { mode: 0o755 });
  }
  const run = await candidate(f);
  await f.gateway.publish(run, true);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  for (const call of f.calls.filter((entry) => entry.command === 'git')) {
    assert.ok(call.args.some((arg) => arg.startsWith('core.hooksPath=')));
  }
});

test('publication pushes an absent branch once and creates an explicit draft without implicit push', async (t) => {
  const f = await fixture(t);
  const run = await candidate(f);
  const publication = await f.gateway.publish(run, true);
  assert.deepEqual(publication, {
    kind: 'published',
    url: 'https://github.com/Example/Demo/pull/12',
  });
  assert.equal(f.network.head, run.candidateCommit);
  const push = f.calls.find((entry) => entry.args.includes('push'));
  assert.ok(push?.args.includes(`--force-with-lease=refs/heads/${run.branch}:`));
  assert.ok(!push?.args.includes('--force'));
  const create = f.calls.find((entry) => entry.args[0] === 'pr' && entry.args[1] === 'create');
  assert.ok(create?.args.includes('--head'));
  assert.ok(create?.args.includes('--draft'));
  assert.ok(!create?.args.includes('--dry-run'));
  assert.ok(create?.args.includes(run.issue.title));
  await f.gateway.publish(run, true);
  assert.equal(f.network.pushes, 1);
  assert.equal(f.network.creates, 1);
});

test('publication never overwrites an existing ancestor branch or a concurrent branch creation', async (t) => {
  const f = await fixture(t);
  const run = await candidate(f);
  f.network.head = f.base;
  await assert.rejects(f.gateway.publish(run, true), /will not be overwritten/);
  assert.equal(f.network.pushes, 0);
  assert.equal(f.network.head, f.base);
  f.network.head = '';
  f.network.raceHead = f.base;
  await assert.rejects(f.gateway.publish(run, true), /Git push failed/);
  assert.equal(f.network.head, f.base);
  assert.equal(f.network.creates, 0);
});

test('partial publication recovery finds an existing PR instead of duplicating it', async (t) => {
  const f = await fixture(t);
  const run = await candidate(f);
  f.network.crashAfterCreate = true;
  await assert.rejects(f.gateway.publish(run, true), /Resume/);
  assert.equal((await f.gateway.publish(run, true)).kind, 'published');
  assert.equal(f.network.pushes, 1);
  assert.equal(f.network.creates, 1);
});

test('absent-only lease creates a real bare Git ref and rejects a concurrent ancestor ref', async (t) => {
  const f = await fixture(t);
  const run = await candidate(f);
  const bare = join(f.root, 'remote.git');
  await f.git(['init', '--bare', bare]);
  await f.git([
    '-c',
    'tag.gpgSign=false',
    'tag',
    '-a',
    'unrelated-tag',
    '-m',
    'Do not publish this tag',
  ]);
  await f.git(['config', 'push.followTags', 'true']);
  let injectRace = false;
  let pushes = 0;
  const localTransport = async (options: ExecuteOptions): Promise<ExecuteResult> => {
    if (
      options.command === 'git' &&
      (options.args.includes('ls-remote') || options.args.includes('push'))
    ) {
      if (options.args.includes('push')) {
        pushes++;
        if (injectRace) {
          const ref = options.args.at(-1)?.split(':')[1];
          assert.ok(ref);
          await f.git(['push', bare, `${f.base}:${ref}`]);
        }
      }
      return execute({
        ...options,
        args: [
          '-c',
          'protocol.file.allow=always',
          ...options.args.map((argument) =>
            argument === 'https://github.com/Example/Demo.git' ? bare : argument,
          ),
        ],
      });
    }
    return f.executor(options);
  };
  const gateway = new GitHubCli({
    home: f.home,
    ghPath: process.execPath,
    execute: localTransport,
  });
  await gateway.publish(run, true);
  assert.equal(await f.git(['ls-remote', '--tags', bare]), '');
  assert.match(
    await f.git(['ls-remote', bare, `refs/heads/${run.branch}`]),
    new RegExp(`^${run.candidateCommit}\\s`),
  );
  const id = randomUUID();
  const race = await candidate({
    ...f,
    id,
    branch: `${f.branch}-race`,
    worktree: join(f.home, 'worktrees', id),
  });
  f.network.requests = [];
  injectRace = true;
  await assert.rejects(gateway.publish(race, true), /Git push failed/);
  assert.match(
    await f.git(['ls-remote', bare, `refs/heads/${race.branch}`]),
    new RegExp(`^${f.base}\\s`),
  );
  await assert.rejects(gateway.publish(race, true), /will not be overwritten/);
  assert.equal(pushes, 2);
});

test('controller refuses Git URL rewriting before attempting publication', async (t) => {
  const f = await fixture(t);
  const run = await candidate(f);
  await f.git(['config', 'url.https://example.invalid/.insteadOf', 'https://github.com/']);
  await assert.rejects(f.gateway.publish(run, true), /URL rewriting/);
  assert.equal(f.network.pushes, 0);
  assert.equal(f.network.creates, 0);
});

test('publication preview matches the exact sanitized title and body sent to GitHub', async (t) => {
  const f = await fixture(t);
  const run = await candidate(f);
  run.issue.title = '\u001b[31mFix display\u001b[0m';
  run.implementationSummary = `Implemented the change. Token: ${'ghp_' + 'x'.repeat(36)}`;
  run.review = { summary: '\u202eChecked the source', findings: [] };
  const displayed: string[] = [];
  class Preview extends TerminalInteraction {
    override show(value: string): void {
      displayed.push(cleanTerminal(value));
    }
    override async confirm(): Promise<boolean> {
      return true;
    }
  }
  const ui = new Preview();
  t.after(() => ui.close());
  assert.equal(await ui.approvePublication(run, 'approved diff'), true);
  const proposal = buildPullRequestDraft(run);
  assert.ok(
    displayed.includes(
      `Pull request title:\n${proposal.title}\n\nPull request body:\n${proposal.body}`,
    ),
  );
  assert.ok(proposal.body.includes('[REDACTED]'));
  assert.ok(!proposal.title.includes('\u001b'));
  await f.gateway.publish(run, true);
  const create = f.calls.find(
    (call) => call.command === process.execPath && call.args[1] === 'create',
  );
  assert.ok(create);
  assert.equal(create.args[create.args.indexOf('--title') + 1], proposal.title);
  assert.equal(create.input, proposal.body);
  displayed.length = 0;
  assert.equal(await ui.approveOrdinaryPr(run), true);
  assert.ok(
    displayed.includes(
      `Pull request title:\n${proposal.title}\n\nPull request body:\n${proposal.body}`,
    ),
  );
});

test('abort before or during remote preflight prevents push and PR creation', async (t) => {
  const f = await fixture(t);
  const run = await candidate(f);
  const cancelled = new AbortController();
  cancelled.abort(new Error('Stop publication'));
  const before = f.calls.length;
  await assert.rejects(f.gateway.publish(run, true, cancelled.signal), /Stop publication/);
  assert.equal(f.calls.length, before);
  for (const stage of ['ls-remote', 'list']) {
    const controller = new AbortController();
    const gateway = new GitHubCli({
      home: f.home,
      ghPath: process.execPath,
      execute: async (options) => {
        if (options.args.includes(stage)) {
          assert.equal(options.signal, controller.signal);
          controller.abort(new Error(`Stop during ${stage}`));
        }
        return f.executor(options);
      },
    });
    await assert.rejects(gateway.publish(run, true, controller.signal), /Stop during/);
  }
  assert.equal(f.network.pushes, 0);
  assert.equal(f.network.creates, 0);
});

test('publication rejects approval for a different commit before any repository or remote command', async (t) => {
  const f = await fixture(t);
  const run = await candidate(f);
  const before = f.calls.length;
  await assert.rejects(
    f.gateway.publish({ ...run, publicationApproval: f.base }, true),
    /exact commit approval/,
  );
  assert.equal(f.calls.length, before);
  assert.equal(f.network.pushes, 0);
  assert.equal(f.network.creates, 0);
});

test('credential helper resolves a bare executable outside the worktree before Git runs it', async (t) => {
  const f = await fixture(t);
  const run = await candidate(f);
  const executable = basename(process.execPath);
  await writeFile(join(f.worktree, executable), 'This repository executable must not run.', {
    mode: 0o700,
  });
  await writeFile(join(f.source, '.git', 'info', 'exclude'), `${executable}\n`);
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  const original = process.env[pathKey];
  process.env[pathKey] = [f.worktree, dirname(process.execPath), original ?? ''].join(delimiter);
  try {
    const gateway = new GitHubCli({
      home: f.home,
      ghPath: executable,
      execute: (options) =>
        f.executor(
          options.command === executable ? { ...options, command: process.execPath } : options,
        ),
    });
    await gateway.publish(run, true);
    const script = await readFile(join(f.home, 'controller', 'github-credential.cjs'), 'utf8');
    let launched: string | undefined;
    runInNewContext(script, {
      require: (name: string) => {
        assert.equal(name, 'node:child_process');
        return {
          spawnSync: (command: string, args: string[], options: { shell: boolean }) => {
            launched = command;
            assert.deepEqual(Array.from(args), ['auth', 'git-credential', 'get']);
            assert.equal(options.shell, false);
            return { status: 0 };
          },
        };
      },
      process: {
        argv: [process.execPath, 'helper', 'get'],
        exit: (code: number) => assert.equal(code, 0),
      },
    });
    assert.ok(launched);
    assert.equal(await realpath(launched), await realpath(process.execPath));
    assert.notEqual(launched, executable);
    assert.equal(f.network.pushes, 1);
  } finally {
    if (original === undefined) delete process.env[pathKey];
    else process.env[pathKey] = original;
  }
});

test('only an explicit unsupported-draft response offers separately approved ordinary PR fallback', async (t) => {
  const f = await fixture(t);
  const run = await candidate(f);
  f.network.draftError = 'GraphQL: Draft pull requests are not supported in this repository.';
  assert.deepEqual(await f.gateway.publish(run, true), { kind: 'draft-unavailable' });
  await assert.rejects(f.gateway.publish(run, false), /separate approval/);
  f.network.draftError = 'Token does not have permission to create a draft pull request';
  await assert.rejects(f.gateway.publish(run, true), /creation failed/);
  f.network.draftError = '';
  run.ordinaryPrApproved = true;
  assert.equal((await f.gateway.publish(run, false)).kind, 'published');
  assert.equal(f.network.pushes, 1);
});

test('cleanup refuses unpublished edits and keeps the published topic branch', async (t) => {
  const f = await fixture(t);
  const run = await candidate(f);
  await assert.rejects(f.gateway.cleanup(run), /Unpublished work/);
  run.status = 'completed';
  run.prUrl = 'https://github.com/Example/Demo/pull/12';
  await writeFile(join(f.worktree, 'keep.txt'), 'Unpublished');
  await assert.rejects(f.gateway.cleanup(run), /unpublished changes/);
  await rm(join(f.worktree, 'keep.txt'));
  await f.gateway.cleanup(run);
  assert.equal(await f.git(['rev-parse', `refs/heads/${f.branch}`]), run.candidateCommit);
  await assert.rejects(readFile(join(f.worktree, 'change.ts')), { code: 'ENOENT' });
  await assert.rejects(f.gateway.cleanup({ ...run, worktree: f.source }), /direct children/);
});
