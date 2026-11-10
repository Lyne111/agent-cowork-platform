import { spawnSync } from 'node:child_process';

const [major, minor, patch] = process.versions.node.split('.').map(Number);
const supported = major === 24 && (minor > 22 || (minor === 22 && patch >= 1));
if (!supported) {
  console.error(`Node.js ${process.versions.node} was found. Install Node.js 24.22.1 or a newer Node 24 release, then reopen this installer.`);
  process.exit(1);
}
const git = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true });
if (git.error || git.status !== 0) {
  console.error('Git is required. Install Git for Windows with command-line access enabled, then reopen this installer.');
  process.exit(1);
}
console.log(`Node.js ${process.versions.node}`);
console.log(git.stdout.trim());
