import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';

export type RpcId = string | number;
export type DeliveryState = 'not_sent' | 'unknown' | 'rejected';
export interface RpcRequest { jsonrpc?: '2.0'; id: RpcId; method: string; params?: unknown }
export interface RpcNotification { jsonrpc?: '2.0'; method: string; params?: unknown }
export class JsonRpcFailure extends Error {
  constructor(message: string, public readonly delivery: DeliveryState, public readonly code?: number | string) {
    super(message); this.name = 'JsonRpcFailure';
  }
}
type Pending = { resolve: (value: unknown) => void; reject: (error: JsonRpcFailure) => void; timeout: ReturnType<typeof setTimeout> };
export interface TransportOptions {
  executable: string;
  args: readonly string[];
  cwd: string;
  timeoutMs?: number;
  maxMessageBytes?: number;
  /** Explicit child environment only when needed. The default inherits normal authentication. */
  env?: NodeJS.ProcessEnv;
}

/** Newline-delimited JSON-RPC used by Codex app-server and ACP stdio.
 * A timeout/disconnect after a write is UNKNOWN delivery, never permission to retry.
 * Events: notification, request, transportFailure, exit. Stderr is intentionally not logged.
 */
export class StdioJsonRpcTransport extends EventEmitter {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<RpcId, Pending>();
  private readonly incoming = new Set<RpcId>();
  private readonly decoder = new StringDecoder('utf8');
  private readonly timeoutMs: number;
  private readonly maxMessageBytes: number;
  private nextId = 1;
  private buffer = '';
  private closed = false;
  private spawned = false;
  readonly started: Promise<void>;

  constructor(options: TransportOptions) {
    super();
    if (!options.executable || /\.(cmd|bat)$/i.test(options.executable)) {
      throw new JsonRpcFailure('Use a native executable; shell command scripts are not supported.', 'not_sent');
    }
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxMessageBytes = options.maxMessageBytes ?? 4 * 1024 * 1024;
    this.child = spawn(options.executable, [...options.args], {
      cwd: options.cwd, env: options.env ?? process.env,
      shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.started = new Promise<void>((resolve, reject) => {
      this.child.once('spawn', () => { this.spawned = true; resolve(); });
      this.child.once('error', () => {
        const error = new JsonRpcFailure('Unable to start provider process.', 'not_sent', 'SPAWN_FAILED');
        reject(error); this.fail(error);
      });
    });
    // Avoid an unhandled rejection when callers choose request() without awaiting started.
    void this.started.catch(() => {});
    this.child.stdout.on('data', (chunk: Buffer) => this.consume(chunk));
    this.child.stdin.on('error', () => this.fail(new JsonRpcFailure('Provider input disconnected.', 'unknown', 'PIPE_FAILED')));
    this.child.stderr.resume();
    this.child.once('exit', (code, signal) => {
      this.fail(new JsonRpcFailure('Provider process exited; execution requires reconciliation.', this.spawned ? 'unknown' : 'not_sent', 'PROCESS_EXIT'));
      this.emit('exit', { code, signal });
    });
  }

  async request<T = unknown>(method: string, params?: unknown, timeoutMs = this.timeoutMs): Promise<T> {
    if (!method || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new JsonRpcFailure('Invalid method or timeout.', 'not_sent', 'INVALID_REQUEST');
    await this.started;
    if (this.closed) throw new JsonRpcFailure('Transport is closed.', 'not_sent', 'CLOSED');
    const id = this.nextId++;
    const message = this.encode({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
    return await new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new JsonRpcFailure('Response timed out; delivery is unknown. Do not resend.', 'unknown', 'TIMEOUT'));
      }, timeoutMs);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timeout });
      this.child.stdin.write(message, error => {
        if (error) this.fail(new JsonRpcFailure('Write failed; delivery is unknown.', 'unknown', 'WRITE_FAILED'));
      });
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    if (!method) throw new JsonRpcFailure('Method required.', 'not_sent', 'INVALID_REQUEST');
    await this.started;
    if (this.closed) throw new JsonRpcFailure('Transport is closed.', 'not_sent', 'CLOSED');
    const data = this.encode({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
    await new Promise<void>((resolve, reject) => this.child.stdin.write(data, error => error
      ? reject(new JsonRpcFailure('Notification write failed.', 'unknown', 'WRITE_FAILED')) : resolve()));
  }

  async respond(id: RpcId, response: { result: unknown } | { error: { code: number; message: string; data?: unknown } }): Promise<void> {
    if (!this.incoming.has(id)) throw new JsonRpcFailure('Request is expired or already answered.', 'not_sent', 'STALE_REQUEST');
    const data = this.encode({ jsonrpc: '2.0', id, ...response });
    this.incoming.delete(id);
    if (this.closed) throw new JsonRpcFailure('Transport is closed.', 'not_sent', 'CLOSED');
    await new Promise<void>((resolve, reject) => this.child.stdin.write(data, error => error
      ? reject(new JsonRpcFailure('Response write failed; remote receipt is unknown.', 'unknown', 'WRITE_FAILED')) : resolve()));
  }

  invalidateRequest(id: RpcId): void { this.incoming.delete(id); }

  /** Stops only this owned transport process. This does NOT prove native descendants stopped. */
  close(): void {
    this.fail(new JsonRpcFailure('Transport closed; native execution may require reconciliation.', 'unknown', 'CLOSED'));
    this.child.stdin.end();
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGTERM');
  }

  private encode(message: unknown): string {
    let line: string;
    try { line = JSON.stringify(message); }
    catch { throw new JsonRpcFailure('Request is not JSON serializable.', 'not_sent', 'INVALID_REQUEST'); }
    if (Buffer.byteLength(line) > this.maxMessageBytes) throw new JsonRpcFailure('Request exceeds size limit.', 'not_sent', 'MESSAGE_TOO_LARGE');
    return line + '\n';
  }

  private consume(chunk: Buffer): void {
    if (this.closed) return;
    this.buffer += this.decoder.write(chunk);
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      if (Buffer.byteLength(line) > this.maxMessageBytes) { this.protocolFailure(); return; }
      let message: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Object required');
        message = parsed as Record<string, unknown>;
        if (message.jsonrpc !== undefined && message.jsonrpc !== '2.0') throw new Error('Invalid protocol version');
      } catch { this.protocolFailure(); return; }
      if (typeof message.method === 'string') {
        if (message.id === undefined) this.emit('notification', message as unknown as RpcNotification);
        else if (typeof message.id === 'string' || typeof message.id === 'number') {
          if (this.incoming.has(message.id)) { this.protocolFailure(); return; }
          this.incoming.add(message.id);
          if (this.listenerCount('request')) this.emit('request', message as unknown as RpcRequest);
          else void this.respond(message.id, { error: { code: -32601, message: 'Unsupported server request' } }).catch(() => {});
        } else { this.protocolFailure(); return; }
        continue;
      }
      if (typeof message.id !== 'string' && typeof message.id !== 'number') { this.protocolFailure(); return; }
      const pending = this.pending.get(message.id);
      if (!pending) continue; // Late response or duplicate; never creates a new execution.
      this.pending.delete(message.id); clearTimeout(pending.timeout);
      if ('error' in message && !('result' in message)) {
        const error = message.error as { code?: unknown } | null;
        const code = typeof error?.code === 'number' ? error.code : 'RPC_ERROR';
        const delivery = typeof code === 'number' && [-32700, -32600, -32601, -32602].includes(code) ? 'rejected' : 'unknown';
        pending.reject(new JsonRpcFailure('Provider returned a protocol error; reconcile before retrying.', delivery, code));
      } else if ('result' in message && !('error' in message)) pending.resolve(message.result);
      else { pending.reject(new JsonRpcFailure('Invalid provider response.', 'unknown', 'PROTOCOL_ERROR')); this.protocolFailure(); return; }
    }
    if (Buffer.byteLength(this.buffer) > this.maxMessageBytes) this.protocolFailure();
  }

  private protocolFailure(): void {
    this.fail(new JsonRpcFailure('Malformed or oversized provider output.', 'unknown', 'PROTOCOL_ERROR'));
    this.child.kill('SIGTERM');
  }
  private fail(error: JsonRpcFailure): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timeout); pending.reject(error); }
    this.pending.clear(); this.incoming.clear();
    this.emit('transportFailure', error);
  }
}
