import { cloneElement, isValidElement, useEffect, useId, useRef, type ReactElement, type ReactNode } from 'react';
import type { RunStatus, TaskStatus } from '../../../packages/protocol/src/index.js';

export const taskLabels: Record<TaskStatus, string> = {
  pending: '待分配', running: '执行中', blocked: '被阻塞', awaiting_acceptance: '待验收', completed: '已完成', cancelled: '已取消',
};
export const runLabels: Record<RunStatus, string> = {
  queued: '排队', sending: '发送中', accepted: '已接受', running: '运行中', waiting_user: '等待用户', stopping: '停止中', succeeded: '执行成功', failed: '执行失败', stopped: '已停止', unverified: '待核实',
};
export const providerLabels: Record<string, string> = { codex: 'Codex', antigravity: 'Antigravity', 'deepseek-harness': 'DeepSeek Harness' };
export const roleLabels: Record<string, string> = { implementer: '实现者', reviewer: '代码复核者', acceptance: '验收检查者' };
export const sourceLabels: Record<string, string> = { user: '用户发出', agent: 'AI 汇报', tool: '工具确认', system: '系统记录' };
export const scopeLabels: Record<string, string> = { global: '全局', project: '项目', role: '角色' };
export const kindLabels: Record<string, string> = { rule: '规则', preference: '偏好', fact: '事实', experience: '经验' };

export function time(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value : new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(parsed);
}
export function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    board: <><rect x="3" y="3" width="7" height="18" rx="2" /><rect x="14" y="3" width="7" height="10" rx="2" /><path d="M14 17h7M14 21h7" /></>,
    folder: <path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />,
    plus: <path d="M12 5v14M5 12h14" />,
    arrow: <path d="m9 5 7 7-7 7" />,
    back: <path d="m14 5-7 7 7 7M7 12h14" />,
    search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
    play: <path d="m8 4 12 8-12 8V4Z" />,
    pause: <><path d="M8 5v14M16 5v14" /></>,
    refresh: <><path d="M20 11a8 8 0 0 0-14-5L3 9m0-6v6h6M4 13a8 8 0 0 0 14 5l3-3m0 6v-6h-6" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    activity: <path d="M3 12h4l3-8 4 16 3-8h4" />,
    shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" /><path d="m8 12 3 3 5-6" /></>,
    document: <><path d="M14 3H5v18h14V8l-5-5Zm0 0v5h5M8 12h8M8 16h6" /></>,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    stop: <rect x="5" y="5" width="14" height="14" rx="2" />,
    inbox: <><path d="m6 3-3 9v8h18v-8l-3-9H6Z" /><path d="M3 12h5l2 3h4l2-3h5" /></>,
    download: <><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.document}</svg>;
}

export function Status({ value, run = false }: { value: TaskStatus | RunStatus; run?: boolean }) {
  return <span className={`status status-${value}`}><span className="status-dot" />{run ? runLabels[value as RunStatus] : taskLabels[value as TaskStatus]}</span>;
}

export function Empty({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return <div className="empty"><div className="empty-symbol"><Icon name="folder" size={29} /></div><h3>{title}</h3><p>{children}</p>{action}</div>;
}

export function Modal({ title, children, close, error }: { title: string; children: ReactNode; close: () => void; error: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return <dialog ref={ref} className="modal" onCancel={(event) => { event.preventDefault(); close(); }} onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
    <div className="modal-body"><div className="modal-title"><h2>{title}</h2><button type="button" className="icon-button" onClick={close} aria-label="关闭弹窗"><Icon name="close" /></button></div>
      {error && <div className="alert error" role="alert">{error}</div>}{children}
    </div>
  </dialog>;
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  const generatedId = useId();
  const child = children as ReactElement<{ id?: string; 'aria-describedby'?: string }>;
  const id = isValidElement(child) ? child.props.id || generatedId : generatedId;
  return <div className="field"><label htmlFor={id}>{label}</label>{isValidElement(child) ? cloneElement(child, { id, 'aria-describedby': hint ? `${id}-hint` : child.props['aria-describedby'] }) : children}{hint && <small id={`${id}-hint`}>{hint}</small>}</div>;
}

export function downloadText(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click(); URL.revokeObjectURL(url);
}
