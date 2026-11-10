import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import { chromium } from 'playwright';
import { buildServer } from '../apps/server/src/index.js';

const root = resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(join(tmpdir(), 'cowork-browser-'));
const projectPath = join(temporary, '中文 project');
await mkdir(projectPath);
const git = (...args: string[]) => execFileSync('git', args, { cwd: projectPath, stdio: 'pipe' });
git('init'); git('config', 'user.name', 'Browser Fixture'); git('config', 'user.email', 'fixture@example.invalid');
await writeFile(join(projectPath, 'README.md'), '# Browser fixture\n');
git('add', '.'); git('commit', '-m', 'Initial browser fixture');
const reservation = createServer();
await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
const address = reservation.address();
assert(address && typeof address === 'object');
const port = address.port;
await new Promise<void>(resolve => reservation.close(() => resolve()));
const server = await buildServer({ dataDir: join(temporary, 'data'), port });
await server.app.listen({ host: '127.0.0.1', port });
const executablePath = process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let diagnosticPage: Awaited<ReturnType<NonNullable<typeof browser>['newPage']>> | undefined;
const errors: string[] = [];
try {
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
  diagnosticPage = page;
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '项目与连接', exact: true }).click();
  await page.getByRole('button', { name: '添加项目', exact: true }).click();
  await page.getByLabel('项目名称', { exact: true }).fill('浏览器验证项目');
  await page.getByLabel('仓库绝对路径', { exact: false }).fill(projectPath);
  await page.getByRole('button', { name: '检查并添加项目', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.project-row').count(), 1);

  await page.getByRole('button', { name: '新增 / 导入', exact: true }).click();
  await page.getByLabel('规则内容', { exact: true }).fill('输出先给结论，并附上可核对的证据。');
  await page.getByLabel('我已检查内容与作用范围，确认将其保存为正式规则').check();
  await page.getByRole('button', { name: '确认保存规则', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '编辑新版本', exact: true }).click();
  await page.getByLabel('规则内容', { exact: true }).fill('使用中文，先给结论，再附可核对的证据。');
  await page.getByLabel('我已检查内容与作用范围，确认将其保存为正式规则').check();
  await page.getByRole('button', { name: '确认保存新版本', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal(server.core.snapshot().rules.length, 2);

  await page.getByRole('button', { name: '新建角色', exact: true }).click();
  await page.getByLabel('角色名称', { exact: true }).fill('文档检查员');
  await page.getByLabel('职责', { exact: true }).selectOption('reviewer');
  await page.getByLabel('职责边界与交付要求', { exact: true }).fill('只读检查文档准确性。');
  await page.getByRole('button', { name: '保存角色档案', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal(server.core.snapshot().profiles.length, 4);

  await page.getByRole('button', { name: /^任务看板/ }).click();
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.getByRole('button', { name: '新建任务', exact: true }).click();
    await page.getByLabel('任务标题', { exact: true }).fill('补充使用文档');
    await page.getByLabel('目标', { exact: true }).fill('记录本地安装步骤和文件位置。');
    await page.getByLabel('验收条件', { exact: true }).fill('路径清楚，命令可复现，限制如实说明。');
    await page.getByRole('button', { name: '创建任务', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
  }
  assert.equal(server.core.snapshot().tasks.length, 2, 'Two separate user intentions may have identical content.');
  await page.locator('.task-card').first().click();
  assert(await page.getByRole('button', { name: '启动任务', exact: true }).isDisabled());
  await page.getByLabel('补充任务讨论', { exact: true }).fill('@实现者 这是一条讨论，不授权执行。');
  await page.getByRole('button', { name: '记录讨论', exact: true }).click();
  await page.getByText('@实现者 这是一条讨论，不授权执行。', { exact: true }).waitFor();
  assert.equal(server.core.snapshot().runs.length, 0, 'Discussion must never dispatch a task.');
  await page.getByRole('button', { name: '暂停派单', exact: true }).click();
  await page.getByRole('button', { name: '恢复派单', exact: true }).waitFor();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '恢复派单', exact: true }).waitFor();
  assert.equal(server.core.snapshot().paused, true);
  await page.getByRole('button', { name: '恢复派单', exact: true }).click();
  await page.getByRole('button', { name: '暂停派单', exact: true }).waitFor();

  const screenshotDir = join(root, 'artifacts');
  await mkdir(screenshotDir, { recursive: true });
  await page.screenshot({ path: join(screenshotDir, 'browser-task-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: /^任务看板/ }).click();
  await page.screenshot({ path: join(screenshotDir, 'browser-board-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'Mobile layout must not overflow the viewport.');
  await page.screenshot({ path: join(screenshotDir, 'browser-board-mobile.png'), fullPage: true });
  assert.deepEqual(errors, [], 'Browser must not report uncaught runtime errors.');
  console.log('Browser smoke passed: real project, rule versions, profile, two task intentions, discussion, unavailable-provider gate, reload persistence and desktop/mobile layout.');
} catch (error) {
  await mkdir(join(root, 'artifacts'), { recursive: true });
  await diagnosticPage?.screenshot({ path: join(root, 'artifacts/browser-failure.png'), fullPage: true });
  console.error('Browser errors:', errors);
  console.error((await diagnosticPage?.locator('body').innerText())?.slice(0, 6000));
  throw error;
} finally {
  await browser?.close();
  await server.app.close();
  await rm(temporary, { recursive: true, force: true });
}
