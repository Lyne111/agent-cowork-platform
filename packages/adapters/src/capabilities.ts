import { execFile } from 'node:child_process';
import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, extname, isAbsolute, join } from 'node:path';

export type ProviderId = 'codex' | 'antigravity' | 'deepseek-harness';
export type CapabilityState = 'supported' | 'unsupported' | 'unverified';
export const capabilityNames = [
  'installation', 'protocol', 'authentication', 'createSession', 'submit',
  'approval', 'result', 'cancel', 'inspectRun', 'directoryScope',
  'readOnlyReview', 'childStop', 'askUser', 'modelSelection', 'usage',
] as const;
export type CapabilityName = typeof capabilityNames[number];
export interface Capability { state: CapabilityState; detail: string }
export interface ProviderProbe {
  id: ProviderId;
  name: string;
  command: string;
  installed: boolean;
  version: string | null;
  platform: string;
  checkedAt: string;
  /** Installation or a handshake alone never authorizes a real task. */
  dispatchReady: false;
  capabilities: Record<CapabilityName, Capability>;
  issues: string[];
}
export const providers: ReadonlyArray<{ id: ProviderId; name: string; command: string }> = [
  { id: 'codex', name: 'Codex', command: 'codex' },
  { id: 'antigravity', name: 'Antigravity', command: 'agy' },
  { id: 'deepseek-harness', name: 'DeepSeek Harness', command: 'dsh' },
];

/** Resolve a program without invoking a shell or interpreting its contents. */
export async function resolveExecutable(command: string): Promise<string | null> {
  if (!command || command.includes('\0')) return null;
  const explicit = isAbsolute(command) || command.includes('/') || command.includes('\\');
  const directories = explicit ? [''] : (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  const suffixes = process.platform === 'win32' && !extname(command)
    ? ['', ...(process.env.PATHEXT ?? '.EXE;.COM;.BAT;.CMD').split(';')]
    : [''];
  for (const directory of directories) {
    for (const suffix of suffixes) {
      const candidate = directory ? join(directory, command + suffix) : command + suffix;
      try {
        await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
        if (!(await stat(candidate)).isFile()) continue;
        return await realpath(candidate);
      } catch { /* Try the next PATH entry. */ }
    }
  }
  return null;
}

export async function probeProvider(
  id: ProviderId,
  options: { command?: string; cwd?: string; timeoutMs?: number } = {},
): Promise<ProviderProbe> {
  const definition = providers.find(provider => provider.id === id);
  if (!definition) throw new Error('Unknown provider');
  const capabilities = Object.fromEntries(capabilityNames.map(name => [name, {
    state: 'unverified', detail: '尚未针对当前工具版本完成真实验证。',
  }])) as Record<CapabilityName, Capability>;
  const command = options.command ?? definition.command;
  const result: ProviderProbe = {
    ...definition, command, installed: false, version: null,
    platform: process.platform, checkedAt: new Date().toISOString(),
    dispatchReady: false, capabilities, issues: [],
  };
  const executable = await resolveExecutable(command);
  if (!executable) {
    capabilities.installation = { state: 'unsupported', detail: '当前 PATH 中未找到工具；这表示本机缺少安装，不代表厂商不支持该功能。' };
    result.issues.push(`未找到 ${definition.command}，请按该工具官方说明安装并完成登录。`);
    return result;
  }
  result.installed = true;
  // Do not turn untrusted text into cmd.exe arguments. npm .cmd shims require
  // an explicitly selected native executable or a future audited launcher.
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable)) {
    capabilities.installation = { state: 'supported', detail: '发现 Windows 命令脚本。' };
    result.issues.push('当前探测器不经 Shell 运行 .cmd/.bat；请使用官方原生 .exe。脚本启动方式待单独验证。');
    return result;
  }
  const version = await new Promise<{ version: string | null; reason?: string }>(resolve => {
    execFile(executable, ['--version'], {
      cwd: options.cwd, timeout: options.timeoutMs ?? 5_000,
      maxBuffer: 64 * 1024, windowsHide: true, encoding: 'utf8', shell: false,
    }, (error, stdout) => {
      if (error) {
        resolve({ version: null, reason: error.killed ? '版本探测超时。' : '版本命令失败；未输出可能包含敏感信息的原始日志。' });
        return;
      }
      // Preserve a reported semver only; arbitrary stdout/stderr can contain secrets.
      const match = stdout.match(/(?:^|[\s=:])v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\b/);
      resolve({ version: match?.[1] ?? null, ...(match ? {} : { reason: '工具返回成功，但未识别到版本号。' }) });
    });
  });
  result.version = version.version;
  capabilities.installation = { state: 'supported', detail: version.version ? `发现工具，报告版本 ${version.version}。` : '发现可执行文件，版本未确认。' };
  if (version.reason) result.issues.push(version.reason);
  result.issues.push('尚未验证真实任务、目录限制、停止及恢复；原生派单保持禁用。');
  return result;
}

export async function probeProviders(options: { cwd?: string } = {}): Promise<ProviderProbe[]> {
  return Promise.all(providers.map(provider => probeProvider(provider.id, options)));
}

export class AdapterUnavailableError extends Error {
  readonly code = 'PROVIDER_UNVERIFIED';
  constructor(public readonly provider: ProviderId, public readonly missing: string[]) {
    super(`${provider} 暂不能派单：${missing.join('、')}`);
    this.name = 'AdapterUnavailableError';
  }
}

/** Release gate. No UI checkbox or environment variable can fabricate evidence. */
export function assertDispatchReady(probe: ProviderProbe, role: 'implement' | 'review'): never {
  const required: CapabilityName[] = ['authentication', 'createSession', 'submit', 'approval', 'result', 'cancel', 'directoryScope', 'childStop'];
  if (role === 'review') required.push('readOnlyReview');
  if (probe.id === 'deepseek-harness') required.push('askUser');
  const missing = required.filter(name => probe.capabilities[name].state !== 'supported');
  // This build has transports/probes, but no production execution adapter yet.
  throw new AdapterUnavailableError(probe.id, missing.length ? missing : ['真实执行适配器尚未发布']);
}
