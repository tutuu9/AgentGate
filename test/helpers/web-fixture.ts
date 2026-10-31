import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { request, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { TestContext } from 'node:test';
import { RepoSchema } from '../../src/core/contracts.ts';
import type {
  AgentContext,
  AgentResultMap,
  AgentRunner,
  AgentStage,
  GitHubGateway,
  Run,
  SandboxRunner,
} from '../../src/core/contracts.ts';
import { FileRunStore } from '../../src/core/store.ts';
import { startWebServer } from '../../src/web/server.ts';
import type {
  PendingPrompt,
  StartRequest,
  WebOperation,
  WebState,
} from '../../src/web/contracts.ts';

interface RequestOptions {
  method?: 'GET' | 'POST' | 'OPTIONS';
  body?: unknown;
  raw?: string;
  headers?: Record<string, string | undefined>;
}

export interface HttpResult {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
}

export async function webFixture(t: Pick<TestContext, 'after'>) {
  const root = await mkdtemp(join(tmpdir(), 'agentgate-web-'));
  const repoPath = join(root, 'repo');
  await mkdir(repoPath);
  const store = new FileRunStore(join(root, 'state'));
  await store.init();
  await store.saveRepo(
    RepoSchema.parse({
      name: 'example',
      path: repoPath,
      fullName: 'owner/example',
      baseBranch: 'main',
      checks: [{ name: 'unit', command: 'node', args: ['--test'] }],
    }),
  );
  const state = {
    tree: 'tree-a',
    stages: [] as AgentStage[],
    feedback: [] as string[],
    snapshotCalls: 0,
    publishCalls: 0,
    checkCalls: 0,
    draftAttempts: [] as boolean[],
    draftUnavailable: false,
    doctorReady: true,
    implementationError: undefined as Error | undefined,
    issueTitle: 'Fix service',
    issueBody: 'Return the correct value.',
    checkOutput: 'Unit checks passed.',
    modelOptions: [] as unknown[],
  };
  const git: GitHubGateway = {
    async identify() {
      return { fullName: 'owner/example', baseBranch: 'main' };
    },
    async issue(url) {
      return { url, number: 1, title: state.issueTitle, body: state.issueBody };
    },
    async baseCommit() {
      return 'a'.repeat(40);
    },
    async createWorktree(_repo, path) {
      await mkdir(path, { recursive: true });
    },
    async snapshot() {
      state.snapshotCalls += 1;
      return state.tree;
    },
    async changes() {
      return [{ path: 'src/service.ts', status: 'M' }];
    },
    async diff() {
      return `diff ${state.tree}`;
    },
    async commit(_path, tree) {
      assert.equal(tree, state.tree);
      return 'b'.repeat(40);
    },
    async verifyCommit(_path, commit, tree) {
      assert.equal(commit, 'b'.repeat(40));
      assert.equal(tree, state.tree, 'Source changed after checks');
    },
    async publish(_run, draft) {
      state.publishCalls += 1;
      state.draftAttempts.push(draft);
      if (draft && state.draftUnavailable) return { kind: 'draft-unavailable' };
      return { kind: 'published', url: 'https://github.com/owner/example/pull/2' };
    },
    async cleanup() {},
  };
  const agent: AgentRunner = {
    async run<S extends AgentStage>(
      stage: S,
      context: AgentContext,
      signal?: AbortSignal,
    ): Promise<AgentResultMap[S]> {
      signal?.throwIfAborted();
      state.stages.push(stage);
      if (context.feedback) state.feedback.push(context.feedback);
      if (stage === 'implement' && state.implementationError) throw state.implementationError;
      const result =
        stage === 'plan'
          ? {
              objective: context.feedback ? 'Fix service with requested revision' : 'Fix service',
              steps: ['Update the return value'],
              allowedPaths: ['src'],
              acceptanceCriteria: ['Unit checks pass'],
              risks: [],
            }
          : stage === 'implement'
            ? { summary: 'Corrected the service.' }
            : { summary: 'Reviewed the diff.', findings: [] };
      return result as AgentResultMap[S];
    },
  };
  const sandbox: SandboxRunner = {
    async doctor(signal) {
      signal?.throwIfAborted();
      return [{ name: 'fixture', ok: state.doctorReady, detail: 'Fake, not isolation evidence.' }];
    },
    async check(spec) {
      state.checkCalls += 1;
      return { name: spec.name, exitCode: 0, output: state.checkOutput, durationMs: 1 };
    },
  };
  const options = {
    store,
    git,
    sandbox,
    createAgent(modelOptions: unknown) {
      state.modelOptions.push(modelOptions);
      return agent;
    },
  };
  let server = await startWebServer(options);
  t.after(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });

  const send = (path: string, input: RequestOptions = {}): Promise<HttpResult> => {
    const method = input.method ?? 'GET';
    const headers: Record<string, string | undefined> = {
      'X-AgentGate-Token': new URL(server.url).hash.slice('#token='.length),
      ...(method === 'POST' ? { Origin: server.origin, 'Content-Type': 'application/json' } : {}),
      ...input.headers,
    };
    const body = input.raw ?? (input.body === undefined ? undefined : JSON.stringify(input.body));
    return new Promise((resolve, reject) => {
      const outgoing = request(
        new URL(path, server.origin),
        {
          method,
          headers: Object.fromEntries(
            Object.entries(headers).filter(([, value]) => value !== undefined),
          ),
        },
        (response) => {
          let text = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => {
            text += chunk;
          });
          response.on('end', () =>
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              text,
            }),
          );
          response.on('error', reject);
        },
      );
      outgoing.on('error', reject);
      outgoing.end(body);
    });
  };
  async function json<T>(path: string, input?: RequestOptions): Promise<T> {
    const response = await send(path, input);
    assert.ok(
      response.status >= 200 && response.status < 300,
      `${response.status}: ${response.text}`,
    );
    return JSON.parse(response.text) as T;
  }
  const getState = () => json<WebState>('/api/state');
  async function waitFor<T>(read: () => Promise<T>, matches: (value: T) => boolean): Promise<T> {
    const deadline = Date.now() + 5_000;
    let value = await read();
    while (!matches(value) && Date.now() < deadline) {
      await delay(10);
      value = await read();
    }
    assert.ok(matches(value), `Timed out waiting for state: ${JSON.stringify(value)}`);
    return value;
  }
  async function prompt(kind: PendingPrompt['kind']): Promise<PendingPrompt> {
    const result = await waitFor(getState, (value) => value.prompt?.kind === kind);
    return result.prompt!;
  }
  const respond = (
    pending: PendingPrompt,
    choice: 'approve' | 'reject' | 'feedback',
    feedback?: string,
  ) =>
    json(`/api/prompts/${pending.id}/respond`, {
      method: 'POST',
      body: { binding: pending.binding, choice, ...(feedback ? { feedback } : {}) },
    });
  const startBody = () => ({
    requestId: randomUUID(),
    repo: 'example',
    issueUrl: 'https://github.com/owner/example/issues/1',
  });
  const start = (body: StartRequest = startBody()) =>
    json<WebOperation>('/api/runs', { method: 'POST', body });
  async function finished(id: string): Promise<WebOperation> {
    return waitFor(
      () => json<WebOperation>(`/api/operations/${id}`),
      (value) => value.status !== 'running' && value.status !== 'cancelling',
    );
  }
  async function publication(): Promise<{ operation: WebOperation; pending: PendingPrompt }> {
    const operation = await start();
    await respond(await prompt('plan'), 'approve');
    await respond(await prompt('prepared'), 'approve');
    return { operation, pending: await prompt('publication') };
  }
  return {
    root,
    store,
    state,
    git,
    agent,
    sandbox,
    send,
    json,
    getState,
    waitFor,
    prompt,
    respond,
    startBody,
    start,
    finished,
    publication,
    get server() {
      return server;
    },
    async restart() {
      await server.close();
      server = await startWebServer(options);
    },
  };
}

export type WebFixture = Awaited<ReturnType<typeof webFixture>>;
export type RunView = { run: Run; diff?: string };
