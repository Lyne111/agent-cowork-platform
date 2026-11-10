import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const vite = resolve(root, 'node_modules/vite/bin/vite.js');
const tsx = resolve(root, 'node_modules/tsx/dist/cli.mjs');
const config = resolve(root, 'apps/web/vite.config.ts');
const first = spawnSync(process.execPath, [vite, 'build', '--config', config], { cwd: root, stdio: 'inherit' });
if (first.status !== 0) process.exit(first.status ?? 1);
const children = [
  spawn(process.execPath, [vite, 'build', '--watch', '--config', config], { cwd: root, stdio: 'inherit' }),
  spawn(process.execPath, [tsx, 'watch', 'apps/server/src/main.ts'], { cwd: root, stdio: 'inherit' })
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  process.exitCode = code;
}
for (const child of children) {
  child.on('error', error => { console.error(error.message); stop(1); });
  child.on('exit', code => { if (!stopping) stop(code ?? 1); });
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
