import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, open, realpath, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { containsPath, ensureDirectory, safeId, WorkspaceError } from './paths.js';

const execFileAsync = promisify(execFile);
export async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const result = await execFileAsync('git', ['-C', cwd, ...args], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return result.stdout;
  } catch (error) {
    const e = error as Error & { stderr?: string };
    throw new WorkspaceError('GIT_ERROR', `Git 操作失败：${(e.stderr || e.message).trim().slice(0,1000)}`);
  }
}

export interface ProjectInspection {
  path: string;
  name: string;
  baseCommit: string;
  branch: string | null;
  dirty: boolean;
  status: string;
}

export async function inspectProject(projectPath: string): Promise<ProjectInspection> {
  let resolved: string;
  try { resolved = await realpath(path.resolve(projectPath)); }
  catch { throw new WorkspaceError('PROJECT_NOT_FOUND', '项目目录不存在或无法访问。'); }
  if (!(await lstat(resolved)).isDirectory()) throw new WorkspaceError('INVALID_PROJECT', '请选择 Git 仓库目录。');
  const root = await realpath((await git(resolved, ['rev-parse', '--show-toplevel'])).trim());
  if (root !== resolved) throw new WorkspaceError('NOT_REPOSITORY_ROOT', `请选择仓库根目录：${root}`);
  const baseCommit = (await git(root, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baseCommit)) throw new WorkspaceError('INVALID_COMMIT', '项目需要一个有效的已提交 Git 基准。');
  const status = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const branch = (await git(root, ['branch', '--show-current'])).trim() || null;
  return { path: root, name: path.basename(root), baseCommit, branch, dirty: status.length > 0, status };
}

export async function resolveCommit(projectPath: string, commit: string): Promise<string> {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) {
    throw new WorkspaceError('INVALID_COMMIT', '请使用完整的已提交 Git SHA 作为基准。');
  }
  const actual = (await git(projectPath, ['rev-parse', '--verify', `${commit}^{commit}`])).trim();
  if (actual !== commit) throw new WorkspaceError('INVALID_COMMIT', '基准不是对应的 Git 提交。');
  return actual;
}

export interface TaskWorkspace { path: string; baseCommit: string; projectPath: string; runId: string }

export async function createTaskWorkspace(projectPath: string, baseCommit: string, workspaceRoot: string, runId: string): Promise<TaskWorkspace> {
  safeId(runId);
  const project = await inspectProject(projectPath);
  if (project.dirty) throw new WorkspaceError('DIRTY_PROJECT', '项目存在未提交修改，请先由用户处理后再启动写任务。', 409);
  await resolveCommit(project.path, baseCommit);
  if (containsPath(project.path, path.resolve(workspaceRoot)) || containsPath(path.resolve(workspaceRoot), project.path)) {
    throw new WorkspaceError('WORKSPACE_OVERLAP', '任务工作区目录必须与原项目目录分开。');
  }
  const root = await ensureDirectory(workspaceRoot);
  if (containsPath(project.path, root) || containsPath(root, project.path)) {
    throw new WorkspaceError('WORKSPACE_OVERLAP', '任务工作区目录必须与原项目目录分开。');
  }
  const target = path.join(root, runId);
  const lockPath = path.join(root, `.${runId}.lock`);
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new WorkspaceError('WORKSPACE_OCCUPIED', '该执行已经分配了工作区或正在创建工作区。', 409);
    throw error;
  }
  try {
    try {
      await lstat(target);
      throw new WorkspaceError('WORKSPACE_OCCUPIED', '工作区已存在，不能覆盖或重置。', 409);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const hooks = path.join(root, '.empty-hooks');
    await mkdir(hooks, { recursive: true, mode: 0o700 });
    if ((await lstat(hooks)).isSymbolicLink() || (await readdir(hooks)).length !== 0) {
      throw new WorkspaceError('UNSAFE_HOOKS_DIRECTORY', '用于禁用 Git hooks 的目录必须是空目录。');
    }
    await git(project.path, ['-c', `core.hooksPath=${hooks}`, 'worktree', 'add', '--detach', '--', target, baseCommit]);
    if (await realpath(target) !== target) throw new WorkspaceError('UNSAFE_DIRECTORY', '新工作区路径发生变化。');
    return { path: target, baseCommit, projectPath: project.path, runId };
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}
