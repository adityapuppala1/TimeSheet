import { chromium } from '@playwright/test';
import ts from 'typescript';
import { readFile, mkdir, writeFile } from 'node:fs/promises';

const source = ts.createSourceFile('Sidebar.tsx', await readFile('apps/web/src/components/Sidebar.tsx', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const routes = new Set(['/app/profile', '/app/help']);
function visit(node) {
  if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'to' && ts.isStringLiteral(node.initializer) && node.initializer.text.startsWith('/app')) routes.add(node.initializer.text);
  ts.forEachChild(node, visit);
}
visit(source);
const role = process.argv[2] ?? 'superadmin';
if (!['superadmin', 'manager', 'employee'].includes(role)) throw new Error('Unknown audit role');
const out = `test-results/ui-audit-${role}`;
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
const base = process.env.TS_WEB ?? 'https://localhost:5173';
const results = [];
let errors = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.goto(`${base}/login`);
  await page.getByLabel('Email', { exact: true }).fill(process.env.TS_USER ?? `${role}@timesheet.local`);
  await page.getByLabel('Password', { exact: true }).fill(process.env.TS_PASS ?? 'Admin@12345');
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL('**/app');
  // An audit must never save settings, invoke an agent, send mail, or spend model tokens.
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method()) || request.url().endsWith('/auth/refresh')) return route.continue();
    errors.push(`Blocked audit write: ${request.method()} ${new URL(request.url()).pathname}`);
    return route.abort('blockedbyclient');
  });
  for (const path of routes) {
    errors = [];
    const result = { path, tabs: [], frames: [], errors };
    try {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.goto(base + path);
      await page.waitForLoadState('networkidle', { timeout: 3500 }).catch(() => {});
      result.actualPath = new URL(page.url()).pathname;
      result.text = await page.locator('body').innerText();
      const labels = await page.getByRole('tab').allTextContents();
      for (const label of [...new Set(labels)]) {
        const tab = page.getByRole('tab', { name: label.trim(), exact: true }).first();
        if (!await tab.isVisible() || !await tab.isEnabled()) continue;
        await tab.click();
        await page.waitForLoadState('networkidle', { timeout: 1800 }).catch(() => {});
        result.tabs.push({ label, text: await page.getByRole('tabpanel').allTextContents() });
      }
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        for (const theme of ['light', 'dark']) {
          await page.evaluate((value) => document.documentElement.classList.toggle('dark', value === 'dark'), theme);
          const overflow = await page.evaluate(() => [...document.querySelectorAll('main *')].filter((node) => {
            const rect = node.getBoundingClientRect();
            return rect.width > 0 && (rect.right > innerWidth + 2 || rect.left < -2) && getComputedStyle(node).position !== 'fixed';
          }).slice(0, 12).map((node) => ({ tag: node.tagName, text: node.textContent?.slice(0, 80), className: String(node.className).slice(0, 160) })));
          const file = `${out}/${path.replaceAll('/', '_')}-${width}-${theme}.png`;
          await page.screenshot({ path: file, animations: 'disabled' });
          result.frames.push({ width, theme, file, overflow });
        }
      }
    } catch (error) { result.failure = error.message; }
    results.push(result);
    await writeFile(`${out}/results.json`, JSON.stringify(results, null, 2));
    console.log(`${path}: ${result.tabs.length} tabs, ${result.frames.length} frames${result.failure ? ' FAILED' : ''}`);
  }
} finally { await browser.close(); }
console.log(JSON.stringify({ pages: results.length, tabs: results.reduce((n, r) => n + r.tabs.length, 0), failures: results.filter((r) => r.failure).map((r) => r.path) }));
