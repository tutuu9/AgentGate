/* global document, window, location, history, sessionStorage, URLSearchParams, URL, fetch, crypto, setTimeout */

const byId = (id) => document.getElementById(id);
const tokenKey = 'agentgate.web.token';
const fragment = new URLSearchParams(location.hash.slice(1));
const launchToken = fragment.get('token');
let token;
try {
  if (launchToken) sessionStorage.setItem(tokenKey, launchToken);
  token = launchToken || sessionStorage.getItem(tokenKey);
} catch {
  token = launchToken;
}
if (location.hash) history.replaceState(null, '', location.pathname + location.search);

let state;
let connected = false;
let invalidSession = false;
let actionBusy = false;
let refreshBusy = false;
let selectedRunId;
let refreshFailure = false;
let pendingRequest;
let promptKey;
let runKey;
let listKey;
let repoKey;
let operationKey;
let lastPromptId;
const inspectedDiffs = new Map();

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function api(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'X-AgentGate-Token': token,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    cache: 'no-store',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      invalidSession = true;
      connected = false;
      showSession(
        'This browser session is no longer authorized. Open the current launch link from your terminal.',
      );
    }
    throw new ApiError(result.error || `Request failed (${response.status}).`, response.status);
  }
  return result;
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function button(text, onClick, className) {
  const node = element('button', text, className);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

function statusBadge(status) {
  const badge = element('span', status.replaceAll('_', ' '), 'status');
  badge.dataset.status = status;
  return badge;
}

function safeLink(text, address) {
  try {
    const url = new URL(address);
    if (url.protocol !== 'https:' || url.username || url.password) return element('span', text);
    const link = element('a', text);
    link.href = url.href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    return link;
  } catch {
    return element('span', text);
  }
}

function showSession(message) {
  byId('session-message').textContent = message;
  byId('session-message').hidden = false;
  applyAvailability();
}

function showError(message) {
  byId('error-message').textContent = message || '';
  byId('error-message').hidden = !message;
}

function setConnection(ok) {
  connected = ok;
  byId('connection').textContent = ok
    ? 'Connected locally'
    : invalidSession
      ? 'Session ended'
      : 'Reconnecting…';
  byId('connection').dataset.state = ok ? 'connected' : 'disconnected';
  applyAvailability();
}

function applyAvailability() {
  const unavailable = !connected || actionBusy;
  byId('start-fields').disabled =
    unavailable || Boolean(state?.busy) || !state?.repos.length || Boolean(pendingRequest);
  byId('retry-request').disabled = unavailable;
  document.querySelectorAll('[data-idle-control]').forEach((node) => {
    node.disabled = unavailable || Boolean(state?.busy) || Boolean(pendingRequest);
  });
  document.querySelectorAll('[data-prompt-control]').forEach((node) => {
    node.disabled = unavailable;
  });
  document.querySelectorAll('[data-cancel-control]').forEach((node) => {
    node.disabled = unavailable || state?.operation?.status === 'cancelling';
  });
}

function modelOptions() {
  const model = byId('model').value.trim();
  const reasoningEffort = byId('reasoning-effort').value;
  return { ...(model ? { model } : {}), ...(reasoningEffort ? { reasoningEffort } : {}) };
}

async function performAction(action) {
  if (actionBusy || !connected) return;
  actionBusy = true;
  showError();
  applyAvailability();
  try {
    await action();
    await refresh();
  } catch (error) {
    showError(error.message || 'The request could not be completed.');
  } finally {
    actionBusy = false;
    applyAvailability();
  }
}

async function submitPendingRequest() {
  await performAction(async () => {
    try {
      const operation = await api(pendingRequest.path, pendingRequest.body);
      pendingRequest = undefined;
      inspectedDiffs.clear();
      byId('request-retry').hidden = true;
      if (operation.runId) selectRun(operation.runId);
    } catch (error) {
      if (error instanceof ApiError && error.status < 500) pendingRequest = undefined;
      byId('request-retry').hidden = !pendingRequest;
      throw error;
    }
  });
}

function startRequest(path, body) {
  if (actionBusy || pendingRequest || !connected) return;
  pendingRequest = { path, body: { requestId: crypto.randomUUID(), ...body } };
  void submitPendingRequest();
}

function selectRun(id) {
  if (selectedRunId !== id) {
    selectedRunId = id;
    runKey = undefined;
    listKey = undefined;
  }
  if (state) renderRunList(state.runs);
  void refresh();
}

function renderRepositories(repos) {
  const key = JSON.stringify(repos);
  if (repoKey === key) return;
  repoKey = key;
  const chosen = byId('repository').value;
  const options = repos.map((repo) => {
    const option = element('option', repo.name);
    option.value = repo.name;
    return option;
  });
  const placeholder = element(
    'option',
    repos.length ? 'Choose a repository' : 'No repositories registered',
  );
  placeholder.value = '';
  byId('repository').replaceChildren(placeholder, ...options);
  if (repos.some((repo) => repo.name === chosen)) byId('repository').value = chosen;
  else if (repos.length === 1) byId('repository').value = repos[0].name;
  byId('no-repositories').hidden = repos.length > 0;
  byId('repositories').replaceChildren(
    ...repos.map((repo) => {
      const item = element('div', undefined, 'repository-item');
      item.append(
        element('div', repo.name, 'repository-name'),
        element('div', repo.fullName, 'repository-detail'),
      );
      return item;
    }),
  );
  if (!repos.length)
    byId('repositories').append(element('p', 'No repositories registered.', 'hint'));
}

function renderRunList(runs) {
  const key = JSON.stringify([runs, selectedRunId]);
  if (listKey === key) return;
  listKey = key;
  byId('run-count').textContent = String(runs.length);
  byId('run-list').replaceChildren(
    ...runs.map((run) => {
      const item = button('', () => selectRun(run.id), 'run-item');
      item.setAttribute('aria-current', String(run.id === selectedRunId));
      item.append(element('span', `#${run.issue.number} ${run.issue.title}`, 'run-title'));
      item.append(element('span', run.repo.fullName, 'run-meta'), statusBadge(run.status));
      return item;
    }),
  );
  if (!runs.length) byId('run-list').append(element('p', 'No runs yet.', 'hint'));
}

function renderOperation(operation) {
  const key = JSON.stringify([operation, state.prompt?.id]);
  if (operationKey === key) return;
  operationKey = key;
  const container = byId('operation');
  container.replaceChildren();
  container.hidden = !operation;
  if (!operation) return;
  const description = element('div');
  const waiting = state.prompt?.operationId === operation.id;
  const title =
    operation.status === 'failed'
      ? 'Operation stopped'
      : operation.status === 'cancelling'
        ? 'Stopping the current operation…'
        : operation.status === 'completed'
          ? `Operation finished${operation.resultStatus ? `: ${operation.resultStatus.replaceAll('_', ' ')}` : ''}`
          : waiting
            ? 'Your decision is needed'
            : 'Workflow is running';
  description.append(element('p', title));
  description.append(
    element(
      'small',
      operation.error ||
        (operation.runId
          ? `Run ${operation.runId}`
          : 'Checking prerequisites and preparing the run.'),
    ),
  );
  container.append(description);
  if (operation.status === 'running' || operation.status === 'cancelling') {
    const cancel = button(
      'Stop run',
      () => performAction(() => api(`/api/operations/${operation.id}/cancel`, {})),
      'danger',
    );
    cancel.dataset.cancelControl = '';
    container.append(cancel);
  }
}

function metadata(entries) {
  const list = element('dl', undefined, 'metadata');
  for (const [label, value] of entries) {
    if (value === undefined) continue;
    const detail = element('dd');
    if (typeof value === 'string') detail.textContent = value;
    else detail.append(value);
    list.append(element('dt', label), detail);
  }
  return list;
}

function textList(title, values, ordered = false) {
  const section = element('div');
  section.append(element('h3', title));
  const list = element(ordered ? 'ol' : 'ul', undefined, 'text-list');
  values.forEach((value) => list.append(element('li', value)));
  section.append(list);
  return section;
}

function report(title, content, open = false) {
  const details = element('details', undefined, 'report');
  details.open = open;
  details.append(element('summary', title), content);
  return details;
}

function planContent(plan) {
  const content = element('div');
  content.append(element('p', plan.objective, 'plan-objective'));
  content.append(
    textList('Steps', plan.steps, true),
    textList('Allowed paths', plan.allowedPaths),
    textList('Acceptance criteria', plan.acceptanceCriteria),
  );
  if (plan.risks.length) content.append(textList('Risks', plan.risks));
  else content.append(element('p', 'No risks reported.', 'hint'));
  return content;
}

function mandatoryChecks(checks) {
  const content = element('div');
  checks.forEach((check) => {
    const entry = element('div', undefined, 'check');
    entry.append(
      element('h3', check.name),
      element(
        'pre',
        JSON.stringify(
          { command: check.command, args: check.args, timeoutMs: check.timeoutMs },
          null,
          2,
        ),
      ),
    );
    content.append(entry);
  });
  return content;
}

function checkContent(checks) {
  const content = element('div');
  if (!checks.length) content.append(element('p', 'No check results yet.', 'hint'));
  checks.forEach((check) => {
    const entry = element('div', undefined, 'check');
    const heading = element('div', undefined, 'check-heading');
    const result = element(
      'span',
      `Exit ${check.exitCode} · ${(check.durationMs / 1000).toFixed(1)}s`,
      'check-result',
    );
    result.dataset.passed = String(check.exitCode === 0);
    heading.append(element('h3', check.name), result);
    entry.append(heading, element('pre', check.output || '(No output)'));
    content.append(entry);
  });
  return content;
}

function reviewContent(review) {
  const content = element('div');
  if (!review) {
    content.append(element('p', 'No review yet.', 'hint'));
    return content;
  }
  content.append(element('p', review.summary));
  review.findings.forEach((finding) => {
    const item = element('div', undefined, 'finding');
    item.dataset.severity = finding.severity;
    item.append(
      element(
        'p',
        `${finding.severity === 'blocking' ? 'Blocking' : 'Advisory'} · ${finding.file}`,
      ),
      element('p', finding.message),
    );
    content.append(item);
  });
  if (!review.findings.length) content.append(element('p', 'No findings reported.', 'hint'));
  return content;
}

function publicationContent(prompt) {
  const content = element('div');
  content.append(
    metadata([
      ['Repository', prompt.run.repo.fullName],
      ['Branch', element('code', prompt.run.branch)],
      ['Exact commit', element('code', prompt.run.candidateCommit)],
      ['Base commit', element('code', prompt.run.baseCommit)],
      ['Issue', safeLink(prompt.run.issue.url, prompt.run.issue.url)],
    ]),
  );
  if (prompt.run.implementationSummary)
    content.append(element('p', prompt.run.implementationSummary));
  content.append(
    report(
      'Diff',
      element(
        'pre',
        prompt.diff ??
          'The diff is not available in this prompt. Inspect the approved commit before continuing.',
        'diff-output',
      ),
      true,
    ),
  );
  content.append(
    report('Check output', checkContent(prompt.run.checks), true),
    report('Review', reviewContent(prompt.run.review), true),
  );
  if (prompt.proposal) {
    const proposal = element('div');
    proposal.append(
      element('p', prompt.proposal.title, 'proposal-title'),
      element('pre', prompt.proposal.body),
    );
    content.append(report('Pull request preview', proposal, true));
  }
  return content;
}

function renderPrompt(prompt) {
  const key = prompt?.id;
  if (promptKey === key) return;
  promptKey = key;
  const container = byId('prompt');
  container.replaceChildren();
  container.hidden = !prompt;
  if (!prompt) return;
  const titles = {
    plan: 'Review the plan',
    prepared: 'Prepare the worktree',
    publication: 'Approve publication',
    'ordinary-pr': 'Create an ordinary pull request?',
  };
  const heading = element('h2', titles[prompt.kind]);
  heading.id = 'prompt-heading';
  container.append(
    heading,
    element(
      'p',
      `${prompt.run.repo.fullName} · Issue #${prompt.run.issue.number}: ${prompt.run.issue.title}`,
      'approval-context',
    ),
  );
  const respond = (choice, feedback) =>
    performAction(() =>
      api(`/api/prompts/${prompt.id}/respond`, {
        binding: prompt.binding,
        choice,
        ...(feedback === undefined ? {} : { feedback }),
      }),
    );
  if (prompt.kind === 'plan') {
    container.append(
      metadata([
        ['Issue', safeLink(prompt.run.issue.url, prompt.run.issue.url)],
        ['Base commit', element('code', prompt.run.baseCommit)],
        ['Worktree', element('code', prompt.run.worktree)],
      ]),
    );
    if (prompt.run.plan) container.append(planContent(prompt.run.plan));
    container.append(report('Mandatory checks', mandatoryChecks(prompt.run.repo.checks), true));
  } else if (prompt.kind === 'prepared') {
    container.append(
      element(
        'p',
        'Prepare dependencies yourself in this separate worktree, then confirm the approved checks can run offline.',
      ),
    );
    container.append(element('pre', prompt.run.worktree));
    container.append(
      element(
        'p',
        'For npm projects with a lockfile, review dependency scripts and run npm ci there. Keep production secrets out of this worktree.',
        'hint',
      ),
    );
    container.append(report('Approved checks', mandatoryChecks(prompt.run.repo.checks), true));
  } else {
    if (prompt.kind === 'ordinary-pr')
      container.append(
        element(
          'p',
          'GitHub could not create a draft PR. The approved branch may already be pushed. An ordinary PR will be ready for review immediately.',
          'run-message',
        ),
      );
    container.append(publicationContent(prompt));
  }
  const decision = element('div', undefined, 'decision');
  const descriptions = {
    plan: 'Approval applies to this plan, its allowed paths, repository and mandatory checks.',
    prepared:
      'Continue only when dependencies are ready and these checks can run without network access.',
    publication: 'This pushes the exact commit shown above and creates a draft pull request.',
    'ordinary-pr':
      'This is a separate approval to create an ordinary PR for the exact commit shown above.',
  };
  decision.append(element('p', descriptions[prompt.kind]));
  const actions = element('div', undefined, 'actions');
  const approveLabels = {
    plan: 'Approve plan',
    prepared: 'Dependencies are ready',
    publication: 'Push commit and create draft PR',
    'ordinary-pr': 'Create ordinary PR',
  };
  const rejectLabels = {
    plan: 'Reject plan',
    prepared: 'Prepare later',
    publication: 'Keep unpublished',
    'ordinary-pr': 'Do not create PR',
  };
  const approve = button(approveLabels[prompt.kind], () => respond('approve'), 'primary');
  const reject = button(rejectLabels[prompt.kind], () => respond('reject'));
  approve.dataset.promptControl = '';
  reject.dataset.promptControl = '';
  actions.append(reject, approve);
  decision.append(actions);
  if (prompt.kind === 'plan') {
    const feedback = element('details', undefined, 'feedback');
    feedback.append(element('summary', 'Request a revision'));
    const form = element('form');
    const label = element('label', 'What should change?');
    const input = element('textarea');
    input.required = true;
    input.maxLength = 12000;
    input.dataset.promptControl = '';
    label.append(input);
    const submit = element('button', 'Request revised plan');
    submit.type = 'submit';
    submit.dataset.promptControl = '';
    form.append(label, element('div', undefined, 'actions'));
    form.lastChild.append(submit);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (input.value.trim()) void respond('feedback', input.value.trim());
    });
    feedback.append(form);
    decision.append(feedback);
  }
  container.append(decision);
}

function renderSelectedRun(view) {
  const cachedDiff = state.busy ? undefined : inspectedDiffs.get(view.run.id);
  const diff = cachedDiff?.diff ?? view.diff;
  const key = JSON.stringify([view, diff]);
  if (runKey === key) return;
  runKey = key;
  const run = view.run;
  const container = byId('selected-run');
  container.replaceChildren();
  const header = element('div', undefined, 'run-header');
  const title = element('div');
  const heading = element('h2', `#${run.issue.number} ${run.issue.title}`);
  heading.id = 'selected-run-heading';
  title.append(heading, element('p', `${run.repo.fullName} · ${run.id}`));
  header.append(title, statusBadge(run.status));
  container.append(header);
  if (run.message) container.append(element('p', run.message, 'run-message'));
  container.append(
    metadata([
      ['Issue', safeLink(run.issue.url, run.issue.url)],
      ['Branch', element('code', run.branch)],
      ['Worktree', element('code', run.worktree)],
      ['Base commit', element('code', run.baseCommit)],
      [
        'Candidate commit',
        run.candidateCommit ? element('code', run.candidateCommit) : 'Not created yet',
      ],
      ['Pull request', run.prUrl ? safeLink(run.prUrl, run.prUrl) : undefined],
    ]),
  );
  const actions = element('div', undefined, 'actions');
  if (run.status !== 'completed') {
    const resume = button(
      'Resume run',
      () => startRequest(`/api/runs/${run.id}/resume`, modelOptions()),
      'primary',
    );
    resume.dataset.idleControl = '';
    actions.append(resume);
  }
  const inspect = button('Inspect current diff', () =>
    performAction(async () => {
      const result = await api(`/api/runs/${run.id}/inspect`, {});
      inspectedDiffs.set(run.id, { diff: result.diff });
      runKey = undefined;
    }),
  );
  inspect.dataset.idleControl = '';
  actions.append(inspect);
  container.append(actions);
  container.append(
    element(
      'p',
      'Resume revalidates the saved checkpoint. A closed or disconnected browser does not stop a running workflow.',
      'hint',
    ),
  );
  if (run.plan) container.append(report('Plan', planContent(run.plan), true));
  container.append(report('Mandatory checks', mandatoryChecks(run.repo.checks)));
  container.append(report('Check output', checkContent(run.checks), run.checks.length > 0));
  container.append(report('Review', reviewContent(run.review), Boolean(run.review)));
  if (run.implementationSummary)
    container.append(
      report('Implementation summary', element('p', run.implementationSummary), true),
    );
  const diffContent = element('div');
  diffContent.append(
    element(
      'pre',
      diff ??
        'No diff loaded. An active run exposes its diff when publication is ready; otherwise use Inspect current diff.',
      'diff-output',
    ),
  );
  if (cachedDiff)
    diffContent.append(
      element(
        'p',
        'Snapshot from your last inspection. Inspect again after local changes.',
        'hint',
      ),
    );
  else if (view.diff !== undefined)
    diffContent.append(element('p', 'Diff captured by the workflow for publication.', 'hint'));
  container.append(report('Diff', diffContent, diff !== undefined));
}

async function refresh() {
  if (refreshBusy || invalidSession || !token) return;
  refreshBusy = true;
  try {
    const next = await api('/api/state');
    state = next;
    if (state.operation?.status === 'running' || state.operation?.status === 'cancelling')
      inspectedDiffs.clear();
    if (refreshFailure) {
      showError();
      refreshFailure = false;
    }
    setConnection(true);
    renderRepositories(state.repos);
    const newPrompt = state.prompt && state.prompt.id !== lastPromptId;
    if (newPrompt) {
      lastPromptId = state.prompt.id;
      selectedRunId = state.prompt.run.id;
    } else if (!selectedRunId && state.runs.length) selectedRunId = state.runs[0].id;
    renderRunList(state.runs);
    renderPrompt(state.prompt);
    renderOperation(state.operation);
    byId('activity').hidden = !state.messages.length;
    byId('activity-output').textContent = state.messages.join('\n');
    if (selectedRunId) {
      const requestedId = selectedRunId;
      const view = await api(`/api/runs/${requestedId}`);
      if (selectedRunId === requestedId) renderSelectedRun(view);
    }
    applyAvailability();
  } catch (error) {
    if (error instanceof ApiError && error.status === 404 && selectedRunId) {
      selectedRunId = undefined;
      runKey = undefined;
      byId('selected-run').replaceChildren(
        element('p', 'This run is no longer available. Select another run.'),
      );
    } else {
      setConnection(false);
      if (!invalidSession) {
        refreshFailure = true;
        showError(
          `Cannot reach the local controller. Reconnecting automatically. ${error.message || ''}`,
        );
      }
    }
  } finally {
    refreshBusy = false;
  }
}

async function poll() {
  await refresh();
  if (!invalidSession) setTimeout(poll, 1000);
}

byId('start-form').addEventListener('submit', (event) => {
  event.preventDefault();
  startRequest('/api/runs', {
    repo: byId('repository').value,
    issueUrl: byId('issue-url').value.trim(),
    ...modelOptions(),
  });
});
byId('retry-request').addEventListener('click', () => {
  if (pendingRequest) void submitPendingRequest();
});
window.addEventListener('online', () => {
  void refresh();
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void refresh();
});
if (!token) {
  invalidSession = true;
  showSession(
    'Open the launch link printed by agentgate web in your terminal to authorize this browser session.',
  );
  setConnection(false);
} else {
  applyAvailability();
  void poll();
}
