import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { git, resolveCommit } from './git.js';
import { containsPath, ensureDirectory, readRegularFile, regularFile, safeId, safeRelative, WorkspaceError } from './paths.js';

export interface ManifestEntry {
  path: string;
  sha256: string;
  size: number;
  executable: boolean;
  source: 'tracked' | 'untracked';
}

export interface ArtifactInput {
  workspacePath: string;
  baseCommit: string;
  artifactRoot: string;
  artifactId: string;
  runId: string;
  summary?: string;
  maxBytes?: number;
}

export interface ArtifactCapture {
  id: string;
  runId: string;
  path: string;
  snapshotPath: string;
  baseCommit: string;
  manifest: ManifestEntry[];
  manifestHash: string;
  artifactHash: string;
  diffPath: string;
  diffHash: string;
  summary: string;
  createdAt: string;
  captureScope: 'tracked-and-nonignored-untracked';
}

const digest = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const encodeManifest = (manifest: ManifestEntry[]) => JSON.stringify(manifest);
const artifactDigest = (baseCommit: string, manifestHash: string, diffHash: string) => digest(JSON.stringify({ baseCommit, manifestHash, diffHash }));

async function sources(workspace: string): Promise<Array<{ path: string; source: 'tracked' | 'untracked'; executable: boolean }>> {
  if ((await git(workspace, ['ls-files', '--unmerged', '-z'])).length) {
    throw new WorkspaceError('UNMERGED_FILES', '存在未解决的合并冲突，不能生成正式成果。');
  }
  const tracked = new Map<string, boolean>();
  for (const entry of (await git(workspace, ['ls-files', '--stage', '-z'])).split('\0').filter(Boolean)) {
    const match = /^(\d+) [a-f0-9]+ \d\t([\s\S]+)$/.exec(entry);
    if (!match) throw new WorkspaceError('GIT_INDEX_FORMAT', '无法解析 Git 文件列表。');
    const mode = match[1]!;
    const filename = safeRelative(match[2]!);
    if (mode === '160000') throw new WorkspaceError('SUBMODULE_NOT_SUPPORTED', '首版成果快照暂不支持 Git 子模块。');
    if (mode === '120000') throw new WorkspaceError('SYMLINK_NOT_SUPPORTED', '首版成果快照暂不支持符号链接。');
    tracked.set(filename, mode === '100755');
  }
  const entries: Array<{ path: string; source: 'tracked' | 'untracked'; executable: boolean }> = [];
  for (const [filename, executable] of tracked) {
    let stat;
    try { stat = await lstat(path.join(workspace, filename)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    if (stat.isDirectory()) continue; // A tracked file replaced by a directory is a deletion plus new files.
    entries.push({ path: filename, source: 'tracked', executable: process.platform === 'win32' ? executable : (stat.mode & 0o111) !== 0 });
  }
  for (const filename of (await git(workspace, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean)) {
    safeRelative(filename);
    const file = await regularFile(workspace, filename);
    const executable = ((await lstat(file)).mode & 0o111) !== 0;
    entries.push({ path: filename, source: 'untracked', executable });
  }
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const folded = new Map<string, string>();
  for (const entry of entries) {
    const parts = entry.path.split('/');
    for (let i = 1; i <= parts.length; i += 1) {
      const prefix = parts.slice(0, i).join('/');
      const previous = folded.get(prefix.toLowerCase());
      if (previous !== undefined && previous !== prefix) throw new WorkspaceError('CASE_COLLISION', '成果中存在 Windows 无法区分的大小写路径。');
      folded.set(prefix.toLowerCase(), prefix);
    }
  }
  return entries;
}

async function patch(workspace: string, baseCommit: string): Promise<string> {
  return git(workspace, ['diff', '--no-ext-diff', '--no-textconv', '--binary', '--full-index', '--no-renames', baseCommit, '--']);
}

async function buildManifest(workspace: string, snapshot: string | null, maxBytes: number): Promise<ManifestEntry[]> {
  const manifest: ManifestEntry[] = [];
  let total = 0;
  for (const entry of await sources(workspace)) {
    const target = await regularFile(workspace, entry.path);
    const size = (await lstat(target)).size;
    if (size > maxBytes - total) throw new WorkspaceError('ARTIFACT_TOO_LARGE', `成果超过 ${maxBytes} 字节上限；没有生成完整成果。`);
    const bytes = await readRegularFile(workspace, entry.path);
    total += bytes.length;
    if (total > maxBytes) throw new WorkspaceError('ARTIFACT_TOO_LARGE', '成果在读取期间超过大小上限。');
    const item: ManifestEntry = { ...entry, sha256: digest(bytes), size: bytes.length };
    manifest.push(item);
    if (snapshot) {
      const destination = path.join(snapshot, entry.path);
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, bytes, { flag: 'wx', mode: entry.executable ? 0o500 : 0o400 });
    }
  }
  return manifest;
}

/** Call only after the producing run has positively ended. No API mutates a completed artifact. */
export async function captureArtifact(input: ArtifactInput): Promise<ArtifactCapture> {
  safeId(input.artifactId); safeId(input.runId);
  const workspace = await realpath(input.workspacePath);
  const gitRoot = await realpath((await git(workspace, ['rev-parse', '--show-toplevel'])).trim());
  if (gitRoot !== workspace) throw new WorkspaceError('NOT_REPOSITORY_ROOT', '成果必须从分配的完整工作区生成。');
  await resolveCommit(workspace, input.baseCommit);
  if (containsPath(workspace, path.resolve(input.artifactRoot)) || containsPath(path.resolve(input.artifactRoot), workspace)) {
    throw new WorkspaceError('ARTIFACT_OVERLAP', '成果存储与活动工作区必须分开。');
  }
  const root = await ensureDirectory(input.artifactRoot);
  if (containsPath(workspace, root) || containsPath(root, workspace)) {
    throw new WorkspaceError('ARTIFACT_OVERLAP', '成果存储与活动工作区必须分开。');
  }
  const maxBytes = input.maxBytes ?? 256 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new WorkspaceError('INVALID_LIMIT', '成果大小上限无效。');
  const destination = path.join(root, input.artifactId);
  try { await mkdir(destination, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new WorkspaceError('ARTIFACT_EXISTS', '成果编号已存在；不能覆盖已有成果或未完成快照。', 409);
    throw error;
  }
  // An interrupted directory has no artifact.json completion marker and cannot be served or registered.
  const snapshot = path.join(destination, 'snapshot');
  await mkdir(snapshot, { mode: 0o700 });
  const before = await patch(workspace, input.baseCommit);
  const manifest = await buildManifest(workspace, snapshot, maxBytes);
  const after = await buildManifest(workspace, null, maxBytes);
  if (encodeManifest(manifest) !== encodeManifest(after) || before !== await patch(workspace, input.baseCommit)) {
    throw new WorkspaceError('WORKSPACE_CHANGED', '生成成果期间工作区发生变化；需要先确认执行结束再重新生成。', 409);
  }
  await writeFile(path.join(destination, 'changes.patch'), before, { flag: 'wx', mode: 0o400 });
  await writeFile(path.join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o400 });
  const artifact: ArtifactCapture = {
    id: input.artifactId, runId: input.runId, path: destination, snapshotPath: snapshot,
    baseCommit: input.baseCommit, manifest, manifestHash: digest(encodeManifest(manifest)),
    artifactHash: artifactDigest(input.baseCommit, digest(encodeManifest(manifest)), digest(before)),
    diffPath: path.join(destination, 'changes.patch'), diffHash: digest(before),
    summary: input.summary ?? '', createdAt: new Date().toISOString(), captureScope: 'tracked-and-nonignored-untracked',
  };
  // Save relative layout only; absolute paths are rebuilt so backups remain portable to Windows.
  const { path: _path, snapshotPath: _snapshotPath, diffPath: _diffPath, ...metadata } = artifact;
  await writeFile(path.join(destination, 'artifact.json'), JSON.stringify(metadata, null, 2), { flag: 'wx', mode: 0o400 });
  await chmod(snapshot, 0o500);
  return artifact;
}

export async function verifyArtifact(artifactPath: string, expectedArtifactHash?: string): Promise<ArtifactCapture> {
  const root = await realpath(artifactPath);
  let raw: unknown;
  try { raw = JSON.parse((await readRegularFile(root, 'artifact.json')).toString('utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new WorkspaceError('INCOMPLETE_ARTIFACT', '成果尚未完整保存。', 409);
    throw error;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new WorkspaceError('INVALID_ARTIFACT', '成果元数据无效。');
  const meta = raw as Omit<ArtifactCapture, 'path' | 'snapshotPath' | 'diffPath'>;
  safeId(meta.id); safeId(meta.runId);
  if (!Array.isArray(meta.manifest) || meta.captureScope !== 'tracked-and-nonignored-untracked' || typeof meta.manifestHash !== 'string') {
    throw new WorkspaceError('INVALID_ARTIFACT', '成果元数据无效。');
  }
  if (meta.artifactHash !== artifactDigest(meta.baseCommit, meta.manifestHash, meta.diffHash) || (expectedArtifactHash !== undefined && meta.artifactHash !== expectedArtifactHash)) {
    throw new WorkspaceError('ARTIFACT_HASH_MISMATCH', '成果版本与数据库登记的哈希不一致。', 409);
  }
  const snapshotPath = path.join(root, 'snapshot');
  if ((await lstat(snapshotPath)).isSymbolicLink()) throw new WorkspaceError('SYMLINK_NOT_SUPPORTED', '成果目录不能是符号链接。');
  const manifestRaw = await readRegularFile(root, 'manifest.json');
  if (encodeManifest(JSON.parse(manifestRaw.toString('utf8'))) !== encodeManifest(meta.manifest) || digest(encodeManifest(meta.manifest)) !== meta.manifestHash) {
    throw new WorkspaceError('ARTIFACT_HASH_MISMATCH', '成果文件清单已被修改。', 409);
  }
  const paths = new Set<string>();
  for (const entry of meta.manifest) {
    safeRelative(entry.path);
    if (paths.has(entry.path)) throw new WorkspaceError('INVALID_ARTIFACT', '成果清单含重复文件。');
    paths.add(entry.path);
    const data = await readRegularFile(snapshotPath, entry.path);
    if (digest(data) !== entry.sha256 || data.length !== entry.size) throw new WorkspaceError('ARTIFACT_HASH_MISMATCH', `成果文件已被修改：${entry.path}`, 409);
  }
  // Review tools may inspect the whole directory, so checking listed files alone is insufficient.
  const directories = new Set<string>();
  for (const filename of paths) {
    const parts = filename.split('/');
    for (let i = 1; i < parts.length; i += 1) directories.add(parts.slice(0, i).join('/'));
  }
  async function verifyEntries(relativeDirectory = ''): Promise<void> {
    const directory = relativeDirectory ? path.join(snapshotPath, relativeDirectory) : snapshotPath;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const stat = await lstat(path.join(snapshotPath, relative));
      if (stat.isSymbolicLink()) throw new WorkspaceError('SYMLINK_NOT_SUPPORTED', '成果目录中不能包含符号链接。');
      if (stat.isDirectory()) {
        if (!directories.has(relative)) throw new WorkspaceError('ARTIFACT_HASH_MISMATCH', `成果中出现未登记目录：${relative}`, 409);
        await verifyEntries(relative);
      } else if (!stat.isFile() || !paths.has(relative)) {
        throw new WorkspaceError('ARTIFACT_HASH_MISMATCH', `成果中出现未登记文件：${relative}`, 409);
      }
    }
  }
  await verifyEntries();
  const diff = await readRegularFile(root, 'changes.patch');
  if (digest(diff) !== meta.diffHash) throw new WorkspaceError('ARTIFACT_HASH_MISMATCH', '成果补丁已被修改。', 409);
  return { ...meta, path: root, snapshotPath, diffPath: path.join(root, 'changes.patch') };
}

export async function readArtifactFile(artifactPath: string, relativePath: string, expectedArtifactHash?: string): Promise<Buffer> {
  safeRelative(relativePath);
  const artifact = await verifyArtifact(artifactPath, expectedArtifactHash);
  if (!artifact.manifest.some(entry => entry.path === relativePath)) throw new WorkspaceError('ARTIFACT_FILE_NOT_FOUND', '文件不在该成果清单中。', 404);
  const bytes = await readRegularFile(artifact.snapshotPath, relativePath);
  const entry = artifact.manifest.find(item => item.path === relativePath)!;
  if (digest(bytes) !== entry.sha256) throw new WorkspaceError('ARTIFACT_HASH_MISMATCH', '读取成果期间内容发生变化。', 409);
  return bytes;
}
