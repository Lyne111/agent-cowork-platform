import { useState, type FormEvent } from 'react';
import type { RoleProfile, RuleRevision, Task } from '../../../packages/protocol/src/index.js';
import { newRequestId, requestIdFor, type AppState } from './api.js';
import { Field, kindLabels, providerLabels, roleLabels, scopeLabels } from './ui.js';

export type Mutate = (path: string, body: unknown, success?: string) => Promise<boolean>;
type Common = { state: AppState; busy: boolean; mutate: Mutate; done: () => void };
function actions(busy: boolean, label: string, disabled = false) { return <div className="form-actions"><button type="submit" className="button primary" disabled={busy || disabled}>{busy ? '正在保存…' : label}</button></div>; }

export function ProjectForm({ busy, mutate, done }: Common) {
  const [name, setName] = useState(''); const [path, setPath] = useState('');
  async function submit(event: FormEvent) { event.preventDefault(); if (await mutate('/api/projects', { name, path }, '项目已添加')) done(); }
  return <form onSubmit={submit}>
    <p className="form-intro">选择本地服务所在电脑上的 Git 仓库。工作台会检查目录和已提交的基准版本。</p>
    <Field label="项目名称"><input autoFocus value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} placeholder="例如：客户管理系统" /></Field>
    <Field label="仓库绝对路径" hint="Windows 示例：E:\gpt_project\my-project。云端服务需要填写其实际 Linux 路径。"><input value={path} onChange={(e) => setPath(e.target.value)} required placeholder="E:\gpt_project\my-project" autoComplete="off" spellCheck={false} /></Field>
    <div className="callout">项目须已有 Git 提交。工作台会保留你的未提交修改；开始写任务前需要先处理这些修改。</div>
    {actions(busy, '检查并添加项目')}
  </form>;
}

export function ProfileForm({ state, busy, mutate, done, profile }: Common & { profile?: RoleProfile }) {
  const [name, setName] = useState(profile?.name || ''); const [role, setRole] = useState<RoleProfile['role']>(profile?.role || 'implementer');
  const [provider, setProvider] = useState<RoleProfile['provider']>(profile?.provider || 'codex'); const [model, setModel] = useState(profile?.model || '');
  const [instructions, setInstructions] = useState(profile?.instructions || ''); const [enabled, setEnabled] = useState(profile?.enabled ?? true);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (await mutate('/api/profiles', { id: profile?.id, expectedVersion: profile?.version, name, role, provider, model: model || null, instructions, enabled }, '角色档案已保存')) done();
  }
  return <form onSubmit={submit}>
    <p className="form-intro">身份和职责可以复用。修改默认配置只影响后续执行，已开始的任务保留原来的版本。</p>
    <Field label="角色名称"><input autoFocus value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} placeholder="例如：实现工程师" /></Field>
    <div className="form-grid"><Field label="职责"><select value={role} onChange={(e) => setRole(e.target.value as RoleProfile['role'])}>{Object.entries(roleLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field>
    <Field label="默认工具"><select value={provider} onChange={(e) => setProvider(e.target.value as RoleProfile['provider'])}>{Object.entries(providerLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field></div>
    <Field label="模型（可选）" hint="留空沿用工具配置。模型是否可用由工具实际能力决定。"><input value={model} onChange={(e) => setModel(e.target.value)} placeholder="沿用工具默认模型" maxLength={100} /></Field>
    <Field label="职责边界与交付要求"><textarea rows={5} value={instructions} onChange={(e) => setInstructions(e.target.value)} maxLength={16000} placeholder="说明职责、交付清单与表达偏好。实际权限仍由工具配置落实。" /></Field>
    <label className="check-row"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />允许给该角色派发新执行</label>
    {!state.connections.find((connection) => connection.id === provider)?.dispatchReady && <div className="callout">该工具尚未通过真实执行验证。你可以先保存角色，接入完成后再派单。</div>}
    {actions(busy, '保存角色档案')}
  </form>;
}

export function RuleForm({ state, busy, mutate, done, rule }: Common & { rule?: RuleRevision }) {
  const [scope, setScope] = useState<RuleRevision['scope']>(rule?.scope || 'project');
  const [projectId, setProjectId] = useState(rule?.projectId || state.projects[0]?.id || '');
  const [profileId, setProfileId] = useState(rule?.profileId || state.profiles[0]?.id || '');
  const [kind, setKind] = useState<RuleRevision['kind']>(rule?.kind || 'rule');
  const [content, setContent] = useState(rule?.content || ''); const [source, setSource] = useState(rule?.source || '用户编辑');
  const [confirmed, setConfirmed] = useState(false); const [importError, setImportError] = useState('');
  const history = rule ? state.rules.filter((item) => item.id === rule.id && item.version < rule.version).sort((a, b) => b.version - a.version) : [];
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (await mutate('/api/rules', { id: rule?.id, expectedVersion: rule?.version, scope, projectId: scope === 'global' ? null : projectId || null, profileId: scope === 'role' ? profileId : null, kind, content, source, confirmed: true }, '规则新版本已保存，后续执行采用')) done();
  }
  async function importFile(file?: File) {
    if (!file) return;
    if (file.size > 64 * 1024) { setImportError('文件超过 64 KB，请缩减为当前任务所需的规则。'); return; }
    setImportError(''); const imported = await file.text();
    if (imported.length > 20000) { setImportError('单条规则最多 20,000 个字符，请拆分后导入。'); return; }
    setContent(imported); setSource(`Markdown 导入：${file.name}`); setConfirmed(false);
  }
  return <form onSubmit={submit}>
    <p className="form-intro">规则、经验和偏好须由你确认保存。导入文件会先填入下方草稿，已有执行不受修改影响。</p>
    <div className="form-grid"><Field label="作用层次"><select value={scope} onChange={(e) => { setScope(e.target.value as RuleRevision['scope']); setConfirmed(false); }} disabled={!!rule}>{Object.entries(scopeLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field>
    <Field label="内容类型"><select value={kind} onChange={(e) => setKind(e.target.value as RuleRevision['kind'])}>{Object.entries(kindLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field></div>
    {scope !== 'global' && <Field label={scope === 'role' ? '限制到项目' : '所属项目'} hint={scope === 'role' ? '项目经验默认只用于原项目。跨项目共享请明确选择“所有项目”。' : undefined}><select value={projectId} onChange={(e) => { setProjectId(e.target.value); setConfirmed(false); }} required={scope === 'project'}><option value="">{scope === 'role' ? '所有项目（明确允许共享）' : '请选择项目'}</option>{state.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></Field>}
    {scope === 'role' && <Field label="所属角色"><select value={profileId} onChange={(e) => setProfileId(e.target.value)} required>{state.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></Field>}
    <Field label="规则内容"><textarea autoFocus rows={7} required value={content} onChange={(e) => { setContent(e.target.value); setConfirmed(false); }} maxLength={20000} placeholder="例如：文档使用简体中文，结论必须附对应证据。" /></Field>
    {rule && <details className="original-rule"><summary>查看修改前的版本 v{rule.version}</summary><pre>{rule.content}</pre></details>}
    {history.length > 0 && <Field label="从历史版本恢复内容" hint="仅填入草稿，确认后生成新版本，不覆盖旧记录。"><select defaultValue="" onChange={(e) => { const previous = history.find((item) => item.revisionId === e.target.value); if (previous) { setContent(previous.content); setSource(`用户选择恢复 v${previous.version}；原来源：${previous.source}`); setConfirmed(false); } }}><option value="">选择历史版本…</option>{history.map((previous) => <option key={previous.revisionId} value={previous.revisionId}>v{previous.version} · {previous.source}</option>)}</select></Field>}
    <Field label="来源"><input value={source} onChange={(e) => setSource(e.target.value)} required maxLength={500} /></Field>
    <label className="import-file">导入 Markdown 草稿<input type="file" accept=".md,.markdown,text/markdown,text/plain" onChange={(e) => void importFile(e.target.files?.[0])} /></label>
    {importError && <div className="alert error" role="alert">{importError}</div>}
    <label className="check-row"><input required type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />我已检查内容与作用范围，确认将其保存为正式规则</label>
    {actions(busy, rule ? '确认保存新版本' : '确认保存规则', !confirmed)}
  </form>;
}

export function TaskForm({ state, busy, mutate, done }: Common) {
  const [attemptScope] = useState(newRequestId);
  const [projectId, setProjectId] = useState(state.projects[0]?.id || ''); const [title, setTitle] = useState('');
  const [goal, setGoal] = useState(''); const [criteria, setCriteria] = useState('');
  const [ownerId, setOwnerId] = useState(state.profiles.find((profile) => profile.role === 'implementer' && profile.enabled)?.id || '');
  const [reviewerIds, setReviewerIds] = useState<string[]>([]);
  async function submit(event: FormEvent) {
    event.preventDefault(); const payload = { projectId, title, goal, criteria, ownerId, reviewerIds };
    if (await mutate('/api/tasks', { ...payload, requestId: requestIdFor(`create-task:${attemptScope}`, payload) }, '任务已创建，可在详情中检查流程并启动')) done();
  }
  return <form onSubmit={submit}>
    <Field label="所属项目"><select value={projectId} onChange={(e) => setProjectId(e.target.value)} required><option value="">请选择项目</option>{state.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></Field>
    <Field label="任务标题"><input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={160} placeholder="例如：增加 CSV 导出功能" /></Field>
    <Field label="目标"><textarea rows={3} value={goal} onChange={(e) => setGoal(e.target.value)} required maxLength={16000} placeholder="希望完成什么？请说明范围和必要背景。" /></Field>
    <Field label="验收条件"><textarea rows={3} value={criteria} onChange={(e) => setCriteria(e.target.value)} required maxLength={16000} placeholder="例如：中文不乱码；筛选条件生效；附上测试命令与结果。" /></Field>
    <Field label="实现负责人"><select value={ownerId} onChange={(e) => { setOwnerId(e.target.value); setReviewerIds(reviewerIds.filter((id) => id !== e.target.value)); }} required><option value="">请选择角色</option>{state.profiles.filter((profile) => profile.enabled && profile.role === 'implementer').map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {providerLabels[profile.provider]}</option>)}</select></Field>
    <fieldset className="reviewer-field"><legend>复核者 <span>可选，最多两位</span></legend>{state.profiles.filter((profile) => profile.enabled && profile.id !== ownerId && profile.role !== 'implementer').map((profile) => <label key={profile.id} className="check-row"><input type="checkbox" checked={reviewerIds.includes(profile.id)} disabled={!reviewerIds.includes(profile.id) && reviewerIds.length >= 2} onChange={(e) => setReviewerIds(e.target.checked ? [...reviewerIds, profile.id] : reviewerIds.filter((id) => id !== profile.id))} /><span>{profile.name}<small>{providerLabels[profile.provider]}</small></span></label>)}</fieldset>
    <div className="callout">创建任务仅保存计划。启动时会检查目录、角色和工具能力；流程最多包含一次实现与两次复核。</div>
    {actions(busy, '创建任务')}
  </form>;
}

export function ReworkForm({ state, task, busy, mutate, done }: Common & { task: Task }) {
  const [goal, setGoal] = useState(task.goal); const [criteria, setCriteria] = useState(task.criteria); const [ownerId, setOwnerId] = useState(task.ownerId);
  async function submit(event: FormEvent) {
    event.preventDefault(); const payload = { version: task.version, goal, criteria, ownerId };
    if (await mutate(`/api/tasks/${task.id}/rework`, { ...payload, requestId: requestIdFor(`rework:${task.id}`, payload) }, '返工要求已保存，新一轮执行需重新启动')) done();
  }
  return <form onSubmit={submit}><p className="form-intro">确认后建立新一轮工作。旧成果与复核保留为历史，无法确认停止的执行必须先核实。</p><Field label="本轮实现负责人"><select required value={ownerId} onChange={(e) => setOwnerId(e.target.value)}><option value="">请选择启用的实现者</option>{state.profiles.filter((profile) => profile.enabled && profile.role === 'implementer' && !task.reviewerIds.includes(profile.id)).map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {providerLabels[profile.provider]}</option>)}</select></Field><Field label="本轮目标"><textarea rows={5} required value={goal} onChange={(e) => setGoal(e.target.value)} maxLength={16000} /></Field><Field label="本轮验收条件"><textarea rows={4} required value={criteria} onChange={(e) => setCriteria(e.target.value)} maxLength={16000} /></Field>{actions(busy, '确认新一轮要求')}</form>;
}
