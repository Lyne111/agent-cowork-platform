import { probeProviders, resolveExecutable, StdioJsonRpcTransport, initializeCodex } from '../packages/adapters/src/index.js';

const results = await probeProviders({ cwd: process.cwd() });
let codexHandshake: { state: string; detail: string } | undefined;
if (process.argv.includes('--codex-handshake')) {
  const executable = await resolveExecutable('codex');
  let transport: StdioJsonRpcTransport | undefined;
  try {
    if (!executable) throw new Error('CLI not installed');
    transport = new StdioJsonRpcTransport({ executable, args: ['app-server', '--stdio'], cwd: process.cwd(), timeoutMs: 15_000 });
    const result = await initializeCodex(transport);
    codexHandshake = { state: 'supported', detail: `初始化成功，工具报告 ${result.platformFamily}/${result.platformOs}；未创建线程或任务。` };
    const probe = results.find(item => item.id === 'codex')!;
    probe.capabilities.protocol = codexHandshake as { state: 'supported'; detail: string };
  } catch {
    codexHandshake = { state: 'unverified', detail: '初始化未完成；请在原生 CLI 中检查本机配置及数据目录权限，随后重试。未输出原始日志。' };
  } finally { transport?.close(); }
}
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), providers: results, ...(codexHandshake ? { codexHandshake } : {}) }, null, 2));
} else {
  console.log('Agent Cowork · 本机接入检查');
  console.log(`系统：${process.platform} / Node ${process.version}`);
  for (const probe of results) {
    console.log(`\n${probe.name}: ${probe.installed ? '已找到' : '未安装'} / 版本 ${probe.version ?? '未知'}`);
    for (const issue of probe.issues) console.log(`  - ${issue}`);
    console.log('  真实派单：未启用（需完成兼容性验收）');
  }
  if (codexHandshake) console.log(`\nCodex 协议：${codexHandshake.detail}`);
  console.log('\n默认只检查安装和版本；--codex-handshake 额外初始化协议。均不会调用模型或创建线程/任务。');
  console.log('完整验收步骤见 docs/compatibility.md。');
}
// Missing tools are actionable diagnostics, not proof the app build is broken.
if (process.argv.includes('--require-ready') && results.some(result => !result.dispatchReady)) process.exitCode = 2;
