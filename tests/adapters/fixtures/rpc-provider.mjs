import { createInterface } from 'node:readline';
const input = createInterface({ input: process.stdin });
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
let approvalClientId;
input.on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'echo') {
    send({ method: 'progress', params: { text: '执行中' } });
    const output = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: message.params }) + '\n');
    const split = output.indexOf(Buffer.from('中')) + 1;
    process.stdout.write(output.subarray(0, split));
    setTimeout(() => process.stdout.write(output.subarray(split)), 5);
  } else if (message.method === 'delayed') {
    setTimeout(() => send({ id: message.id, result: message.params.value }), message.params.delay);
  } else if (message.method === 'approval') {
    approvalClientId = message.id;
    send({ id: 'permission-1', method: 'session/request_permission', params: { toolCallId: 'tool-1' } });
  } else if (message.id === 'permission-1' && 'result' in message) {
    send({ id: approvalClientId, result: message.result });
  } else if (message.method === 'hang') {
    send({ method: 'progress', params: { accepted: true } });
  } else if (message.method === 'exit') {
    process.exit(1);
  } else if (message.method === 'malformed') {
    process.stdout.write('not-json\n');
  } else if (message.method === 'internal-error') {
    send({ id: message.id, error: { code: -32603, message: 'Internal failure after operation' } });
  } else if (message.method === 'initialize') {
    send({ id: message.id, result: { platformFamily: 'unix', platformOs: 'linux', userAgent: 'fixture', codexHome: '/not-real' } });
  } else if (message.id !== undefined) {
    send({ id: message.id, error: { code: -32601, message: 'Method not found' } });
  }
});
