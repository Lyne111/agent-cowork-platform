import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import path from 'node:path';

export class WorkspaceError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 400) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

export function safeId(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) {
    throw new WorkspaceError('INVALID_ID', '任务或成果编号必须由字母、数字、下划线或连字符组成。');
  }
  return value;
}

export function containsPath(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function safeRelative(value: string): string {
  if (!value || value.includes('\0') || value.includes('\\') || path.posix.isAbsolute(value) || /^[a-zA-Z]:/.test(value)) {
    throw new WorkspaceError('INVALID_PATH', '文件路径必须是成果内的相对路径。');
  }
  const parts = value.split('/');
  if (parts.some(part => part === '' || part === '.' || part === '..' || part.toLowerCase() === '.git')) {
    throw new WorkspaceError('INVALID_PATH', '文件路径不能越过成果范围或访问 Git 元数据。');
  }
  // Reject Windows drive/ADS and reserved path aliases on every host so exported snapshots are portable.
  if (parts.some(part => /[:<>"|?*]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new WorkspaceError('NON_PORTABLE_PATH', `文件路径无法安全用于 Windows：${value}`);
  }
  return value;
}

/** Resolve existing ancestors before checking boundaries; never create through a symlink. */
export async function ensureDirectory(value: string): Promise<string> {
  const resolved = path.resolve(value);
  const { root } = path.parse(resolved);
  let cursor = root;
  for (const part of resolved.slice(root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    try {
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new WorkspaceError('UNSAFE_DIRECTORY', `目录不能是符号链接或普通文件：${cursor}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      try { await mkdir(cursor, { mode: 0o700 }); }
      catch (creationError) { if ((creationError as NodeJS.ErrnoException).code !== 'EEXIST') throw creationError; }
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new WorkspaceError('UNSAFE_DIRECTORY', '目录创建期间路径发生变化。');
    }
  }
  return realpath(resolved);
}

export async function regularFile(root: string, relative: string): Promise<string> {
  safeRelative(relative);
  let cursor = root;
  const parts = relative.split('/');
  for (let i = 0; i < parts.length; i += 1) {
    cursor = path.join(cursor, parts[i]!);
    const stat = await lstat(cursor);
    if (stat.isSymbolicLink()) throw new WorkspaceError('SYMLINK_NOT_SUPPORTED', `首版不收集符号链接：${relative}`);
    if (i < parts.length - 1 && !stat.isDirectory()) throw new WorkspaceError('INVALID_PATH', '文件父路径不是目录。');
    if (i === parts.length - 1 && !stat.isFile()) throw new WorkspaceError('UNSUPPORTED_FILE', `成果只支持普通文件：${relative}`);
  }
  const resolved = await realpath(cursor);
  if (!containsPath(root, resolved)) throw new WorkspaceError('PATH_ESCAPE', '文件越过工作区边界。');
  return resolved;
}

export async function readRegularFile(root: string, relative: string): Promise<Buffer> {
  const target = await regularFile(root, relative);
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!(await handle.stat()).isFile()) throw new WorkspaceError('UNSUPPORTED_FILE', '成果只支持普通文件。');
    return await handle.readFile();
  } finally { await handle.close(); }
}
