import { useState, type FormEvent } from 'react';
import type { Artifact, Question, Task } from '../../../packages/protocol/src/index.js';
import { requestIdFor, type AppState } from './api.js';
import type { Mutate } from './forms.js';
import { Empty, Field, Icon, providerLabels, sourceLabels, Status, time } from './ui.js';

export function startBlockReason(state: AppState, task: Task): string | null {
  if (state.paused) return '全局派单已暂停，恢复后才能开始新的执行。';
  if (task.frozen) return '此任务已冻结派单，请先核对执行状态。';
  const people = [task.ownerId, ...task.reviewerIds].map((id) => state.profiles.find((profile) => profile.id === id));
  if (people.some((profile) => !profile?.enabled)) return '流程中有已停用或不存在的角色，请先调整角色配置。';
  const unavailable = people.filter((profile) => !state.connections.find((connection) => connection.id === profile?.provider)?.dispatchReady);
  if (unavailable.length) return `${[...new Set(unavailable.map((profile) => providerLabels[profile!.provider]))].join('、')} 尚未通过所需能力验证，暂不能启动真实任务。`;
  return null;
}

function QuestionBox({ question, busy, mutate }: { question: Question; busy: boolean; mutate: Mutate }) {
  const [answer, setAnswer] = useState('');
  async function submit(event: FormEvent) { event.preventDefault(); await mutate(`/api/questions/${question.id}/respond`, { answer }, '回答已保存并提交回传'); }
  return <form className="decision-card" onSubmit={submit}><span className="eyebrow">等待你的回答</span><p>{question.prompt}</p><Field label="回答"><textarea required rows={3} value={answer} onChange={(e) => setAnswer(e.target.value)} maxLength={16000} /></Field><button className="button primary small" type="submit" disabled={busy || !answer.trim()}>提交回答</button></form>;
}

function SkipReviewBox({ task, profileId, name, busy, mutate }: { task: Task; profileId: string; name: string; busy: boolean; mutate: Mutate }) {
  const [reason, setReason] = useState(''); const [expanded, setExpanded] = useState(false);
  async function submit(event: FormEvent) { event.preventDefault(); await mutate(`/api/tasks/${task.id}/skip-review`, { version: task.version, profileId, artifactId: task.artifactId, reason }, '已记录跳过复核的决定，仍需用户验收成果'); }
  return <div className="decision-card"><div className="row-between"><strong className="small-text">{name} 尚未提交当前成果的复核</strong><button className="text-button" onClick={() => setExpanded(!expanded)}>{expanded ? '收起' : '记录跳过决定'}</button></div>{expanded && <form onSubmit={submit}><p className="form-intro">只有你可以明确跳过此复核。决定与原因会保留在历史中，不会自动验收成果。</p><Field label="跳过原因"><textarea rows={2} required value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} /></Field><button type="submit" className="button small subtle" disabled={busy || !reason.trim()}>确认跳过这位复核者</button></form>}</div>;
}

function ArtifactCard({ artifact, current }: { artifact: Artifact; current: boolean }) {
  const [showDiff, setShowDiff] = useState(false); const [preview, setPreview] = useState<{ path: string; text: string } | null>(null);
  const [error, setError] = useState(''); const [loading, setLoading] = useState(false);
  async function openFile(path: string) {
    setLoading(true); setError('');
    try {
      const response = await fetch(`/api/artifacts/${encodeURIComponent(artifact.id)}/file?path=${encodeURIComponent(path)}`, { credentials: 'same-origin' });
      if (!response.ok) { const result = await response.json().catch(() => ({})); throw new Error(result.error || '无法读取成果文件'); }
      const content = new Uint8Array(await response.arrayBuffer());
      if (content.length > 1024 * 1024) throw new Error('此文件超过 1 MB，请下载后查看。');
      if (content.includes(0)) throw new Error('此文件为二进制内容，请下载后查看。');
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(content); } catch { throw new Error('此文件不是 UTF-8 文本，请下载后查看。'); }
      setPreview({ path, text });
    } catch (caught) { setError(caught instanceof Error ? caught.message : '读取文件失败'); } finally { setLoading(false); }
  }
  return <article className="artifact-card"><div className="row-between"><h4><Icon name="document" />成果 v{artifact.version}</h4><span className={`pill ${current ? 'teal' : ''}`}>{current ? '当前成果' : '历史版本'}</span></div>
    <p className="preserve-text">{artifact.summary || '未提供成果摘要'}</p><dl className="compact-meta"><dt>基准</dt><dd><code>{artifact.baseCommit.slice(0, 12)}</code></dd><dt>哈希</dt><dd><code title={artifact.hash}>{artifact.hash.slice(0, 20)}…</code></dd><dt>保存</dt><dd>{time(artifact.createdAt)}</dd></dl>
    <div className="artifact-actions"><button className="button small subtle" onClick={() => setShowDiff(!showDiff)}>{showDiff ? '收起补丁' : '查看补丁'}</button><span className="muted">{artifact.files.length} 个文件</span></div>
    {showDiff && <pre className="code-preview">{artifact.diff || '没有记录文本补丁。请检查文件清单及执行证据。'}</pre>}
    <details><summary>文件清单</summary><ul className="file-list">{artifact.files.map((file) => <li key={file.path}><button className="text-button file-name" disabled={loading} onClick={() => void openFile(file.path)}>{file.path}</button><small>{file.size.toLocaleString()} B</small><a className="icon-button" aria-label={`下载 ${file.path}`} href={`/api/artifacts/${encodeURIComponent(artifact.id)}/file?path=${encodeURIComponent(file.path)}`} download><Icon name="download" size={15} /></a></li>)}</ul></details>
    {error && <p className="inline-error" role="alert">{error}</p>}{preview && <div><div className="row-between"><strong>{preview.path}</strong><button className="text-button" onClick={() => setPreview(null)}>关闭预览</button></div><pre className="code-preview">{preview.text}</pre></div>}
  </article>;
}

export function TaskDetail({ state, task, busy, mutate, openAccept, openRework, toProjects }: { state: AppState; task: Task; busy: boolean; mutate: Mutate; openAccept: () => void; openRework: () => void; toProjects: () => void }) {
  const [tab, setTab] = useState<'activity' | 'artifacts' | 'context'>('activity'); const [comment, setComment] = useState('');
  const project = state.projects.find((project) => project.id === task.projectId); const owner = state.profiles.find((profile) => profile.id === task.ownerId);
  const runs = state.runs.filter((run) => run.taskId === task.id); const events = state.events.filter((event) => event.taskId === task.id).sort((a, b) => b.seq - a.seq);
  const artifacts = state.artifacts.filter((artifact) => artifact.taskId === task.id).sort((a, b) => b.version - a.version);
  const reviews = state.reviews.filter((review) => review.taskId === task.id); const approvals = state.approvals.filter((approval) => approval.taskId === task.id && approval.status === 'pending');
  const questions = state.questions.filter((question) => question.taskId === task.id && question.status === 'pending');
  const latestRun = runs.at(-1); const blocked = startBlockReason(state, task);
  const hasActive = runs.some((run) => !['succeeded', 'failed', 'stopped'].includes(run.status));
  const canStart = task.status === 'pending' && !hasActive;
  async function addComment(event: FormEvent) { event.preventDefault(); if (await mutate(`/api/tasks/${task.id}/comment`, { text: comment }, '讨论记录已保存')) setComment(''); }
  async function start() { const payload = { version: task.version }; await mutate(`/api/tasks/${task.id}/start`, { ...payload, requestId: requestIdFor(`start:${task.id}`, payload) }, '已请求启动，执行状态以工具回执为准'); }
  return <div className="detail-layout"><div className="detail-main">
    <section className="panel task-brief"><div className="row-between"><span className="eyebrow">{project?.name || '项目'} / 第 {task.flow} 轮</span><Status value={task.status} /></div><h2>{task.title}</h2><p className="preserve-text">{task.goal}</p><div className="acceptance-criteria"><span className="eyebrow"><Icon name="check" size={15} />验收条件</span><p className="preserve-text">{task.criteria}</p></div>
      <div className="detail-actions">{canStart && <button className="button primary" onClick={() => void start()} disabled={busy || !!blocked} title={blocked || undefined}><Icon name="play" size={16} />启动任务</button>}
      {hasActive && <button className="button danger-subtle" disabled={busy} onClick={() => void mutate(`/api/tasks/${task.id}/stop`, {}, '已请求停止，请等待结束确认')}><Icon name="stop" size={16} />请求停止</button>}
      {task.status === 'awaiting_acceptance' && task.artifactId && <button className="button primary" disabled={busy} onClick={openAccept}><Icon name="check" size={17} />验收当前成果</button>}
      {!hasActive && ['pending', 'blocked', 'awaiting_acceptance'].includes(task.status) && <button className="button subtle" disabled={busy} onClick={openRework}>{task.status === 'pending' ? '调整任务' : '确认返工'}</button>}
      {!['completed', 'cancelled'].includes(task.status) && <button className="button subtle" disabled={busy} onClick={() => { if (window.confirm('确认取消此任务？已有改动会保留，活动执行确认结束前会继续显示待核实。')) void mutate(`/api/tasks/${task.id}/stop`, { cancel: true }, '已记录取消请求'); }}>取消任务</button>}
      </div>
      {canStart && blocked && <div className="callout warning">{blocked} <button className="text-button" onClick={toProjects}>查看项目与连接</button></div>}
      {task.frozen && <div className="callout warning">后续派单已冻结。确认执行结束前，工作区占用将继续保留。</div>}
    </section>
    {(approvals.length > 0 || questions.length > 0) && <section className="panel"><div className="section-heading"><h3><Icon name="inbox" />需要你处理</h3><span className="count">{approvals.length + questions.length}</span></div>
      {approvals.map((approval) => <div className="decision-card" key={approval.id}><span className="eyebrow">原生审批 · {approval.kind}</span><p className="preserve-text">{approval.prompt}</p><div className="button-row">{approval.options.map((option) => <button key={option} className="button small subtle" disabled={busy} onClick={() => void mutate(`/api/approvals/${approval.id}/respond`, { answer: option }, '审批决定已保存并提交回传')}>{option}</button>)}</div><small className="muted">此决定只回应当前审批请求，不代表任务验收。</small></div>)}
      {questions.map((question) => <QuestionBox key={question.id} question={question} busy={busy} mutate={mutate} />)}
    </section>}
    <section className="panel detail-tabs"><div className="tabs" role="tablist" aria-label="任务内容">{([['activity', '活动与讨论', events.length], ['artifacts', '成果与复核', artifacts.length], ['context', '执行与上下文', runs.length]] as const).map(([id, name, count]) => <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={tab === id ? 'selected' : ''}>{name}<span>{count}</span></button>)}</div>
    {tab === 'activity' && <div className="tab-content"><form className="comment-form" onSubmit={addComment}><label htmlFor="task-comment" className="sr-only">补充任务讨论</label><textarea id="task-comment" rows={3} maxLength={16000} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="补充背景或记录决定。讨论与 @ 提及不会自动派单。" /><div className="row-between"><small className="muted">任务变更请通过明确的返工或派单操作确认。</small><button type="submit" className="button small subtle" disabled={busy || !comment.trim()}>记录讨论</button></div></form>
      {!events.length ? <Empty title="还没有活动记录">开始工作后，用户操作、AI 汇报和工具回执会分别标明来源。</Empty> : <ol className="timeline">{events.map((event) => <li key={event.id}><div className={`timeline-marker source-${event.source}`} /><div className="timeline-body"><div className="row-between"><span className={`source-label source-${event.source}`}>{sourceLabels[event.source]}</span><time>{time(event.createdAt)}</time></div><p className="preserve-text">{event.text || event.type}</p></div></li>)}</ol>}
    </div>}
    {tab === 'artifacts' && <div className="tab-content">{!artifacts.length ? <Empty title="成果尚未提交">成果将保存为固定版本，连同文件清单、哈希与执行证据一起交给复核者。</Empty> : artifacts.map((artifact) => <ArtifactCard key={artifact.id} artifact={artifact} current={artifact.id === task.artifactId} />)}
      {reviews.length > 0 && <div className="reviews"><h3>复核意见</h3>{reviews.map((review) => <article className="review-card" key={review.id}><div className="row-between"><strong>{state.profiles.find((profile) => profile.id === review.profileId)?.name || '复核者'}</strong><span className={`pill ${review.verdict === 'pass' ? 'teal' : 'amber'}`}>{review.skipped ? '用户已跳过' : review.verdict === 'pass' ? '建议通过' : '建议修改'}</span></div><small className="muted">成果 v{state.artifacts.find((artifact) => artifact.id === review.artifactId)?.version || '?'} · {review.artifactId === task.artifactId ? '当前版本' : '历史版本'} · {time(review.createdAt)}</small><p className="preserve-text">{review.text}</p></article>)}</div>}
      {task.artifactId && !task.frozen && task.status !== 'completed' && task.reviewerIds.filter((id) => !reviews.some((review) => review.profileId === id && review.artifactId === task.artifactId) && !runs.some((run) => run.profileId === id && run.flow === task.flow && !['succeeded', 'failed', 'stopped'].includes(run.status))).map((id) => <SkipReviewBox key={id} task={task} profileId={id} name={state.profiles.find((profile) => profile.id === id)?.name || '复核者'} busy={busy} mutate={mutate} />)}
      {state.acceptances.filter((acceptance) => acceptance.taskId === task.id).map((acceptance) => <div className="callout success" key={acceptance.id}><strong>用户已验收成果 v{state.artifacts.find((artifact) => artifact.id === acceptance.artifactId)?.version}</strong><p>{acceptance.comment || '未填写附加意见'}</p><small>{time(acceptance.createdAt)} · 代码未自动合并或推送</small></div>)}
    </div>}
    {tab === 'context' && <div className="tab-content">{!runs.length ? <Empty title="还没有执行记录">派单时将保存本轮角色、规则、目标、成果引用及权限配置。</Empty> : [...runs].reverse().map((run) => <article className="run-card" key={run.id}><div className="row-between"><strong>{run.role === 'implement' ? '实现执行' : '复核执行'} · 第 {run.flow} 轮</strong><Status value={run.status} run /></div><p className="muted">{providerLabels[run.provider]} · {run.model || '模型未知 / 沿用工具配置'}</p><dl className="compact-meta"><dt>开始</dt><dd>{time(run.createdAt)}</dd><dt>用量</dt><dd>{run.usage ? `${run.usage.inputTokens ?? '未知'} 输入 / ${run.usage.outputTokens ?? '未知'} 输出 token · ${run.usage.complete ? '完整' : '不完整'}记录` : '未知（未收到工具用量）'}</dd><dt>工作区</dt><dd className="break-all">{run.workspacePath || '尚未分配'}</dd></dl>{run.error && <div className="callout warning">{run.error}</div>}{run.evidence && <details><summary>工具执行证据</summary><pre className="code-preview">{run.evidence}</pre></details>}<details><summary>本轮上下文快照</summary><div className="context-snapshot"><h4>目标与验收条件</h4><p className="preserve-text">{run.context.goal}</p><p className="preserve-text">{run.context.criteria}</p><h4>角色 v{run.context.profile.version} · {run.context.profile.name}</h4><p className="preserve-text">{run.context.profile.instructions || '无额外职责说明'}</p><h4>采用的规则</h4>{run.context.rules.length ? run.context.rules.map((rule) => <div className="snapshot-rule" key={rule.revisionId}><small>v{rule.version} · {rule.source}</small><p className="preserve-text">{rule.content}</p></div>) : <p className="muted">无适用的已确认规则</p>}<h4>已确认决定</h4>{run.context.decisions.length ? <ul>{run.context.decisions.map((decision, index) => <li key={index}>{decision}</li>)}</ul> : <p className="muted">未附加决定</p>}<small className="break-all muted">快照哈希：{run.context.hash}</small></div></details></article>)}</div>}
    </section>
  </div><aside className="detail-aside"><section className="panel"><h3>本次分工</h3><div className="person-row"><span className="avatar">{owner?.name.slice(0, 1) || '?'}</span><div><strong>{owner?.name || '未指定'}</strong><small>实现负责人 · {owner ? providerLabels[owner.provider] : '未知工具'}</small></div></div>{task.reviewerIds.map((id) => { const profile = state.profiles.find((profile) => profile.id === id); return <div className="person-row" key={id}><span className="avatar reviewer">{profile?.name.slice(0, 1) || '?'}</span><div><strong>{profile?.name || '未知角色'}</strong><small>独立复核 · {profile ? providerLabels[profile.provider] : '未知工具'}</small></div></div>; })}{!task.reviewerIds.length && <p className="muted small-text">未指定复核者；实现结束后仍需你验收。</p>}<div className="divider" /><dl className="compact-meta vertical"><dt>所属项目</dt><dd>{project?.name || '未知项目'}</dd><dt>基准版本</dt><dd><code>{project?.baseCommit.slice(0, 12) || '未知'}</code></dd><dt>任务版本</dt><dd>v{task.version}</dd><dt>最近更新</dt><dd>{time(task.updatedAt)}</dd></dl></section><section className="info-card"><Icon name="shield" size={22} /><h4>由你决定完成</h4><p>工具结束执行后，还需要检查成果与复核意见。验收只接受这一版成果，不会自动合并代码。</p></section>{latestRun?.status === 'unverified' && <div className="callout warning">原执行结果仍待核实。请检查原工具；当前不会自动重跑或换人。</div>}</aside></div>;
}

export function AcceptanceForm({ state, task, busy, mutate, done }: { state: AppState; task: Task; busy: boolean; mutate: Mutate; done: () => void }) {
  const [comment, setComment] = useState(''); const [confirmed, setConfirmed] = useState(false);
  const artifact = state.artifacts.find((artifact) => artifact.id === task.artifactId);
  async function submit(event: FormEvent) { event.preventDefault(); const payload = { version: task.version, artifactId: task.artifactId, comment }; if (await mutate(`/api/tasks/${task.id}/accept`, { ...payload, requestId: requestIdFor(`accept:${task.id}`, payload) }, '已验收指定成果版本')) done(); }
  return <form onSubmit={submit}><p className="form-intro">你正在验收 <strong>{task.title}</strong> 的成果 <strong>v{artifact?.version}</strong>。如成果在打开此页面后发生变化，服务会拒绝过期的验收。</p><div className="callout"><strong>成果摘要</strong><p className="preserve-text">{artifact?.summary || '无摘要'}</p><small className="break-all">哈希：{artifact?.hash}</small></div><Field label="验收意见（可选）"><textarea autoFocus rows={4} value={comment} onChange={(e) => setComment(e.target.value)} maxLength={16000} /></Field><label className="check-row"><input type="checkbox" required checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />我已检查对应成果、证据和复核意见，确认接受这一版</label><div className="form-actions"><button type="submit" className="button primary" disabled={busy || !confirmed || !artifact}>确认通过验收</button></div></form>;
}
