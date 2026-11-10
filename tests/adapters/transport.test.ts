import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { StdioJsonRpcTransport, JsonRpcFailure, initializeCodex, probeProvider, assertDispatchReady } from '../../packages/adapters/src/index.js';

const fixture = fileURLToPath(new URL('./fixtures/rpc-provider.mjs', import.meta.url));
function client() { return new StdioJsonRpcTransport({ executable: process.execPath, args: [fixture], cwd: process.cwd(), timeoutMs: 1_000 }); }
const failure = (delivery: string, code?: string | number) => (error: unknown) => error instanceof JsonRpcFailure && error.delivery === delivery && (code === undefined || error.code === code);

test('fragmented UTF-8, notifications and out-of-order RPC replies preserve request identity', async t => {
  const rpc = client(); t.after(() => rpc.close());
  const progress = once(rpc, 'notification');
  assert.deepEqual(await rpc.request('echo', { message: '中文成果' }), { message: '中文成果' });
  assert.equal((await progress)[0].method, 'progress');
  assert.deepEqual(await Promise.all([
    rpc.request('delayed', { delay: 25, value: 'first' }),
    rpc.request('delayed', { delay: 0, value: 'second' }),
  ]), ['first', 'second']);
});

test('permission request waits for explicit decision and cannot be answered twice', async t => {
  const rpc = client(); t.after(() => rpc.close());
  const received = once(rpc, 'request');
  const final = rpc.request('approval');
  const [request] = await received;
  assert.equal(request.method, 'session/request_permission');
  await rpc.respond(request.id, { result: { outcome: { outcome: 'cancelled' } } });
  assert.deepEqual(await final, { outcome: { outcome: 'cancelled' } });
  await assert.rejects(rpc.respond(request.id, { result: { allow: true } }), failure('not_sent', 'STALE_REQUEST'));
});

test('timeout after write and child exit remain unknown delivery, never rejection', async t => {
  const rpc = client(); t.after(() => rpc.close());
  await assert.rejects(rpc.request('hang', {}, 30), failure('unknown', 'TIMEOUT'));
  await assert.rejects(rpc.request('exit'), failure('unknown', 'PROCESS_EXIT'));
});

test('late timed-out response cannot complete a later request', async t => {
  const rpc = client(); t.after(() => rpc.close());
  await assert.rejects(rpc.request('delayed', { delay: 30, value: 'stale' }, 10), failure('unknown', 'TIMEOUT'));
  assert.equal(await rpc.request('delayed', { delay: 45, value: 'current' }), 'current');
});

test('RPC validation errors reject but internal errors preserve uncertain side effects', async t => {
  const rpc = client(); t.after(() => rpc.close());
  await assert.rejects(rpc.request('does-not-exist'), failure('rejected', -32601));
  await assert.rejects(rpc.request('internal-error'), failure('unknown', -32603));
});

test('malformed output closes transport and pending execution remains unknown', async t => {
  const rpc = client(); t.after(() => rpc.close());
  await assert.rejects(rpc.request('malformed'), failure('unknown', 'PROTOCOL_ERROR'));
  await assert.rejects(rpc.request('echo', {}), failure('not_sent', 'CLOSED'));
});

test('spawn failures are not sent; shell scripts are explicitly unsupported', async () => {
  const rpc = new StdioJsonRpcTransport({ executable: '/not-installed-agent-cowork-provider', args: [], cwd: process.cwd() });
  await assert.rejects(rpc.request('initialize'), failure('not_sent', 'SPAWN_FAILED'));
  rpc.close();
  assert.throws(() => new StdioJsonRpcTransport({ executable: 'tool.cmd', args: ['&', 'unsafe'], cwd: process.cwd() }), failure('not_sent'));
});

test('native initialization helper does not start a task or promote execution readiness', async t => {
  const rpc = client(); t.after(() => rpc.close());
  assert.deepEqual(await initializeCodex(rpc), { protocolInitialized: true, platformFamily: 'unix', platformOs: 'linux' });
  const probe = await probeProvider('codex', { command: '/not-installed-agent-cowork-provider' });
  assert.equal(probe.installed, false);
  assert.equal(probe.dispatchReady, false);
  assert.equal(probe.capabilities.submit.state, 'unverified');
  assert.throws(() => assertDispatchReady(probe, 'implement'), /暂不能派单/);
});

test('finding a native executable and its version never confirms authentication or task readiness', async () => {
  const probe = await probeProvider('codex', { command: process.execPath });
  assert.equal(probe.installed, true);
  assert.equal(probe.version, process.version.slice(1));
  assert.equal(probe.capabilities.installation.state, 'supported');
  assert.equal(probe.capabilities.authentication.state, 'unverified');
  assert.equal(probe.dispatchReady, false);
  assert.throws(() => assertDispatchReady(probe, 'review'), /暂不能派单/);
});
