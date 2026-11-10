import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { captureArtifact, createTaskWorkspace, inspectProject, readArtifactFile, verifyArtifact } from '../../packages/workspace/src/index.js';

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec('git', ['-C', cwd, ...args])).stdout.trim();

async function writableTree(directory: string): Promise<void> {
  await chmod(directory, 0o700);
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (item.isDirectory()) await writableTree(path.join(directory, item.name));
  }
}

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'cowork-workspace-'));
  t.after(async () => { await writableTree(root); await rm(root, { recursive: true, force: true }); });
  const project = path.join(root, '项目 with spaces');
  await mkdir(project);
  await git(project, 'init', '-b', 'main');
  await git(project, 'config', 'user.name', 'Workspace Test');
  await git(project, 'config', 'user.email', 'workspace-test@example.invalid');
  await writeFile(path.join(project, 'keep.txt'), 'original\n');
  await writeFile(path.join(project, 'delete.txt'), 'delete me\n');
  await writeFile(path.join(project, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
  await writeFile(path.join(project, '.gitignore'), 'ignored-output/\n');
  await git(project, 'add', '.');
  await git(project, '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture baseline');
  return { root, project, baseCommit: await git(project, 'rev-parse', 'HEAD'), workspaces: path.join(root, 'workspaces'), artifacts: path.join(root, 'artifacts') };
}

test('inspects clean committed Git root and identifies dirty input without modifying it', async t => {
  const f = await fixture(t);
  const clean = await inspectProject(f.project);
  assert.equal(clean.dirty, false);
  assert.equal(clean.baseCommit, f.baseCommit);
  assert.equal(clean.branch, 'main');
  await writeFile(path.join(f.project, 'local.txt'), 'user change');
  assert.equal((await inspectProject(f.project)).dirty, true);
  await assert.rejects(createTaskWorkspace(f.project, f.baseCommit, f.workspaces, 'run1'), { code: 'DIRTY_PROJECT' });
  assert.equal(await readFile(path.join(f.project, 'local.txt'), 'utf8'), 'user change');
});

test('creates detached unique worktree and leaves source branch and files untouched', async t => {
  const f = await fixture(t);
  const result = await createTaskWorkspace(f.project, f.baseCommit, f.workspaces, 'run-1');
  assert.equal(await git(result.path, 'rev-parse', 'HEAD'), f.baseCommit);
  assert.equal(await git(result.path, 'branch', '--show-current'), '');
  await writeFile(path.join(result.path, 'keep.txt'), 'agent change');
  assert.equal(await readFile(path.join(f.project, 'keep.txt'), 'utf8'), 'original\n');
  assert.equal(await git(f.project, 'branch', '--show-current'), 'main');
  await assert.rejects(createTaskWorkspace(f.project, f.baseCommit, f.workspaces, 'run-1'), { code: 'WORKSPACE_OCCUPIED' });
  assert.equal(await readFile(path.join(result.path, 'keep.txt'), 'utf8'), 'agent change');
});

test('rejects unsafe IDs, nested workspaces and uncommitted project before writes', async t => {
  const f = await fixture(t);
  await assert.rejects(createTaskWorkspace(f.project, f.baseCommit, f.workspaces, '../escape'), { code: 'INVALID_ID' });
  await assert.rejects(createTaskWorkspace(f.project, f.baseCommit, path.join(f.project, 'nested'), 'run1'), { code: 'WORKSPACE_OVERLAP' });
  await assert.rejects(lstat(path.join(f.project, 'nested')), { code: 'ENOENT' });
  await assert.rejects(createTaskWorkspace(f.project, '--help', f.workspaces, 'run1'), { code: 'INVALID_COMMIT' });
  const unborn = path.join(f.root, 'unborn');
  await mkdir(unborn);
  await git(unborn, 'init');
  await assert.rejects(inspectProject(unborn), { code: 'GIT_ERROR' });
});

test('captures immutable full snapshot with binary patch, deletion and nonignored new files', async t => {
  const f = await fixture(t);
  const work = await createTaskWorkspace(f.project, f.baseCommit, f.workspaces, 'run1');
  await writeFile(path.join(work.path, 'keep.txt'), 'changed\n');
  await rm(path.join(work.path, 'delete.txt'));
  await writeFile(path.join(work.path, 'binary.bin'), Buffer.from([0, 9, 8, 7]));
  await mkdir(path.join(work.path, 'docs'));
  await writeFile(path.join(work.path, 'docs', '新 文件.md'), '# result\n');
  await mkdir(path.join(work.path, 'ignored-output'));
  await writeFile(path.join(work.path, 'ignored-output', 'generated.txt'), 'not a deliverable');
  const artifact = await captureArtifact({ workspacePath: work.path, baseCommit: f.baseCommit, artifactRoot: f.artifacts, artifactId: 'artifact1', runId: 'run1', summary: 'Changed output' });
  assert.equal(artifact.manifest.find(x => x.path === 'docs/新 文件.md')?.source, 'untracked');
  assert.ok(!artifact.manifest.some(x => x.path === 'delete.txt' || x.path.includes('.git/') || x.path.startsWith('ignored-output/')));
  assert.deepEqual(await readArtifactFile(artifact.path, 'binary.bin', artifact.artifactHash), Buffer.from([0, 9, 8, 7]));
  const diff = await readFile(artifact.diffPath, 'utf8');
  assert.match(diff, /GIT binary patch/);
  assert.match(diff, /deleted file mode/);
  // The binary patch can actually be applied to a clean base; untracked files are in the manifest.
  const replay = await createTaskWorkspace(f.project, f.baseCommit, f.workspaces, 'replay');
  await git(replay.path, 'apply', '--binary', artifact.diffPath);
  assert.deepEqual(await readFile(path.join(replay.path, 'binary.bin')), Buffer.from([0, 9, 8, 7]));
  await assert.rejects(lstat(path.join(replay.path, 'delete.txt')), { code: 'ENOENT' });
  await writeFile(path.join(work.path, 'keep.txt'), 'later change');
  assert.equal((await readArtifactFile(artifact.path, 'keep.txt')).toString(), 'changed\n');
  assert.equal((await verifyArtifact(artifact.path)).manifestHash, artifact.manifestHash);
  await assert.rejects(captureArtifact({ workspacePath: work.path, baseCommit: f.baseCommit, artifactRoot: f.artifacts, artifactId: 'artifact1', runId: 'run1' }), { code: 'ARTIFACT_EXISTS' });
  await assert.rejects(readArtifactFile(artifact.path, '../keep.txt'), { code: 'INVALID_PATH' });
});

test('detects tampered snapshot and database hash mismatch', async t => {
  const f = await fixture(t);
  const work = await createTaskWorkspace(f.project, f.baseCommit, f.workspaces, 'run1');
  const artifact = await captureArtifact({ workspacePath: work.path, baseCommit: f.baseCommit, artifactRoot: f.artifacts, artifactId: 'artifact1', runId: 'run1' });
  await assert.rejects(verifyArtifact(artifact.path, '0'.repeat(64)), { code: 'ARTIFACT_HASH_MISMATCH' });
  await chmod(path.join(artifact.snapshotPath, 'keep.txt'), 0o600);
  await writeFile(path.join(artifact.snapshotPath, 'keep.txt'), 'tampered');
  await assert.rejects(verifyArtifact(artifact.path, artifact.artifactHash), { code: 'ARTIFACT_HASH_MISMATCH' });
});

test('binds baseline and patch metadata to the persisted artifact hash', async t => {
  const f = await fixture(t);
  const work = await createTaskWorkspace(f.project, f.baseCommit, f.workspaces, 'run1');
  const artifact = await captureArtifact({ workspacePath: work.path, baseCommit: f.baseCommit, artifactRoot: f.artifacts, artifactId: 'artifact1', runId: 'run1' });
  const metadataPath = path.join(artifact.path, 'artifact.json');
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  metadata.baseCommit = '1'.repeat(40);
  await chmod(metadataPath, 0o600);
  await writeFile(metadataPath, JSON.stringify(metadata));
  await assert.rejects(verifyArtifact(artifact.path, artifact.artifactHash), { code: 'ARTIFACT_HASH_MISMATCH' });
});

test('rejects unlisted files before a reviewer can inspect the snapshot directory', async t => {
  const f = await fixture(t);
  const work = await createTaskWorkspace(f.project, f.baseCommit, f.workspaces, 'run1');
  const artifact = await captureArtifact({ workspacePath: work.path, baseCommit: f.baseCommit, artifactRoot: f.artifacts, artifactId: 'artifact1', runId: 'run1' });
  await chmod(artifact.snapshotPath, 0o700);
  await writeFile(path.join(artifact.snapshotPath, 'unlisted.txt'), 'not the approved result');
  await assert.rejects(verifyArtifact(artifact.path, artifact.artifactHash), { code: 'ARTIFACT_HASH_MISMATCH' });
  // Even a request for an unchanged, listed file must reject the altered artifact as a whole.
  await assert.rejects(readArtifactFile(artifact.path, 'keep.txt', artifact.artifactHash), { code: 'ARTIFACT_HASH_MISMATCH' });
});

test('database hash rejects a self-consistent replacement of file, manifest and metadata', async t => {
  const f = await fixture(t);
  const work = await createTaskWorkspace(f.project, f.baseCommit, f.workspaces, 'run1');
  const artifact = await captureArtifact({ workspacePath: work.path, baseCommit: f.baseCommit, artifactRoot: f.artifacts, artifactId: 'artifact1', runId: 'run1' });
  const content = Buffer.from('replacement result');
  const hash = (input: string | Buffer) => createHash('sha256').update(input).digest('hex');
  const metadataPath = path.join(artifact.path, 'artifact.json');
  const manifestPath = path.join(artifact.path, 'manifest.json');
  const contentPath = path.join(artifact.snapshotPath, 'keep.txt');
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  const entry = metadata.manifest.find((item: { path: string }) => item.path === 'keep.txt');
  entry.sha256 = hash(content); entry.size = content.length;
  metadata.manifestHash = hash(JSON.stringify(metadata.manifest));
  metadata.artifactHash = hash(JSON.stringify({ baseCommit: metadata.baseCommit, manifestHash: metadata.manifestHash, diffHash: metadata.diffHash }));
  for (const filename of [contentPath, manifestPath, metadataPath]) await chmod(filename, 0o600);
  await writeFile(contentPath, content);
  await writeFile(manifestPath, JSON.stringify(metadata.manifest, null, 2));
  await writeFile(metadataPath, JSON.stringify(metadata, null, 2));
  assert.equal((await verifyArtifact(artifact.path)).artifactHash, metadata.artifactHash);
  await assert.rejects(verifyArtifact(artifact.path, artifact.artifactHash), { code: 'ARTIFACT_HASH_MISMATCH' });
});

test('rejects external symlinks and never copies their contents', async t => {
  const f = await fixture(t);
  const work = await createTaskWorkspace(f.project, f.baseCommit, f.workspaces, 'run1');
  const outside = path.join(f.root, 'outside.txt');
  await writeFile(outside, 'private');
  try { await symlink(outside, path.join(work.path, 'leak.txt')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('Host does not allow creating symlinks'); return; } throw error; }
  await assert.rejects(captureArtifact({ workspacePath: work.path, baseCommit: f.baseCommit, artifactRoot: f.artifacts, artifactId: 'artifact1', runId: 'run1' }), { code: 'SYMLINK_NOT_SUPPORTED' });
  await assert.rejects(verifyArtifact(path.join(f.artifacts, 'artifact1')), { code: 'INCOMPLETE_ARTIFACT' });
});

test('rejects oversized snapshots explicitly and never registers a partial artifact', async t => {
  const f = await fixture(t);
  const work = await createTaskWorkspace(f.project, f.baseCommit, f.workspaces, 'run1');
  await assert.rejects(captureArtifact({ workspacePath: work.path, baseCommit: f.baseCommit, artifactRoot: f.artifacts, artifactId: 'artifact1', runId: 'run1', maxBytes: 1 }), { code: 'ARTIFACT_TOO_LARGE' });
  await assert.rejects(verifyArtifact(path.join(f.artifacts, 'artifact1')), { code: 'INCOMPLETE_ARTIFACT' });
});
