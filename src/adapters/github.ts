import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import {
  IssueSchema,
  type GitHubGateway,
  type Issue,
  type RepoProfile,
  type Run,
} from '../core/contracts.ts';
import { execute, resolveCommand, type ExecuteResult, type Executor } from './process.ts';
import { buildPullRequestDraft } from '../core/publication.ts';

const ObjectId = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const Repository = z.object({
  nameWithOwner: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  defaultBranchRef: z.object({ name: z.string().min(1) }),
  viewerPermission: z.enum(['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ']),
  isArchived: z.boolean(),
});
const Ownership = z.object({
  repo: z.string(),
  path: z.string(),
  branch: z.string(),
  baseCommit: ObjectId,
});
const PullRequest = z.object({
  url: z.string(),
  headRefName: z.string(),
  baseRefName: z.string(),
  headRefOid: ObjectId,
  isDraft: z.boolean(),
  isCrossRepository: z.boolean(),
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
});
type Owner = z.infer<typeof Ownership>;

export interface GitHubCliOptions {
  home: string;
  gitPath?: string;
  ghPath?: string;
  execute?: Executor;
}

function validatedJson<T>(value: string, schema: z.ZodType<T>, label: string): T {
  try {
    return schema.parse(JSON.parse(value));
  } catch {
    throw new Error(`Invalid ${label} returned by GitHub or local storage.`);
  }
}

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function canonicalRemote(value: string): string {
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i.exec(
      value.trim(),
    );
  if (!match?.[1] || match[1].split('/').some((part) => part === '.' || part === '..')) {
    throw new Error(
      'Origin must be an HTTPS or SSH repository on github.com, without embedded credentials.',
    );
  }
  return match[1];
}

function githubUrl(repo: RepoProfile): string {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo.fullName)) throw new Error('Invalid GitHub repository.');
  return `https://github.com/${repo.fullName}.git`;
}

function issueNumber(value: string, fullName: string): number {
  const match = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/([1-9][0-9]*)$/i.exec(value);
  if (match?.[1]?.toLowerCase() !== fullName.toLowerCase()) {
    throw new Error('Use an exact github.com issue URL belonging to the registered repository.');
  }
  const number = Number(match[2]);
  if (!Number.isSafeInteger(number)) throw new Error('Invalid issue number.');
  return number;
}

function pullRequestUrl(value: string, fullName: string): string {
  const match = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9][0-9]*)$/i.exec(
    value.trim(),
  );
  if (match?.[1]?.toLowerCase() !== fullName.toLowerCase())
    throw new Error('Invalid pull request URL.');
  return value.trim();
}

function controllerEnvironment(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !/^GIT_/i.test(key) &&
        !/^(?:GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|GH_REPO|GH_HOST|GH_DEBUG|GH_FORCE_TTY|SSH_ASKPASS|SSH_ASKPASS_REQUIRE)$/i.test(
          key,
        ),
    ),
  );
  return {
    ...env,
    GH_HOST: 'github.com',
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    NO_COLOR: '1',
  };
}

function sensitivePath(path: string): boolean {
  return (
    (/(?:^|\/)(?:\.env(?:\.[^/]*)?|auth\.json|credentials(?:\.json)?|id_(?:rsa|dsa|ecdsa|ed25519)|[^/]+\.(?:pem|p12|pfx|key))$/i.test(
      path,
    ) &&
      !/(?:^|\/)\.env\.(?:example|sample|template)$/i.test(path)) ||
    /(?:^|\/)(?:\.ssh|\.aws|\.codex|\.agentgate)(?:\/|$)/i.test(path)
  );
}

function containsSecret(value: string): boolean {
  return (
    /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\b(?:gh[pousr]_[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9_]{20,}|AKIA[A-Z0-9]{16}|sk-(?:proj-|ant-)?[a-zA-Z0-9_-]{20,})\b/.test(
      value,
    ) ||
    (/(?:password|secret|api[_-]?key|access[_-]?token)\s*[=:]\s*["']?([^\s"'<>]{12,})/i.test(
      value,
    ) &&
      !/(?:placeholder|your[_-]|example|replace[_-]|changeme|process\.env|\$\{)/i.test(value))
  );
}

/** GitHub operations remain in the controller; workers never receive this adapter. */
export class GitHubCli implements GitHubGateway {
  private readonly home: string;
  private readonly gitPath: string;
  private readonly ghPath: string;
  private readonly executor: Executor;
  private resolvedGhPath?: Promise<string>;

  constructor(options: GitHubCliOptions) {
    this.home = resolve(options.home);
    this.gitPath = options.gitPath ?? 'git';
    this.ghPath = options.ghPath ?? 'gh';
    this.executor = options.execute ?? execute;
  }

  async identify(
    path: string,
    signal?: AbortSignal,
  ): Promise<{ fullName: string; baseBranch: string }> {
    signal?.throwIfAborted();
    const root = await realpath(path);
    const top = (await this.git(root, ['rev-parse', '--show-toplevel'], { signal })).trim();
    if ((await realpath(top)) !== root)
      throw new Error('Register the repository root, not a subdirectory.');
    const origin = canonicalRemote(
      await this.git(root, ['remote', 'get-url', 'origin'], { signal }),
    );
    await this.gh(['auth', 'status', '--hostname', 'github.com', '--active'], signal);
    const data = validatedJson(
      await this.gh(
        [
          'repo',
          'view',
          origin,
          '--json',
          'nameWithOwner,defaultBranchRef,viewerPermission,isArchived',
        ],
        signal,
      ),
      Repository,
      'repository metadata',
    );
    if (
      data.nameWithOwner.toLowerCase() !== origin.toLowerCase() ||
      data.isArchived ||
      !['ADMIN', 'MAINTAIN', 'WRITE'].includes(data.viewerPermission)
    ) {
      throw new Error(
        'Repository identity and write access must be established before registration.',
      );
    }
    await this.branch(root, data.defaultBranchRef.name, signal);
    return { fullName: data.nameWithOwner, baseBranch: data.defaultBranchRef.name };
  }

  async issue(url: string, repo: RepoProfile, signal?: AbortSignal): Promise<Issue> {
    signal?.throwIfAborted();
    const number = issueNumber(url, repo.fullName);
    const data = validatedJson(
      await this.gh(
        [
          'issue',
          'view',
          String(number),
          '--repo',
          repo.fullName,
          '--json',
          'url,number,title,body',
        ],
        signal,
      ),
      IssueSchema,
      'issue',
    );
    if (
      issueNumber(data.url, repo.fullName) !== number ||
      data.number !== number ||
      !data.title.trim()
    ) {
      throw new Error('GitHub returned a different or incomplete issue.');
    }
    return data;
  }

  async baseCommit(repo: RepoProfile, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    await this.branch(repo.path, repo.baseBranch, signal);
    await this.git(
      repo.path,
      [
        'fetch',
        '--no-tags',
        '--no-recurse-submodules',
        githubUrl(repo),
        `refs/heads/${repo.baseBranch}`,
      ],
      { network: true, signal },
    );
    return ObjectId.parse(
      (
        await this.git(repo.path, ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'], { signal })
      ).trim(),
    );
  }

  async createWorktree(
    repo: RepoProfile,
    path: string,
    branch: string,
    baseCommit: string,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const target = await this.worktreePath(path, false);
    const owner: Owner = {
      repo: await realpath(repo.path),
      path: target,
      branch,
      baseCommit: ObjectId.parse(baseCommit),
    };
    await this.branch(owner.repo, branch, signal);
    const marker = await this.markerPath(target);
    const previous = await this.readOwner(marker);
    if (previous && JSON.stringify(previous) !== JSON.stringify(owner))
      throw new Error('Worktree ownership does not match this run.');
    if (await this.exists(target)) {
      if (!previous)
        throw new Error('Refusing to adopt an existing worktree without an ownership record.');
      await this.verifyOwner(owner, signal);
      await this.rejectFilters(owner.path, signal);
      return;
    }
    if (!previous) await writeFile(marker, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
    await this.git(owner.repo, ['worktree', 'add', '-b', branch, '--', target, baseCommit], {
      signal,
    });
    await this.verifyOwner(owner, signal);
    await this.rejectFilters(owner.path, signal);
  }

  async snapshot(worktree: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    await this.rejectFilters(worktree, signal);
    const candidates = new Set([
      ...this.nul(
        await this.git(worktree, ['ls-files', '--others', '--exclude-standard', '-z'], { signal }),
      ),
      ...this.nul(
        await this.git(
          worktree,
          ['diff', '--name-only', '--no-ext-diff', '--no-textconv', '-z', 'HEAD', '--'],
          { signal },
        ),
      ),
    ]);
    for (const path of candidates) await this.inspectFile(worktree, path, signal);
    await this.git(worktree, ['add', '--all', '--', '.'], { signal });
    return ObjectId.parse((await this.git(worktree, ['write-tree'], { signal })).trim());
  }

  async changes(
    worktree: string,
    baseCommit: string,
    signal?: AbortSignal,
  ): Promise<{ path: string; status: string }[]> {
    signal?.throwIfAborted();
    const parts = this.nul(
      await this.git(
        worktree,
        [
          'diff',
          '--cached',
          '--name-status',
          '--no-renames',
          '--no-ext-diff',
          '--no-textconv',
          '-z',
          ObjectId.parse(baseCommit),
          '--',
        ],
        { signal },
      ),
    );
    if (parts.length % 2) throw new Error('Invalid Git change listing.');
    const changes: { path: string; status: string }[] = [];
    for (let index = 0; index < parts.length; index += 2) {
      const status = parts[index];
      const path = parts[index + 1];
      if (!status || !path || !/^[AMDTUXB]$/.test(status))
        throw new Error('Unsupported Git change status.');
      changes.push({ path, status });
    }
    return changes;
  }

  async diff(worktree: string, baseCommit: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    return this.git(
      worktree,
      [
        'diff',
        '--cached',
        '--stat',
        '--patch',
        '--no-color',
        '--no-renames',
        '--no-ext-diff',
        '--no-textconv',
        ObjectId.parse(baseCommit),
        '--',
      ],
      { signal },
    );
  }

  async commit(
    worktree: string,
    tree: string,
    message: string,
    signal?: AbortSignal,
  ): Promise<string> {
    signal?.throwIfAborted();
    ObjectId.parse(tree);
    if ((await this.snapshot(worktree, signal)) !== tree)
      throw new Error('Files changed since the approved checks.');
    const parent = ObjectId.parse(
      (await this.git(worktree, ['rev-parse', '--verify', 'HEAD'], { signal })).trim(),
    );
    const commit = ObjectId.parse(
      (
        await this.git(worktree, ['commit-tree', tree, '-p', parent, '-F', '-'], {
          input: message,
          signal,
        })
      ).trim(),
    );
    await this.git(worktree, ['update-ref', 'HEAD', commit, parent], { signal });
    await this.verifyCommit(worktree, commit, tree, signal);
    return commit;
  }

  async verifyCommit(
    worktree: string,
    commit: string,
    tree: string,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    ObjectId.parse(commit);
    ObjectId.parse(tree);
    const actual = (
      await this.git(worktree, ['rev-parse', '--verify', `${commit}^{tree}`], { signal })
    ).trim();
    const head = (await this.git(worktree, ['rev-parse', '--verify', 'HEAD'], { signal })).trim();
    if (actual !== tree || head !== commit || (await this.snapshot(worktree, signal)) !== tree) {
      throw new Error('The current worktree and commit no longer match the approved tree.');
    }
  }

  async publish(
    run: Run,
    draft: boolean,
    signal?: AbortSignal,
  ): Promise<{ kind: 'published'; url: string } | { kind: 'draft-unavailable' }> {
    signal?.throwIfAborted();
    if (!run.candidateCommit || !run.checkedTree || run.publicationApproval !== run.candidateCommit)
      throw new Error('An exact commit approval is required.');
    if (!draft && !run.ordinaryPrApproved)
      throw new Error('A normal pull request requires separate approval.');
    await this.assertRunOwner(run, signal);
    await this.branch(run.worktree, run.branch, signal);
    await this.branch(run.worktree, run.repo.baseBranch, signal);
    await this.verifyCommit(run.worktree, run.candidateCommit, run.checkedTree, signal);
    const remote = await this.remoteHead(run, signal);
    if (remote && remote !== run.candidateCommit)
      throw new Error(
        'The remote branch already exists with a different commit; it will not be overwritten.',
      );
    const existing = await this.existingPullRequest(run, signal);
    if (existing) return { kind: 'published', url: existing };
    if (!remote) {
      // Empty expected value is compare-and-swap creation only: an existing ref can never be replaced.
      await this.git(
        run.worktree,
        [
          'push',
          '--porcelain',
          '--no-verify',
          '--no-follow-tags',
          '--recurse-submodules=no',
          '--signed=false',
          `--force-with-lease=refs/heads/${run.branch}:`,
          githubUrl(run.repo),
          `${run.candidateCommit}:refs/heads/${run.branch}`,
        ],
        { network: true, signal },
      );
      if ((await this.remoteHead(run, signal)) !== run.candidateCommit)
        throw new Error('The published branch could not be verified.');
    }
    const proposal = buildPullRequestDraft(run);
    const args = [
      'pr',
      'create',
      '--repo',
      run.repo.fullName,
      '--head',
      run.branch,
      '--base',
      run.repo.baseBranch,
      '--title',
      proposal.title,
      '--body-file',
      '-',
    ];
    if (draft) args.push('--draft');
    const result = await this.ghResult(args, proposal.body, signal);
    if (result.exitCode !== 0) {
      if (draft && /draft pull requests are not supported in this repository/i.test(result.stderr))
        return { kind: 'draft-unavailable' };
      throw new Error(
        'GitHub pull request creation failed. Resume to check whether it was already created.',
      );
    }
    return { kind: 'published', url: pullRequestUrl(result.stdout, run.repo.fullName) };
  }

  async cleanup(run: Run, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (run.status !== 'completed' || !run.prUrl || !run.candidateCommit || !run.checkedTree) {
      throw new Error('Unpublished work cannot be cleaned up.');
    }
    pullRequestUrl(run.prUrl, run.repo.fullName);
    const owner = await this.assertRunOwner(run, signal);
    if (
      (
        await this.git(owner.path, ['status', '--porcelain=v1', '--untracked-files=all'], {
          signal,
        })
      ).trim()
    ) {
      throw new Error('The worktree contains unpublished changes.');
    }
    const head = (await this.git(owner.path, ['rev-parse', '--verify', 'HEAD'], { signal })).trim();
    if (head !== run.candidateCommit)
      throw new Error('The worktree contains an unpublished commit.');
    await this.git(owner.repo, ['worktree', 'remove', '--', owner.path], { signal });
    await rm(await this.markerPath(owner.path));
  }

  private async branch(cwd: string, branch: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (
      !branch ||
      branch.startsWith('-') ||
      [...branch].some(
        (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
      )
    )
      throw new Error('Invalid branch name.');
    await this.git(cwd, ['check-ref-format', `refs/heads/${branch}`], { signal });
  }

  private async rejectFilters(cwd: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const files = await this.git(
      cwd,
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { signal },
    );
    const attributes = this.nul(
      await this.git(cwd, ['check-attr', '-z', '--stdin', 'filter'], { input: files, signal }),
    );
    if (attributes.length % 3) throw new Error('Invalid Git attribute response.');
    for (let index = 2; index < attributes.length; index += 3) {
      if (!['unspecified', 'unset'].includes(attributes[index] ?? '')) {
        throw new Error('Repository Git filters are unsupported for controller operations.');
      }
    }
  }

  private async inspectFile(worktree: string, path: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const target = resolve(worktree, path);
    if (!inside(resolve(worktree), target)) throw new Error('Changed path escapes the worktree.');
    let stat;
    try {
      stat = await lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (sensitivePath(path)) throw new Error(`Sensitive file must not be published: ${path}`);
    if (stat.isSymbolicLink())
      throw new Error(`New or changed symbolic links require manual handling: ${path}`);
    if (!stat.isFile()) throw new Error(`Unsupported changed file: ${path}`);
    if (stat.size > 10 * 1024 * 1024)
      throw new Error(`File exceeds the 10 MiB publication inspection limit: ${path}`);
    if (containsSecret((await readFile(target)).toString('utf8')))
      throw new Error(`Potential secret detected in: ${path}`);
  }

  private async remoteHead(run: Run, signal?: AbortSignal): Promise<string | undefined> {
    signal?.throwIfAborted();
    const value = (
      await this.git(
        run.worktree,
        ['ls-remote', '--heads', githubUrl(run.repo), `refs/heads/${run.branch}`],
        { network: true, signal },
      )
    ).trim();
    if (!value) return undefined;
    const parts = value.split('\t');
    if (parts.length !== 2 || parts[1] !== `refs/heads/${run.branch}`)
      throw new Error('Invalid remote branch response.');
    return ObjectId.parse(parts[0]);
  }

  private async existingPullRequest(run: Run, signal?: AbortSignal): Promise<string | undefined> {
    signal?.throwIfAborted();
    const requests = validatedJson(
      await this.gh(
        [
          'pr',
          'list',
          '--repo',
          run.repo.fullName,
          '--head',
          run.branch,
          '--state',
          'all',
          '--json',
          'url,headRefName,baseRefName,headRefOid,isDraft,isCrossRepository,state',
        ],
        signal,
      ),
      z.array(PullRequest),
      'pull request list',
    );
    if (requests.length > 1)
      throw new Error('Multiple pull requests match this run; manual inspection is required.');
    const pr = requests[0];
    if (!pr) return undefined;
    if (
      pr.isCrossRepository ||
      pr.headRefName !== run.branch ||
      pr.baseRefName !== run.repo.baseBranch ||
      pr.headRefOid !== run.candidateCommit ||
      (!pr.isDraft && !run.ordinaryPrApproved)
    ) {
      throw new Error('An existing pull request does not match the approved publication.');
    }
    return pullRequestUrl(pr.url, run.repo.fullName);
  }

  private async assertRunOwner(run: Run, signal?: AbortSignal): Promise<Owner> {
    signal?.throwIfAborted();
    const path = await this.worktreePath(run.worktree, true);
    const owner = await this.readOwner(await this.markerPath(path));
    if (
      !owner ||
      owner.repo !== (await realpath(run.repo.path)) ||
      owner.path !== path ||
      owner.branch !== run.branch ||
      owner.baseCommit !== run.baseCommit
    )
      throw new Error('Run does not own this worktree.');
    await this.verifyOwner(owner, signal);
    return owner;
  }

  private async verifyOwner(owner: Owner, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const top = (await this.git(owner.path, ['rev-parse', '--show-toplevel'], { signal })).trim();
    const branch = (
      await this.git(owner.path, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { signal })
    ).trim();
    const common = (
      await this.git(owner.path, ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
        signal,
      })
    ).trim();
    const sourceCommon = (
      await this.git(owner.repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
        signal,
      })
    ).trim();
    if (
      (await realpath(top)) !== owner.path ||
      branch !== owner.branch ||
      (await realpath(common)) !== (await realpath(sourceCommon))
    ) {
      throw new Error('The owned worktree no longer matches its original repository and branch.');
    }
  }

  private async worktreePath(path: string, mustExist: boolean): Promise<string> {
    const root = join(this.home, 'worktrees');
    await mkdir(root, { recursive: true, mode: 0o700 });
    const canonicalRoot = await realpath(root);
    const target = resolve(path);
    if (dirname(target) !== resolve(root) || target === join(root, '.ownership')) {
      throw new Error('Worktrees must be direct children of AgentGate home/worktrees.');
    }
    const canonicalTarget = join(canonicalRoot, relative(root, target));
    if (await this.exists(target)) {
      if ((await lstat(target)).isSymbolicLink() || (await realpath(target)) !== canonicalTarget)
        throw new Error('Worktree path redirects outside its owned location.');
    } else if (mustExist) throw new Error('The owned worktree is missing.');
    return canonicalTarget;
  }

  private async markerPath(path: string): Promise<string> {
    const directory = join(this.home, 'worktrees', '.ownership');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if ((await lstat(directory)).isSymbolicLink())
      throw new Error('Worktree ownership directory must not be a link.');
    return join(directory, `${createHash('sha256').update(path).digest('hex')}.json`);
  }

  private async readOwner(path: string): Promise<Owner | undefined> {
    try {
      return validatedJson(await readFile(path, 'utf8'), Ownership, 'worktree ownership');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await lstat(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  private nul(value: string): string[] {
    return value.split('\0').filter(Boolean);
  }

  private async ghResult(
    args: string[],
    input?: string,
    signal?: AbortSignal,
  ): Promise<ExecuteResult> {
    signal?.throwIfAborted();
    return this.executor({
      command: this.ghPath,
      args,
      env: controllerEnvironment(),
      input,
      timeoutMs: 120_000,
      maxOutputBytes: 2 * 1024 * 1024,
      signal,
    });
  }

  private async gh(args: string[], signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const result = await this.ghResult(args, undefined, signal);
    if (result.exitCode !== 0)
      throw new Error(
        `GitHub CLI ${args[0]} ${args[1]} failed; verify existing login and repository permissions.`,
      );
    return result.stdout;
  }

  private async git(
    cwd: string,
    args: string[],
    options: { input?: string; network?: boolean; signal?: AbortSignal } = {},
  ): Promise<string> {
    const { signal } = options;
    signal?.throwIfAborted();
    const result = await this.gitResult(cwd, args, options);
    if (result.exitCode !== 0)
      throw new Error(
        `Git ${args[0]} failed; no automatic permission or overwrite fallback is allowed.`,
      );
    return result.stdout;
  }

  private async gitResult(
    cwd: string,
    args: string[],
    options: { input?: string; network?: boolean; signal?: AbortSignal } = {},
  ): Promise<ExecuteResult> {
    const { signal } = options;
    signal?.throwIfAborted();
    const hooks = join(this.home, 'empty-hooks');
    await mkdir(hooks, { recursive: true, mode: 0o700 });
    if ((await lstat(hooks)).isSymbolicLink() || (await readdir(hooks)).length)
      throw new Error('Controller hook directory must remain empty.');
    const config = [
      'core.hooksPath=' + hooks,
      'core.fsmonitor=false',
      'core.askPass=',
      'core.autocrlf=false',
      'commit.gpgSign=false',
      'tag.gpgSign=false',
      'gc.auto=0',
      'maintenance.auto=false',
      'submodule.recurse=false',
      'push.followTags=false',
      'push.recurseSubmodules=no',
      'push.pushOption=',
      'credential.helper=',
      'protocol.allow=never',
      'protocol.https.allow=always',
    ];
    if (options.network) {
      const rewrites = await this.gitResult(
        cwd,
        ['config', '--name-only', '--get-regexp', '^url\\..*\\.(insteadof|pushinsteadof)$'],
        { signal },
      );
      if (rewrites.exitCode !== 1)
        throw new Error('Git URL rewriting must be disabled for explicit GitHub publication.');
    }
    if (args[0] !== 'config') {
      const names = await this.executor({
        command: this.gitPath,
        args: [
          ...config.flatMap((setting) => ['-c', setting]),
          'config',
          '--name-only',
          '--get-regexp',
          '^filter\\.',
        ],
        cwd,
        env: controllerEnvironment(),
        timeoutMs: 120_000,
        maxOutputBytes: 1024 * 1024,
        signal,
      });
      if (![0, 1].includes(names.exitCode))
        throw new Error('Git filter configuration could not be inspected.');
      const drivers = new Set(
        names.stdout
          .split(/\r?\n/)
          .map((name) => /^filter\.(.+)\.(?:clean|smudge|process|required)$/.exec(name)?.[1])
          .filter(Boolean),
      );
      for (const driver of drivers)
        config.push(
          `filter.${driver}.clean=`,
          `filter.${driver}.smudge=`,
          `filter.${driver}.process=`,
          `filter.${driver}.required=false`,
        );
    }
    if (options.network)
      config.push(
        `credential.helper=${await this.credentialHelper(cwd)}`,
        'credential.useHttpPath=true',
      );
    return this.executor({
      command: this.gitPath,
      args: [...config.flatMap((setting) => ['-c', setting]), ...args],
      cwd,
      env: controllerEnvironment(),
      input: options.input,
      timeoutMs: 120_000,
      maxOutputBytes: 16 * 1024 * 1024,
      signal,
    });
  }

  private async credentialHelper(cwd: string): Promise<string> {
    this.resolvedGhPath ??= resolveCommand(this.ghPath, [], controllerEnvironment(), cwd).then(
      ({ command }) => {
        if (!isAbsolute(command))
          throw new Error('GitHub CLI must resolve to an absolute trusted executable.');
        return command;
      },
    );
    const ghPath = await this.resolvedGhPath;
    const directory = join(this.home, 'controller');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const script = join(directory, 'github-credential.cjs');
    // Git's credential-helper protocol uses a shell. Only trusted installation paths enter this command.
    await writeFile(
      script,
      `const {spawnSync}=require('node:child_process');\nconst action=process.argv[2];\nif(!['get','store','erase'].includes(action))process.exit(1);\nconst result=spawnSync(${JSON.stringify(ghPath)},['auth','git-credential',action],{stdio:'inherit',shell:false,windowsHide:true});\nprocess.exit(result.status??1);\n`,
      { mode: 0o600 },
    );
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    return `!${quote(process.execPath.replaceAll('\\', '/'))} ${quote(script.replaceAll('\\', '/'))}`;
  }
}
