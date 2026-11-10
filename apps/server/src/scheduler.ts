import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { Core } from '../../../packages/core/src/index.js';
import type { Provider, Run, RunRole, Usage } from '../../../packages/protocol/src/index.js';
import { captureArtifact, createTaskWorkspace, verifyArtifact } from '../../../packages/workspace/src/index.js';
import { HttpError } from './validation.js';

export interface RuntimeCallbacks {
  accepted(nativeSessionId?: string, nativeTurnId?: string): void;
  progress(text: string): void;
  approval(input: { nativeId: string; kind: string; prompt: string; options: string[] }): Promise<string>;
  question(input: { nativeId: string; prompt: string }): Promise<string>;
}
export interface RuntimeResult {
  status: 'succeeded' | 'failed' | 'stopped' | 'unverified';
  evidence: string;
  summary?: string;
  usage?: Usage;
  review?: { verdict: 'pass' | 'changes_requested'; text: string };
}
/** Explicit dependency injection for verified runtimes and integration fixtures.
 * There is deliberately no HTTP/configuration switch for an unverified runtime. */
export interface RuntimeAdapter {
  supports(role: RunRole): boolean;
  submit(run: Run, callbacks: RuntimeCallbacks): Promise<RuntimeResult>;
  cancel(run: Run): Promise<void>;
}
interface WaitingAnswer { resolve(answer: string): void; reject(reason: Error): void; runId: string; promise: Promise<string> }

export class Scheduler {
  private running = false;
  private closing = false;
  private closed = false;
  private active = new Map<string, RuntimeAdapter>();
  private answers = new Map<string, WaitingAnswer>();
  private work: Promise<void> = Promise.resolve();

  constructor(private core: Core, private dataDir: string, private runtimes: Partial<Record<Provider, RuntimeAdapter>> = {}, private services: { capture?: typeof captureArtifact } = {}) {}

  isTaskBusy(taskId: string) { return [...this.active.keys()].some(runId => this.core.getRun(runId).taskId === taskId); }

  private waitForAnswer(record: { id: string; runId: string; status: 'pending' | 'answered' | 'expired'; answer: string | null }): Promise<string> {
    if (record.status === 'answered' && record.answer !== null) return Promise.resolve(record.answer);
    if (record.status !== 'pending') return Promise.reject(new Error('原生请求已经失效。'));
    const existing = this.answers.get(record.id);
    if (existing) return existing.promise;
    let resolve!: (answer: string) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<string>((done, fail) => { resolve = done; reject = fail; });
    this.answers.set(record.id, { resolve, reject, runId: record.runId, promise });
    return promise;
  }

  ensureAvailable(provider: Provider, role: RunRole) {
    if (!this.runtimes[provider]?.supports(role)) throw new HttpError('PROVIDER_UNVERIFIED', `${provider} 的${role === 'implement' ? '执行' : '只读复核'}能力尚未完成真实兼容性验证，当前不能派单。请先按 docs/compatibility.md 完成验证。`, 409);
  }

  kick() {
    if (this.running || this.closing) return;
    this.running = true;
    this.work = (async () => {
      try {
        for (;;) {
          if (this.closing) return;
          const run = this.core.claimNext();
          if (!run) return;
          await this.execute(run);
        }
      } finally { this.running = false; }
    })();
    // API enqueue success is independent of asynchronous execution. Errors are
    // persisted by execute; never spawn an unhandled rejection in the server.
    void this.work.catch(() => undefined);
  }

  async idle() { await this.work; }

  private event(run: Run, type: string, text: string, extra: Record<string, unknown> = {}) {
    if (this.closed) return;
    return this.core.recordEvent({ id: randomUUID(), runId: run.id, type, source: 'tool', text, ...extra });
  }

  private async execute(run: Run) {
    let submitted = false;
    try {
      this.ensureAvailable(run.provider, run.role);
      const runtime = this.runtimes[run.provider]!;
      if (run.role === 'implement') {
        await createTaskWorkspace(run.context.project.path, run.context.project.baseCommit, dirname(run.workspacePath), basename(run.workspacePath));
      } else {
        const artifact = this.core.snapshot().artifacts.find(item => item.id === run.artifactId);
        if (!artifact) throw new Error('复核成果不存在。');
        await verifyArtifact(artifact.path, artifact.hash);
      }
      // User may have requested stop while Git preparation was in progress.
      if (['stopping', 'stopped'].includes(this.core.getRun(run.id).status)) {
        if (this.core.getRun(run.id).status !== 'stopped') this.event(run, 'run.stopped', '原生投递尚未开始，已确认停止。', { status: 'stopped', evidence: 'No native request sent.' });
        return;
      }
      this.active.set(run.id, runtime);
      submitted = true;
      const result = await runtime.submit(run, {
        accepted: (nativeSessionId, nativeTurnId) => {
          this.event(run, 'run.accepted', '工具已确认接受本次执行。', { status: 'accepted', nativeSessionId, nativeTurnId });
          this.event(run, 'run.running', '工具正在执行。', { status: 'running' });
        },
        progress: message => this.event(run, 'run.progress', message.slice(0, 50_000)),
        approval: input => {
          const approval = this.core.addApproval({ runId: run.id, ...input });
          return this.waitForAnswer(approval);
        },
        question: input => {
          const question = this.core.addQuestion({ runId: run.id, ...input });
          return this.waitForAnswer(question);
        },
      });
      if (this.closed) return;
      if (!result.evidence?.trim()) throw new Error('工具未提供终态证据，执行结果待核实。');
      this.event(run, `run.${result.status}`, result.summary || result.evidence, { status: result.status, evidence: result.evidence, usage: result.usage });
      if (result.status !== 'succeeded') return;
      if (run.role === 'implement') {
        const captured = await (this.services.capture ?? captureArtifact)({ workspacePath: run.workspacePath, baseCommit: run.context.project.baseCommit, artifactRoot: join(this.dataDir, 'artifacts'), artifactId: randomUUID(), runId: run.id, summary: result.summary });
        const artifact = this.core.addArtifact({ runId: run.id, path: captured.path, hash: captured.artifactHash, files: captured.manifest, summary: captured.summary, diff: await readFile(captured.diffPath, 'utf8'), baseCommit: captured.baseCommit });
        const task = this.core.getTask(run.taskId);
        if (!task.frozen && !task.cancelRequested) {
          for (const profileId of task.reviewerIds) {
            this.core.enqueueReview({ requestId: `review:${run.id}:${profileId}`, taskId: task.id, profileId, artifactId: artifact.id, workspacePath: captured.snapshotPath });
          }
        }
      } else {
        if (!result.review || !run.artifactId) throw new Error('复核执行没有返回有效意见。');
        this.core.addReview({ runId: run.id, artifactId: run.artifactId, ...result.review });
      }
    } catch (error) {
      if (this.closed) return;
      const message = error instanceof Error ? error.message : '执行发生错误。';
      const latest = this.core.getRun(run.id);
      if (!['succeeded', 'failed', 'stopped'].includes(latest.status)) {
        this.event(run, submitted ? 'run.unverified' : 'run.prepare_failed', message, { status: submitted ? 'unverified' : 'failed', evidence: submitted ? undefined : 'Preparation failed before any native submission.' });
      } else {
        // A completed native turn can still fail to produce an inspectable
        // artifact. Keep its terminal evidence; never fabricate a second run.
        const currentTask = this.core.getTask(run.taskId);
        if (currentTask.flow === run.flow && currentTask.ownerGeneration === run.ownerGeneration && !['completed', 'cancelled'].includes(currentTask.status)) {
          this.core.blockTask(run.taskId, `成果或复核记录保存失败：${message}`);
        }
      }
    } finally {
      this.active.delete(run.id);
      for (const [id, waiting] of this.answers) {
        if (waiting.runId === run.id) { this.answers.delete(id); waiting.reject(new Error('执行已结束，问题不再有效。')); }
      }
    }
  }

  canAnswer(id: string) { return this.answers.has(id); }
  deliverAnswer(id: string, answer: string) {
    const waiting = this.answers.get(id);
    if (!waiting) throw new HttpError('STALE_REQUEST', '原生请求已断开或失效，不能再次回答。', 409);
    this.answers.delete(id);
    waiting.resolve(answer);
  }

  async stopTask(taskId: string, cancel = false) {
    const runs = this.core.requestStop(taskId, cancel);
    for (const run of runs) {
      if (!['stopping', 'unverified'].includes(run.status)) continue;
      // Persist intent and return promptly. A stalled native cancellation
      // request cannot hold the user's stop button open indefinitely.
      void Promise.resolve().then(() => this.active.get(run.id)?.cancel(run)).catch(() => {
        this.event(run, 'run.cancel_unverified', '停止请求未获确认，仍保留工作区占用。', { status: 'unverified' });
      });
    }
    return runs;
  }

  async stopAll() {
    this.core.setPaused(true);
    const tasks = this.core.snapshot().tasks.filter(task => !['completed', 'cancelled'].includes(task.status));
    return Promise.all(tasks.map(task => this.stopTask(task.id)));
  }

  async close() {
    this.closing = true;
    for (const [runId, adapter] of this.active) void adapter.cancel(this.core.getRun(runId)).catch(() => undefined);
    for (const waiting of this.answers.values()) waiting.reject(new Error('服务已退出，需要核对原执行。'));
    this.answers.clear();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([this.work, new Promise<void>(resolve => { timeout = setTimeout(resolve, 2000); })]); }
    finally { if (timeout) clearTimeout(timeout); }
    for (const runId of this.active.keys()) {
      const run = this.core.getRun(runId);
      if (!['succeeded', 'failed', 'stopped'].includes(run.status)) this.event(run, 'run.shutdown_unverified', '服务已退出，原执行结束状态待核实。', { status: 'unverified' });
    }
    this.closed = true;
  }
}
