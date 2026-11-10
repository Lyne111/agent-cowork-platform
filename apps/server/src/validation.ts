export class HttpError extends Error {
  constructor(public code: string, message: string, public statusCode = 400) { super(message); }
}

export function object(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError('INVALID_INPUT', '请求必须是 JSON 对象。');
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some(key => !allowed.includes(key))) throw new HttpError('INVALID_INPUT', '请求包含不支持的字段。');
  return result;
}

export function text(value: unknown, name: string, max = 20_000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new HttpError('INVALID_INPUT', `${name} 不能为空且不能超过 ${max} 个字符。`);
  return value.trim();
}

export function optionalText(value: unknown, name: string, max = 20_000): string | undefined {
  return value === undefined ? undefined : text(value, name, max);
}

export function bool(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new HttpError('INVALID_INPUT', `${name} 必须是布尔值。`);
  return value;
}

export function integer(value: unknown, name: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw new HttpError('INVALID_INPUT', `${name} 必须是有效整数。`);
  return value;
}

export function choice<T extends string>(value: unknown, name: string, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw new HttpError('INVALID_INPUT', `${name} 无效。`);
  return value as T;
}

export function ids(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 2) throw new HttpError('INVALID_INPUT', '最多指定两名复核者。');
  return value.map(id => text(id, '复核者', 120));
}

export function requestId(value: unknown): string {
  const id = text(value, 'requestId', 120);
  if (!/^[a-zA-Z0-9._:-]+$/.test(id)) throw new HttpError('INVALID_INPUT', 'requestId 格式无效。');
  return id;
}
