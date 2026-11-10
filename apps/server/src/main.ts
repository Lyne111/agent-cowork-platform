import { resolve } from 'node:path';
import { buildServer } from './index.js';

const port = Number(process.env.AGENT_COWORK_PORT || '3210');
const dataDir = resolve(process.env.AGENT_COWORK_DATA_DIR || '.local-data');
const { app } = await buildServer({ dataDir, port });
await app.listen({ host: '127.0.0.1', port });
console.log(`Agent Cowork is listening on 127.0.0.1:${port}`);
console.log(`Application data: ${dataDir}`);
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    console.log('Closing the service; unfinished executions require reconciliation on restart.');
    void app.close().then(() => process.exit(0), error => { console.error(error instanceof Error ? error.message : 'Shutdown failed.'); process.exit(1); });
  });
}
