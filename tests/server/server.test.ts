import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '../../apps/server/src/index.js';
import { Scheduler, type RuntimeAdapter } from '../../apps/server/src/scheduler.js';

const host = '127.0.0.1:3210';
const origin = `http://${host}`;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function removeFixture(root: string) {
  async function unlock(path: string) {
    await chmod(path, 0o700);
    for (const entry of await readdir(path, { withFileTypes: true })) if (entry.isDirectory()) await unlock(join(path, entry.name));
  }
  await unlock(root); await rm(root, { recursive: true, force: true });
}
async function fixture(runtimes?: Parameters<typeof buildServer>[0]['runtimes']) {
  const root = await mkdtemp(join(tmpdir(), 'acw-http-'));
  const projectPath = join(root, '中文 project');
  await mkdir(projectPath);
  git(projectPath, 'init'); git(projectPath, 'config', 'user.name', 'Fixture'); git(projectPath, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(projectPath, 'README.md'), 'Committed baseline\n');
  git(projectPath, 'add', '.'); git(projectPath, 'commit', '-m', 'baseline');
  const server = await buildServer({ dataDir: join(root, 'data'), probe: async () => [], runtimes });
  const session = await server.app.inject({ method: 'GET', url: '/api/session', headers: { host } });
  const cookie = String(session.headers['set-cookie']).split(';')[0];
  const csrf = session.json().csrfToken;
  const headers = { host, origin, cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' };
  const post = (url: string, payload: Record<string, unknown>) => server.app.inject({ method: 'POST', url, headers, payload });
  return { ...server, root, projectPath, cookie, csrf, headers, post, async cleanup() { await server.app.close(); await removeFixture(root); } };
}

test('API protects session bootstrap, Host, Origin, CSRF and malformed tokens', async () => {
  const f = await fixture();
  try {
    const response = await f.app.inject({ method: 'GET', url: '/api/state', headers: { host } });
    assert.equal(response.statusCode, 401);
    for (const headers of [{ host: 'evil.example:3210' }, { host, origin: 'https://evil.example' }, { host, 'sec-fetch-site': 'cross-site' }]) {
      assert.equal((await f.app.inject({ method: 'GET', url: '/api/session', headers })).statusCode, 403);
    }
    const malformedCookie = await f.app.inject({ method: 'GET', url: '/api/state', headers: { host, cookie: `acw_session=${'你'.repeat(64)}` } });
    assert.equal(malformedCookie.statusCode, 401);
    const malformedCsrf = await f.app.inject({ method: 'POST', url: '/api/control/pause', headers: { ...f.headers, 'x-csrf-token': '你'.repeat(64) }, payload: { paused: true } });
    assert.equal(malformedCsrf.statusCode, 403);
    const noOrigin = await f.app.inject({ method: 'POST', url: '/api/control/pause', headers: { host, cookie: f.cookie, 'x-csrf-token': f.csrf }, payload: { paused: true } });
    assert.equal(noOrigin.statusCode, 403);
    assert.equal((await f.post('/api/control/pause', { paused: true, actor: 'agent' })).statusCode, 400);
    assert.equal((await f.post('/api/control/pause', { paused: true })).statusCode, 200);
    assert.equal(f.core.snapshot().paused, true);
  } finally { await f.cleanup(); }
});

test('real provider start fails closed without creating an execution; duplicate task and stale rules are rejected', async () => {
  const f = await fixture();
  try {
    const project = (await f.post('/api/projects', { name: '测试项目', path: f.projectPath })).json();
    assert.ok(project.id);
    const payload = { requestId: 'create-task-1', projectId: project.id, title: '新增文档', goal: '写出结果', criteria: '文件存在', ownerId: 'codex-implementer', reviewerIds: ['harness-reviewer'] };
    const first = await f.post('/api/tasks', payload);
    assert.equal(first.statusCode, 200);
    assert.equal((await f.post('/api/tasks', payload)).json().id, first.json().id);
    assert.equal((await f.post('/api/tasks', { ...payload, title: 'changed' })).statusCode, 409);
    const task = first.json();
    const start = await f.post(`/api/tasks/${task.id}/start`, { requestId: 'start-1', version: task.version });
    assert.equal(start.statusCode, 409);
    assert.equal(start.json().code, 'PROVIDER_UNVERIFIED');
    assert.equal(f.core.snapshot().runs.length, 0);
    const rule = (await f.post('/api/rules', { scope: 'project', projectId: project.id, kind: 'rule', content: '使用中文', confirmed: true })).json();
    assert.equal((await f.post('/api/rules', { id: rule.id, expectedVersion: 0, scope: 'project', projectId: project.id, kind: 'rule', content: 'Use English', confirmed: true })).statusCode, 400);
    assert.equal((await f.post('/api/rules', { id: rule.id, expectedVersion: rule.version, scope: 'project', projectId: project.id, kind: 'rule', content: '先写结论', confirmed: true })).statusCode, 200);
    assert.equal((await f.post('/api/rules', { id: rule.id, expectedVersion: rule.version, scope: 'project', projectId: project.id, kind: 'rule', content: 'stale', confirmed: true })).statusCode, 409);
  } finally { await f.cleanup(); }
});

test('injected fixture executes actual worktree, captures fixed artifacts, two reviews and versioned user acceptance', async () => {
  const seen: string[] = [];
  const runner: RuntimeAdapter = {
    supports: () => true,
    async submit(run, events) {
      seen.push(run.role);
      events.accepted(`fixture-session-${run.id}`);
      if (run.role === 'implement') {
        await writeFile(join(run.workspacePath, 'result.txt'), '可检查的成果\n');
        return { status: 'succeeded', evidence: 'Fixture returned a normal end after writing result.txt.', summary: '写入成果文件。' };
      }
      assert.equal(await readFile(join(run.workspacePath, 'result.txt'), 'utf8'), '可检查的成果\n');
      return { status: 'succeeded', evidence: 'Fixture reviewer returned a normal end.', review: { verdict: 'pass', text: '已核对固定版本文件。' } };
    },
    async cancel() {},
  };
  const f = await fixture({ codex: runner, antigravity: runner, 'deepseek-harness': runner });
  try {
    const project = (await f.post('/api/projects', { name: '端到端夹具', path: f.projectPath })).json();
    const task = (await f.post('/api/tasks', { requestId: 'fixture-task', projectId: project.id, title: '生成固定成果', goal: '写入 result.txt', criteria: '文件内容可读并经复核', ownerId: 'codex-implementer', reviewerIds: ['harness-reviewer', 'antigravity-checker'] })).json();
    assert.equal((await f.post(`/api/tasks/${task.id}/start`, { requestId: 'fixture-start', version: task.version })).statusCode, 200);
    await f.scheduler.idle();
    const state = f.core.snapshot();
    const finished = f.core.getTask(task.id);
    assert.deepEqual(seen, ['implement', 'review', 'review']);
    assert.equal(finished.status, 'awaiting_acceptance', JSON.stringify(state.events));
    assert.equal(state.artifacts.length, 1); assert.equal(state.reviews.length, 2);
    assert.equal(git(f.projectPath, 'status', '--porcelain'), '');
    const downloaded = await f.app.inject({ method: 'GET', url: `/api/artifacts/${finished.artifactId}/file?path=result.txt`, headers: { host, cookie: f.cookie } });
    assert.equal(downloaded.statusCode, 200); assert.equal(downloaded.body, '可检查的成果\n');
    const stale = await f.post(`/api/tasks/${task.id}/accept`, { requestId: 'bad-accept', version: task.version, artifactId: finished.artifactId });
    assert.equal(stale.statusCode, 409);
    const accepted = await f.post(`/api/tasks/${task.id}/accept`, { requestId: 'good-accept', version: finished.version, artifactId: finished.artifactId, comment: '用户确认当前成果。' });
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.equal(f.core.getTask(task.id).status, 'completed');
    const branch = git(f.projectPath, 'rev-parse', 'HEAD');
    assert.equal(branch, project.baseCommit, 'acceptance must not merge or commit project changes');
  } finally { await f.cleanup(); }
});

test('data directories cannot overlap agent projects; durable user changes survive service restart', async () => {
  const f = await fixture();
  try {
    await f.post('/api/control/pause', { paused: true });
    await f.app.close();
    const reopened = await buildServer({ dataDir: join(f.root, 'data'), probe: async () => [] });
    assert.equal(reopened.core.snapshot().paused, true);
    await reopened.app.close();
    const overlap = await buildServer({ dataDir: join(f.projectPath, '..app-data'), probe: async () => [] });
    const session = await overlap.app.inject({ method: 'GET', url: '/api/session', headers: { host } });
    const response = await overlap.app.inject({ method: 'POST', url: '/api/projects', headers: { host, origin, cookie: String(session.headers['set-cookie']).split(';')[0], 'x-csrf-token': session.json().csrfToken }, payload: { name: '拒绝重叠', path: f.projectPath } });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().code, 'DATA_DIRECTORY_OVERLAP');
    await overlap.app.close();
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('duplicate native questions and approvals share pending answers and replay the recorded answer', async () => {
  let questionReady!: () => void; let approvalReady!: () => void;
  const questionPending = new Promise<void>(resolve => { questionReady = resolve; });
  const approvalPending = new Promise<void>(resolve => { approvalReady = resolve; });
  const runner: RuntimeAdapter = {
    supports: () => true,
    async submit(run, callbacks) {
      callbacks.accepted('fixture-question-session');
      const question = { nativeId: 'same-question', prompt: '使用什么标题？' };
      const a = callbacks.question(question); const b = callbacks.question(question);
      assert.equal(a, b); questionReady();
      assert.deepEqual(await Promise.all([a, b]), ['标题', '标题']);
      assert.equal(await callbacks.question(question), '标题');
      const approval = { nativeId: 'same-approval', kind: 'file', prompt: '允许写入本任务文件？', options: ['allow-once', 'deny'] };
      const c = callbacks.approval(approval); const d = callbacks.approval(approval);
      assert.equal(c, d); approvalReady();
      assert.deepEqual(await Promise.all([c, d]), ['allow-once', 'allow-once']);
      assert.equal(await callbacks.approval(approval), 'allow-once');
      await writeFile(join(run.workspacePath, 'answer.txt'), '标题\n');
      return { status: 'succeeded', evidence: 'Fixture normal end after user answers.' };
    },
    async cancel() {},
  };
  const f = await fixture({ codex: runner });
  try {
    const project = (await f.post('/api/projects', { name: '问题回传', path: f.projectPath })).json();
    const task = (await f.post('/api/tasks', { requestId: 'question-task', projectId: project.id, title: '询问后执行', goal: '生成标题', criteria: '用户确认', ownerId: 'codex-implementer' })).json();
    await f.post(`/api/tasks/${task.id}/start`, { requestId: 'question-start', version: task.version });
    await questionPending;
    const question = f.core.snapshot().questions[0];
    assert.equal((await f.post(`/api/questions/${question.id}/respond`, { answer: '标题' })).statusCode, 200);
    await approvalPending;
    const approval = f.core.snapshot().approvals[0];
    assert.equal((await f.post(`/api/approvals/${approval.id}/respond`, { answer: 'invented-option' })).statusCode, 400);
    assert.equal((await f.post(`/api/approvals/${approval.id}/respond`, { answer: 'allow-once' })).statusCode, 200);
    await f.scheduler.idle();
    assert.equal(f.core.snapshot().questions.length, 1); assert.equal(f.core.snapshot().approvals.length, 1);
    assert.equal(f.core.getTask(task.id).status, 'awaiting_acceptance');
  } finally { await f.cleanup(); }
});

test('late artifact finalization failure cannot freeze a newer user-confirmed flow', async () => {
  const f = await fixture();
  let captureReached!: () => void; let releaseCapture!: () => void;
  const captureStarted = new Promise<void>(resolve => { captureReached = resolve; });
  const release = new Promise<void>(resolve => { releaseCapture = resolve; });
  const runner: RuntimeAdapter = { supports: () => true, async submit(run, callbacks) {
    callbacks.accepted('fixture-late-session');
    await writeFile(join(run.workspacePath, 'output.txt'), 'complete\n');
    return { status: 'succeeded', evidence: 'Fixture normal end.' };
  }, async cancel() {} };
  const scheduler = new Scheduler(f.core, f.dataDir, { codex: runner }, { capture: async () => { captureReached(); await release; throw new Error('Delayed old artifact failure.'); } });
  try {
    const project = (await f.post('/api/projects', { name: '迟到成果', path: f.projectPath })).json();
    const task = f.core.createTask({ requestId: 'late-task', projectId: project.id, title: '旧流程', goal: '生成成果', criteria: '文件存在', ownerId: 'codex-implementer' });
    f.core.enqueueTask({ requestId: 'late-start', taskId: task.id, expectedVersion: task.version, workspacePath: join(f.dataDir, 'workspaces', 'late-fixture') });
    scheduler.kick(); await captureStarted;
    const newer = f.core.reworkTask({ requestId: 'new-flow', taskId: task.id, expectedVersion: f.core.getTask(task.id).version, goal: '新目标' });
    releaseCapture(); await scheduler.idle();
    assert.equal(f.core.getTask(task.id).flow, newer.flow);
    assert.equal(f.core.getTask(task.id).status, 'pending');
    assert.equal(f.core.getTask(task.id).frozen, false);
  } finally { releaseCapture(); await scheduler.close(); await f.cleanup(); }
});

test('a second process lease is refused before it can recover or mutate live state', async () => {
  const f = await fixture();
  try {
    const project = f.core.addProject({ name: '活跃任务', path: f.projectPath, baseCommit: git(f.projectPath, 'rev-parse', 'HEAD') });
    const task = f.core.createTask({ requestId: 'lease-task', projectId: project.id, title: '活动执行', goal: '验证互斥', criteria: '不被另一个进程恢复', ownerId: 'codex-implementer' });
    const run = f.core.enqueueTask({ requestId: 'lease-start', taskId: task.id, expectedVersion: task.version, workspacePath: join(f.dataDir, 'workspaces', 'lease-fixture') });
    f.core.claimNext();
    await assert.rejects(buildServer({ dataDir: f.dataDir, port: 3211, probe: async () => [] }), (error: unknown) => (error as { code: string }).code === 'INSTANCE_RUNNING');
    assert.equal(f.core.getRun(run.id).status, 'sending');
    assert.equal(f.core.getTask(task.id).frozen, false);
    await f.app.close();
    const reopened = await buildServer({ dataDir: f.dataDir, probe: async () => [] });
    assert.equal(reopened.core.getRun(run.id).status, 'unverified');
    assert.equal(reopened.core.getTask(task.id).frozen, true);
    await reopened.app.close();
  } finally { await removeFixture(f.root); }
});

test('re-enabling an employee resumes its queued work without requiring an unrelated action', async () => {
  const runner: RuntimeAdapter = { supports: () => true, async submit(run, events) {
    events.accepted('fixture-enabled-session'); await writeFile(join(run.workspacePath, 'result.txt'), 'resumed\n');
    return { status: 'succeeded', evidence: 'Fixture normal end after profile enabled.' };
  }, async cancel() {} };
  const f = await fixture({ codex: runner });
  try {
    const project = (await f.post('/api/projects', { name: '排队任务', path: f.projectPath })).json();
    const task = f.core.createTask({ requestId: 'disabled-task', projectId: project.id, title: '恢复员工', goal: '执行排队任务', criteria: '生成结果', ownerId: 'codex-implementer' });
    f.core.enqueueTask({ requestId: 'disabled-start', taskId: task.id, expectedVersion: task.version, workspacePath: join(f.dataDir, 'workspaces', 'disabled-fixture') });
    const initial = f.core.getProfile('codex-implementer');
    const disabled = f.core.saveProfile({ ...initial, expectedVersion: initial.version, enabled: false });
    f.scheduler.kick(); await f.scheduler.idle();
    assert.equal(f.core.snapshot().runs[0].status, 'queued');
    const enabled = await f.post('/api/profiles', { id: disabled.id, name: disabled.name, role: disabled.role, provider: disabled.provider, instructions: disabled.instructions, enabled: true, expectedVersion: disabled.version });
    assert.equal(enabled.statusCode, 200);
    await f.scheduler.idle();
    assert.equal(f.core.getTask(task.id).status, 'awaiting_acceptance');
  } finally { await f.cleanup(); }
});

test('SSE resumes after a persisted sequence and active streams close with the server', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'acw-sse-'));
  const port = 20_000 + process.pid % 10_000;
  const server = await buildServer({ dataDir: root, port, probe: async () => [] });
  const abort = new AbortController();
  let closed = false;
  try {
    const project = server.core.addProject({ name: '事件恢复', path: join(root, 'source'), baseCommit: 'a'.repeat(40) });
    const task = server.core.createTask({ requestId: 'sse-task', projectId: project.id, title: '记录事件', goal: '恢复进度', criteria: '不重复事件', ownerId: 'codex-implementer' });
    const previous = server.core.eventsAfter(0).at(-1)!;
    const next = server.core.comment(task.id, '下一条持久事件');
    await server.app.listen({ host: '127.0.0.1', port });
    const session = await fetch(`http://127.0.0.1:${port}/api/session`);
    const cookie = session.headers.get('set-cookie')!.split(';')[0]; await session.json();
    const response = await fetch(`http://127.0.0.1:${port}/api/events`, { headers: { cookie, 'Last-Event-ID': String(previous.seq) }, signal: abort.signal });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader(); const decoder = new TextDecoder(); let data = '';
    while (!data.includes('event: change')) {
      const chunk = await reader.read(); assert.equal(chunk.done, false); data += decoder.decode(chunk.value);
    }
    assert.match(data, new RegExp(`^id: ${next.seq}$`, 'm'));
    assert.doesNotMatch(data, new RegExp(`^id: ${previous.seq}$`, 'm'));
    assert.match(data, /下一条持久事件/);
    await server.app.close(); closed = true;
    while (!(await reader.read()).done) { /* drain already-written event bytes */ }
  } finally { abort.abort(); if (!closed) await server.app.close(); await removeFixture(root); }
});

test('stop returns persisted stopping intent even when native cancellation does not respond', { timeout: 10_000 }, async () => {
  let accepted!: () => void; let complete!: () => void;
  const started = new Promise<void>(resolve => { accepted = resolve; });
  const done = new Promise<void>(resolve => { complete = resolve; });
  const runner: RuntimeAdapter = { supports: () => true, async submit(_run, events) {
    events.accepted('fixture-stop-session'); accepted(); await done;
    return { status: 'stopped', evidence: 'Fixture observed execution actually ended.' };
  }, cancel: () => new Promise<void>(() => {}) };
  const f = await fixture({ codex: runner });
  try {
    const project = (await f.post('/api/projects', { name: '停止核对', path: f.projectPath })).json();
    const task = (await f.post('/api/tasks', { requestId: 'stop-task', projectId: project.id, title: '停止请求', goal: '停止不伪造完成', criteria: '保留占用直到确认', ownerId: 'codex-implementer' })).json();
    await f.post(`/api/tasks/${task.id}/start`, { requestId: 'stop-start', version: task.version });
    await started;
    const response = await f.post(`/api/tasks/${task.id}/stop`, {});
    assert.equal(response.statusCode, 200);
    assert.equal(f.core.snapshot().runs[0].status, 'stopping');
    assert.equal(f.core.getTask(task.id).frozen, true);
    complete(); await f.scheduler.idle();
    assert.equal(f.core.snapshot().runs[0].status, 'stopped');
  } finally { complete(); await f.cleanup(); }
});
