import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { createHash } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Core } from '../../../packages/core/src/index.js';
import type { Provider } from '../../../packages/protocol/src/index.js';
import { probeProviders, type ProviderProbe } from '../../../packages/adapters/src/index.js';
import { inspectProject, readArtifactFile, verifyArtifact } from '../../../packages/workspace/src/index.js';
import { installSecurity } from './security.js';
import { acquireInstanceLock } from './instance-lock.js';
import { Scheduler, type RuntimeAdapter } from './scheduler.js';
import { HttpError, bool, choice, ids, integer, object, optionalText, requestId, text } from './validation.js';

export interface ServerOptions {
  dataDir: string;
  port?: number;
  webDir?: string;
  /** Trusted dependency injection; not settable through HTTP or process env. */
  runtimes?: Partial<Record<Provider, RuntimeAdapter>>;
  probe?: () => Promise<ProviderProbe[]>;
}

function contains(parent: string, child: string) {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export async function buildServer(options: ServerOptions) {
  const port = options.port ?? 3210;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid server port.');
  await mkdir(resolve(options.dataDir), { recursive: true, mode: 0o700 });
  const dataDir = await realpath(resolve(options.dataDir));
  const releaseLock = acquireInstanceLock(dataDir);
  let core: Core;
  try { core = new Core(join(dataDir, 'workbench.sqlite')); }
  catch (error) { releaseLock(); throw error; }
  const scheduler = new Scheduler(core, dataDir, options.runtimes);
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024, trustProxy: false });
  const probe = options.probe ?? (() => probeProviders());
  let connections: ProviderProbe[];
  try { connections = await probe(); }
  catch (error) { core.close(); releaseLock(); throw error; }
  const streams = new Set<() => void>();

  app.setErrorHandler((error: unknown, _request, reply) => {
    const e = error as { statusCode?: number; code?: string; message?: string };
    const status = typeof e.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 600 ? e.statusCode : 500;
    reply.status(status).send({ error: status === 500 ? '服务内部错误，请查看执行记录并重试。' : (e.message || '请求失败。'), code: e.code || 'INTERNAL_ERROR' });
  });
  installSecurity(app, port);

  app.get('/api/state', async () => ({ ...core.snapshot(), connections, dataDir }));
  app.post('/api/connections/probe', async request => {
    object(request.body, []);
    connections = await probe();
    return { connections };
  });
  app.post('/api/projects', async request => {
    const body = object(request.body, ['name', 'path']);
    const info = await inspectProject(text(body.path, '项目目录', 4096));
    if (contains(info.path, dataDir) || contains(dataDir, info.path)) throw new HttpError('DATA_DIRECTORY_OVERLAP', '项目目录不能包含工作台数据库、凭据或成果目录，也不能位于这些目录内。请选择独立的 Git 项目。');
    return core.addProject({ name: text(body.name, '项目名称', 120), path: info.path, baseCommit: info.baseCommit });
  });
  app.post('/api/profiles', async request => {
    const body = object(request.body, ['id', 'name', 'role', 'provider', 'model', 'instructions', 'enabled', 'expectedVersion']);
    const profile = core.saveProfile({
      id: optionalText(body.id, '员工编号', 120), name: text(body.name, '员工名称', 120),
      role: choice(body.role, '职责', ['implementer', 'reviewer', 'acceptance'] as const),
      provider: choice(body.provider, '工具', ['codex', 'antigravity', 'deepseek-harness'] as const),
      model: body.model == null || body.model === '' ? undefined : text(body.model, '模型', 200),
      instructions: body.instructions === '' ? '' : optionalText(body.instructions, '职责说明'),
      enabled: body.enabled === undefined ? undefined : bool(body.enabled, '启用状态'),
      expectedVersion: body.expectedVersion === undefined ? undefined : integer(body.expectedVersion, '档案版本', 1),
    });
    if (profile.enabled) scheduler.kick();
    return profile;
  });
  app.post('/api/rules', async request => {
    const body = object(request.body, ['id', 'scope', 'projectId', 'profileId', 'kind', 'content', 'source', 'confirmed', 'expectedVersion']);
    if (body.confirmed !== true) throw new HttpError('CONFIRMATION_REQUIRED', '长期规则需要用户明确确认后保存。');
    return core.saveRule({
      id: optionalText(body.id, '规则编号', 120),
      scope: choice(body.scope, '规则范围', ['global', 'project', 'role'] as const),
      projectId: body.projectId == null ? undefined : text(body.projectId, '项目编号', 120),
      profileId: body.profileId == null ? undefined : text(body.profileId, '员工编号', 120),
      kind: choice(body.kind, '规则类型', ['rule', 'preference', 'fact', 'experience'] as const),
      content: text(body.content, '规则内容'), source: optionalText(body.source, '来源', 2000), confirmed: true,
      expectedVersion: body.expectedVersion === undefined ? undefined : integer(body.expectedVersion, '规则版本', 1),
    });
  });
  app.get('/api/rules/export', async (_request, reply) => {
    const rules = core.snapshot().rules;
    reply.header('Content-Disposition', 'attachment; filename="agent-cowork-rules.md"').type('text/markdown; charset=utf-8');
    return `# Agent Cowork 规则导出\n\n导入时需要用户检查范围和内容并确认。\n\n${rules.map(rule => `## ${rule.id} · v${rule.version}\n\n范围：${rule.scope}；项目：${rule.projectId ?? '无'}；角色：${rule.profileId ?? '无'}\n\n类型：${rule.kind}；来源：${rule.source}\n\n${rule.content}\n`).join('\n')}`;
  });
  app.post('/api/tasks', async request => {
    const body = object(request.body, ['requestId', 'projectId', 'title', 'goal', 'criteria', 'ownerId', 'reviewerIds']);
    return core.createTask({ requestId: requestId(body.requestId), projectId: text(body.projectId, '项目编号', 120), title: text(body.title, '任务标题', 160), goal: text(body.goal, '目标'), criteria: text(body.criteria, '验收条件'), ownerId: text(body.ownerId, '负责人', 120), reviewerIds: ids(body.reviewerIds) });
  });
  app.post<{ Params: { id: string } }>('/api/tasks/:id/start', async request => {
    const body = object(request.body, ['requestId', 'version']);
    const id = requestId(body.requestId); const expectedVersion = integer(body.version, '任务版本', 1);
    const task = core.getTask(request.params.id);
    const snapshot = core.snapshot();
    const workspacePath = join(dataDir, 'workspaces', createHash('sha256').update(id).digest('hex').slice(0, 32));
    // Duplicate transport delivery returns the original result even if the
    // provider subsequently becomes unavailable. Core rejects content reuse.
    if (!snapshot.commands.some(command => command.id === id)) {
      const participants = [task.ownerId, ...task.reviewerIds];
      for (const [index, profileId] of participants.entries()) {
        const profile = snapshot.profiles.find(item => item.id === profileId);
        if (!profile) throw new HttpError('PROFILE_NOT_FOUND', '员工档案不存在。', 404);
        scheduler.ensureAvailable(profile.provider, index === 0 ? 'implement' : 'review');
      }
      const project = snapshot.projects.find(item => item.id === task.projectId)!;
      const info = await inspectProject(project.path);
      if (info.dirty) throw new HttpError('DIRTY_PROJECT', '项目存在未提交修改，请先自行处理后再派单。', 409);
      if (info.baseCommit !== project.baseCommit) throw new HttpError('BASELINE_CHANGED', '项目基准已变化，请重新登记项目并确认基准。', 409);
    }
    const run = core.enqueueTask({ requestId: id, taskId: task.id, expectedVersion, workspacePath });
    scheduler.kick();
    return run;
  });
  app.post<{ Params: { id: string } }>('/api/tasks/:id/stop', async request => {
    const body = object(request.body, ['cancel']);
    return scheduler.stopTask(request.params.id, body.cancel === undefined ? false : bool(body.cancel, '取消'));
  });
  app.post<{ Params: { id: string } }>('/api/tasks/:id/rework', async request => {
    const body = object(request.body, ['requestId', 'version', 'ownerId', 'goal', 'criteria']);
    if (scheduler.isTaskBusy(request.params.id)) throw new HttpError('FINALIZATION_PENDING', '原执行或成果保存尚未结束，请稍后再确认返工。', 409);
    return core.reworkTask({ requestId: requestId(body.requestId), taskId: request.params.id, expectedVersion: integer(body.version, '任务版本', 1), ownerId: optionalText(body.ownerId, '负责人', 120), goal: optionalText(body.goal, '目标'), criteria: optionalText(body.criteria, '验收条件') });
  });
  app.post<{ Params: { id: string } }>('/api/tasks/:id/accept', async request => {
    const body = object(request.body, ['requestId', 'version', 'artifactId', 'comment']);
    const artifact = core.getArtifact(text(body.artifactId, '成果版本', 120));
    await verifyArtifact(artifact.path, artifact.hash);
    return core.acceptTask({ requestId: requestId(body.requestId), taskId: request.params.id, expectedVersion: integer(body.version, '任务版本', 1), artifactId: text(body.artifactId, '成果版本', 120), comment: body.comment === '' ? '' : optionalText(body.comment, '验收意见') }, 'user');
  });
  app.post<{ Params: { id: string } }>('/api/tasks/:id/comment', async request => {
    const body = object(request.body, ['text']);
    return core.comment(request.params.id, text(body.text, '讨论内容'), 'user');
  });
  app.post<{ Params: { id: string } }>('/api/tasks/:id/skip-review', async request => {
    const body = object(request.body, ['version', 'profileId', 'artifactId', 'reason']);
    return core.skipReview({ taskId: request.params.id, expectedVersion: integer(body.version, '任务版本', 1), profileId: text(body.profileId, '复核者', 120), artifactId: text(body.artifactId, '成果版本', 120), reason: text(body.reason, '跳过原因', 2000) }, 'user');
  });
  app.post('/api/control/pause', async request => {
    const body = object(request.body, ['paused']);
    const paused = core.setPaused(bool(body.paused, '暂停状态'));
    if (!paused) scheduler.kick();
    return { paused };
  });
  app.post('/api/control/stop-all', async request => { object(request.body, []); return scheduler.stopAll(); });
  app.post<{ Params: { id: string } }>('/api/approvals/:id/respond', async request => {
    const body = object(request.body, ['answer']); const answer = text(body.answer, '审批决定', 2000);
    if (!scheduler.canAnswer(request.params.id)) throw new HttpError('STALE_REQUEST', '原生审批已断开或失效。', 409);
    const approval = core.answerApproval(request.params.id, answer, 'user');
    scheduler.deliverAnswer(request.params.id, answer); return approval;
  });
  app.post<{ Params: { id: string } }>('/api/questions/:id/respond', async request => {
    const body = object(request.body, ['answer']); const answer = text(body.answer, '回答');
    if (!scheduler.canAnswer(request.params.id)) throw new HttpError('STALE_REQUEST', '原生提问已断开或失效。', 409);
    const question = core.answerQuestion(request.params.id, answer, 'user');
    scheduler.deliverAnswer(request.params.id, answer); return question;
  });
  app.get<{ Params: { id: string }; Querystring: { path?: string } }>('/api/artifacts/:id/file', async (request, reply) => {
    const artifact = core.snapshot().artifacts.find(item => item.id === request.params.id);
    if (!artifact) throw new HttpError('ARTIFACT_NOT_FOUND', '成果不存在。', 404);
    const file = text(request.query.path, '成果文件路径', 4096);
    const content = await readArtifactFile(artifact.path, file, artifact.hash);
    reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(basename(file))}`).type('application/octet-stream');
    return content;
  });
  app.get<{ Querystring: { after?: string } }>('/api/events', async (request, reply) => {
    const after = request.headers['last-event-id'] ?? request.query.after ?? '0';
    if (typeof after !== 'string' || !/^\d+$/.test(after) || !Number.isSafeInteger(Number(after))) throw new HttpError('INVALID_CURSOR', '事件序号无效。');
    let cursor = Number(after);
    reply.hijack();
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'Connection': 'keep-alive', 'X-Content-Type-Options': 'nosniff' });
    reply.raw.write(': connected\n\n');
    const emit = () => {
      for (const event of core.eventsAfter(cursor)) {
        reply.raw.write(`id: ${event.seq}\nevent: change\ndata: ${JSON.stringify(event)}\n\n`);
        cursor = event.seq;
      }
    };
    emit();
    const poll = setInterval(emit, 300); poll.unref();
    const heartbeat = setInterval(() => reply.raw.write(': heartbeat\n\n'), 15_000); heartbeat.unref();
    const cleanup = () => { clearInterval(poll); clearInterval(heartbeat); streams.delete(cleanup); if (!reply.raw.writableEnded) reply.raw.end(); };
    streams.add(cleanup); reply.raw.on('close', cleanup);
  });

  const webDir = options.webDir ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist');
  if (existsSync(join(webDir, 'index.html'))) {
    await app.register(fastifyStatic, { root: webDir, index: ['index.html'] });
    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith('/api/')) return reply.code(404).send({ error: '接口不存在。', code: 'NOT_FOUND' });
      return reply.sendFile('index.html');
    });
  } else {
    app.get('/', async (_request, reply) => reply.code(503).type('text/plain; charset=utf-8').send('网页尚未构建。请在项目目录执行 npm run build，然后重新启动。'));
  }
  app.addHook('preClose', async () => {
    for (const close of streams) close();
  });
  app.addHook('onClose', async () => {
    try { await scheduler.close(); }
    finally { try { core.close(); } finally { releaseLock(); } }
  });
  scheduler.kick();
  return { app, core, scheduler, dataDir };
}
