import type { Snapshot } from '../../../packages/protocol/src/index.js';

export type Connection = {
  id: string;
  name: string;
  command: string;
  installed: boolean;
  version: string | null;
  platform: string;
  checkedAt: string;
  dispatchReady: boolean;
  capabilities: Record<string, unknown>;
  issues: string[];
};
export type AppState = Snapshot & { connections: Connection[]; dataDir: string };

let csrfToken = '';

export async function initializeSession(): Promise<void> {
  const session = await request<{ csrfToken: string }>('/api/session');
  csrfToken = session.csrfToken;
}

export async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({ error: '服务返回了无法读取的响应，请检查本地服务。' }));
  if (!response.ok) throw new Error(data.error || `请求未完成（${response.status}）`);
  return data as T;
}

export function newRequestId(): string {
  return crypto.randomUUID();
}

const requests = new Map<string, string>();
export function requestIdFor(action: string, payload: unknown): string {
  const key = action + JSON.stringify(payload);
  if (!requests.has(key)) requests.set(key, newRequestId());
  return requests.get(key)!;
}
