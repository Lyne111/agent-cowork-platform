import { createHash } from 'node:crypto';
import type { RunStatus } from '../../protocol/src/index.js';
export class DomainError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 409) { super(message); this.name = 'DomainError'; }
}
export function assert(condition: unknown, code: string, message: string, statusCode = 409): asserts condition {
  if (!condition) throw new DomainError(code,message,statusCode);
}
export function text(value: unknown, label: string, max = 100_000): string {
  assert(typeof value === 'string' && value.trim().length > 0 && value.length <= max,'INVALID_INPUT',`${label} must be nonempty text (maximum ${max} characters).`,400);
  return value.trim();
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value as Record<string,unknown>).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export function hash(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
export const terminal = (status: RunStatus): boolean => ['succeeded','failed','stopped'].includes(status);
export const transitions: Record<RunStatus, RunStatus[]> = {
  queued: ['sending','stopped'], sending: ['accepted','running','waiting_user','succeeded','failed','stopping','unverified'],
  accepted: ['running','waiting_user','succeeded','failed','stopping','unverified'], running: ['waiting_user','succeeded','failed','stopping','unverified'],
  waiting_user: ['running','succeeded','failed','stopping','unverified'], stopping: ['stopped','succeeded','failed','unverified'],
  unverified: ['accepted','running','waiting_user','stopping','succeeded','failed','stopped'], succeeded: [], failed: [], stopped: [],
};
