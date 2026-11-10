import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const files = readdirSync(resolve(root, 'tests'), { recursive: true })
  .filter(file => String(file).endsWith('.test.ts'))
  .map(file => resolve(root, 'tests', String(file)))
  .sort();
if (!files.length) throw new Error('No test files found; refusing a zero-test pass.');
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...files], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
