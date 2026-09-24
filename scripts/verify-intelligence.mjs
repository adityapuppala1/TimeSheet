import { chromium, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const browser = await chromium.launch();
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const base = process.env.TS_WEB ?? 'https://localhost:5173';
const out = 'test-results/run-shots';
await mkdir(out, { recursive: true });
try {
  await page.goto(`${base}/login`);
  await page.getByLabel('Email', { exact: true }).fill(process.env.TS_USER ?? 'superadmin@timesheet.local');
  await page.getByLabel('Password', { exact: true }).fill(process.env.TS_PASS ?? 'Admin@12345');
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL('**/app');
  await page.route('**/api/ai/overview', (route) => route.fulfill({ json: {
    agents: { total: 0, enabled: 0 }, flows: { total: 0, live: 0 }
  } }));
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('setup-checklist-dismissed:')) localStorage.removeItem(key);
    }
  });
  await page.reload();
  await expect(page.getByRole('link', { name: /Meet the AI teammates/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Build a workflow/ })).toBeVisible();
  const setup = page.getByRole('progressbar', { name: 'Setup completion' });
  const setupCard = setup.locator('..');
  await expect.poll(() => setup.evaluate((progress) =>
    Number(progress.getAttribute('max')) === progress.parentElement.querySelectorAll('li').length
  )).toBe(true);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => document.documentElement.classList.toggle('dark', value === 'dark'), theme);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await setupCard.screenshot({ path: `${out}/setup-${width}-${theme}.png` });
    }
  }
  const dismissSetup = page.getByRole('button', { name: 'Dismiss setup checklist' });
  if (await dismissSetup.isVisible()) {
    await dismissSetup.click();
    await expect(setup).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Admin command center', exact: true })).toBeVisible();
    await expect(setup).toHaveCount(0);
  }
  await page.unroute('**/api/ai/overview');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${base}/app/intelligence`);
  await expect(page.getByRole('heading', { name: 'Intelligence center', exact: true })).toBeVisible();
  const reportShortcut = page.getByRole('link', { name: 'Start with AI: Build a report', exact: true });
  await expect(reportShortcut).toBeVisible();
  expect((await reportShortcut.boundingBox()).height).toBeGreaterThanOrEqual(44);
  await reportShortcut.focus();
  await expect(reportShortcut).toBeFocused();
  await page.getByRole('button', { name: 'Build report', exact: true }).click();
  await page.getByLabel('From', { exact: true }).fill('2026-09-20');
  await page.getByLabel('To', { exact: true }).fill('2026-09-01');
  await expect(page.getByRole('button', { name: 'Generate report', exact: true })).toBeDisabled();
  await page.getByLabel('To', { exact: true }).fill('2026-09-23');
  await page.route('**/api/ai-chat/ask', async (route) => {
    const { prompt, readOnly } = route.request().postDataJSON();
    expect(readOnly).toBe(true);
    expect(prompt).toContain('2026-09-20 through 2026-09-23');
    expect(prompt).toContain('Do not create or update any records');
    await route.fulfill({ json: { id: 'report-check', answer: '## Verified report\n\nExample result.', error: null, createdAt: new Date().toISOString(), toolCalls: [{ tool: 'search_tickets', detail: '{"query":"TEST-1"}', references: [{ kind: 'ticket', id: 'ticket-fixture-id', key: 'TEST-1', title: 'Fixture ticket' }] }] } });
  });
  await page.getByRole('button', { name: 'Generate report', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Verified report' })).toBeVisible();
  const reportContext = page.locator('dl[aria-label="Report context"]');
  await expect(reportContext).toContainText('2026-09-20 to 2026-09-23');
  await expect(reportContext.locator('time')).toHaveAttribute('datetime', /\d{4}-\d{2}-\d{2}T/);
  await expect(page.getByText('Source-data freshness is not verified by the report timestamp.')).toBeVisible();
  const toolSummary = page.locator('summary').filter({ hasText: 'Tool evidence (1)' });
  await toolSummary.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('list', { name: 'Recorded tool calls' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open TEST-1: Fixture ticket' })).toHaveAttribute('href', '/app/tickets?open=ticket-fixture-id');
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => document.documentElement.classList.toggle('dark', value === 'dark'), theme);
      await page.screenshot({ path: `${out}/report-context-${width}-${theme}.png`, animations: 'disabled' });
      await expect.poll(() => reportContext.evaluate((context) => {
        const dialog = context.closest('[role="dialog"]').getBoundingClientRect();
        const content = context.getBoundingClientRect();
        return context.scrollWidth <= context.clientWidth && content.left >= dialog.left
          && content.right <= dialog.right && dialog.left >= 0 && dialog.right <= innerWidth;
      })).toBe(true);
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByLabel('To', { exact: true }).fill('2026-09-24');
  await expect(page.getByText('Report settings changed. Generate a report for the current settings.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Verified report' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Export Markdown' })).toHaveCount(0);
  await page.getByLabel('To', { exact: true }).fill('2026-09-23');
  await expect(page.getByRole('heading', { name: 'Verified report' })).toBeVisible();
  await page.getByLabel('Group by', { exact: true }).click();
  await page.getByRole('option', { name: 'day', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Export Markdown' })).toHaveCount(0);
  await page.getByLabel('Group by', { exact: true }).click();
  await page.getByRole('option', { name: 'project', exact: true }).click();
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export Markdown' }).click();
  expect((await downloadEvent).suggestedFilename()).toBe('timesphere-report.md');
  await page.unroute('**/api/ai-chat/ask');
  let finishReport;
  const reportReady = new Promise((resolve) => { finishReport = resolve; });
  await page.route('**/api/ai-chat/ask', async (route) => {
    await reportReady;
    await route.fulfill({ json: { answer: '## Delayed report', error: null, createdAt: new Date().toISOString(), toolCalls: [] } });
  });
  await page.getByRole('button', { name: 'Generate report', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Generating report...', exact: true })).toBeDisabled();
  await page.getByLabel('Report question', { exact: true }).fill('Show overdue work only');
  finishReport();
  await expect(page.getByText('Report settings changed. Generate a report for the current settings.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Delayed report' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Export Markdown' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.unroute('**/api/ai-chat/ask');
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => document.documentElement.classList.toggle('dark', value === 'dark'), theme);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: `${out}/intelligence-${width}-${theme}.png`, fullPage: true });
    }
  }
  await page.getByRole('button', { name: /Ask AI about/ }).click();
  const input = page.getByRole('textbox', { name: 'Question for AI' });
  await expect(input).toBeVisible();
  await expect.poll(async () => {
    const box = await page.getByRole('dialog').boundingBox();
    return box && Math.abs(box.y) < 2 && box.x >= -2 && box.x + box.width <= 392;
  }).toBe(true);
  await input.fill('Summarize my work');
  let finishAnswer;
  const answerReady = new Promise((resolve) => { finishAnswer = resolve; });
  await page.route('**/api/ai-chat/ask', async (route) => {
    await answerReady;
    await route.fulfill({ json: { id: 'verification-only', prompt: 'Summarize my work', answer: 'Verification response', durationMs: 10, toolCalls: [], model: null } });
  });
  await page.getByRole('button', { name: 'Send question' }).click();
  await input.fill('Keep this unsent follow-up');
  finishAnswer();
  await expect(page.getByText('Verification response', { exact: true })).toBeVisible();
  await expect(input).toHaveValue('Keep this unsent follow-up');
  await page.screenshot({ path: `${out}/intelligence-mobile-copilot.png`, fullPage: true });
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('link', { name: 'Start with AI' }).first().click();
  await expect(page.locator('textarea')).toHaveValue(/Build a concise report/);
  const stylePicker = page.getByRole('combobox', { name: 'Answer style (this browser)' });
  await stylePicker.click();
  await page.getByRole('option', { name: 'Concise', exact: true }).click();
  await page.reload();
  await expect(stylePicker).toContainText('Concise');
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await stylePicker.click();
  await page.getByRole('option', { name: 'Default', exact: true }).click();
  await page.reload();
  await expect(stylePicker).toContainText('Default');
  await page.unroute('**/api/ai-chat/ask');
  await page.route('**/api/ai-chat/history*', (route) => route.fulfill({ json: [{
    id: 'evidence-fixture', prompt: 'Review the recorded calls', answer: 'Evidence fixture answer', error: null,
    toolCalls: [{ tool: 'ticket_search', detail: 'Recorded query: ' + 'x'.repeat(160), references: [{ kind: 'ticket', id: 'ask-ticket-fixture', key: 'ASK-1', title: 'Long evidence fixture' }] }],
    model: null, provider: null, inputTokens: 0, outputTokens: 0, costUsd: null,
    durationMs: 1, feedback: null, createdAt: new Date().toISOString()
  }] }));
  await page.reload();
  await page.locator('summary').filter({ hasText: 'Tool evidence (1)' }).click();
  await expect(page.getByRole('list', { name: 'Recorded tool calls' })).toContainText('Recorded query:');
  await expect(page.getByRole('link', { name: 'Open ASK-1: Long evidence fixture' })).toHaveAttribute('href', '/app/tickets?open=ask-ticket-fixture');
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `${out}/ask-ai-evidence-mobile.png`, animations: 'disabled' });
  await page.unroute('**/api/ai-chat/history*');
  await page.route('**/api/ai-chat/history*', (route) => route.fulfill({ status: 503, json: { message: 'Temporary outage' } }));
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('Your questions have not been deleted.');
  await expect(page.getByRole('button', { name: 'Retry AI history' })).toBeVisible();
  await page.unroute('**/api/ai-chat/history*');
  await page.route('**/api/ai-chat/history*', (route) => route.fulfill({ json: [] }));
  await page.getByRole('button', { name: 'Retry AI history' }).click();
  await expect(page.getByText('Ask your workspace anything', { exact: true })).toBeVisible();
  await page.unroute('**/api/ai-chat/history*');
  await page.goto(`${base}/app/intelligence`);
  await page.route('**/api/inbox/brief', (route) => route.fulfill({ status: 503, json: { message: 'Temporary outage' } }));
  await page.route('**/api/plan/my-work', (route) => route.fulfill({ status: 503, json: { message: 'Temporary outage' } }));
  await page.route('**/api/ai-proposals/risk', (route) => route.fulfill({ status: 503, json: { message: 'Temporary outage' } }));
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Daily brief unavailable' })).toBeVisible();
  await expect(page.getByRole('link', { name: /Open work/ })).toContainText('Unavailable');
  await expect(page.getByRole('link', { name: /Elevated risk/ })).toContainText('Unavailable');
  for (const label of ['Retry daily brief', 'Retry work summary', 'Retry risk summary']) {
    await expect(page.getByRole('button', { name: label })).toBeVisible();
  }
  await page.unroute('**/api/inbox/brief');
  await page.unroute('**/api/plan/my-work');
  await page.unroute('**/api/ai-proposals/risk');
  await page.route('**/api/settings/ai', (route) => route.fulfill({ status: 503, json: { message: 'Temporary outage' } }));
  await page.route('**/api/settings/ai/providers', (route) => route.fulfill({ status: 503, json: { message: 'Temporary outage' } }));
  await page.reload();
  await expect(page.getByText('Configuration unavailable', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Retry AI settings' }).click();
  await expect(page.getByText('Configuration unavailable', { exact: true })).toBeVisible();
  await page.unroute('**/api/settings/ai');
  await page.unroute('**/api/settings/ai/providers');
  await page.unroute('**/api/ai-chat/history*');
  console.log('PASS: Ask AI history initial failure and retry-to-empty; Intelligence unavailable metric and settings retry states.');
  await page.goto(`${base}/app/studio`);
  await page.getByRole('button', { name: 'New flow', exact: true }).first().click();
  await page.getByLabel('Requested outcome').fill('Notify someone after reviewing urgent work');
  let flowWrites = 0;
  page.on('request', (request) => {
    if (request.url().includes('/api/flows') && request.method() !== 'GET') flowWrites += 1;
  });
  let finishDraft;
  const draftReady = new Promise((resolve) => { finishDraft = resolve; });
  await page.route('**/api/ai-chat/ask', async (route) => {
    expect(route.request().postDataJSON().prompt).toContain('Notify someone after reviewing urgent work');
    await draftReady;
    await route.fulfill({ json: { answer: JSON.stringify({ name: 'Outdated draft', description: 'Original outcome.', steps: [{ kind: 'ACTION', action: 'notify' }] }), error: null } });
  });
  await page.getByRole('button', { name: 'Draft with AI', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Drafting...', exact: true })).toBeDisabled();
  await page.getByLabel('Requested outcome').fill('Review urgent work before notifying someone');
  finishDraft();
  await expect(page.getByText('The requested outcome changed. Generate a new draft for this outcome.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Use draft', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('');
  await page.unroute('**/api/ai-chat/ask');
  await page.route('**/api/ai-chat/ask', (route) => {
    expect(route.request().postDataJSON().readOnly).toBe(true);
    return route.fulfill({ json: { answer: JSON.stringify({ name: 'Review urgent work', description: 'Review then notify.', steps: [{ kind: 'ACTION', action: 'notify' }] }), error: null } });
  });
  await page.getByRole('button', { name: 'Draft with AI', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Use draft', exact: true })).toBeEnabled();
  await page.getByLabel('Requested outcome').fill('Another outcome');
  await expect(page.getByRole('button', { name: 'Use draft', exact: true })).toHaveCount(0);
  await page.getByLabel('Requested outcome').fill('Review urgent work before notifying someone');
  await expect(page.getByRole('button', { name: 'Use draft', exact: true })).toBeEnabled();
  await page.getByLabel('Name', { exact: true }).fill('Keep my manual edits');
  await expect(page.getByRole('button', { name: 'Use draft', exact: true })).toBeDisabled();
  await page.getByLabel('Name', { exact: true }).fill('');
  await page.getByRole('button', { name: 'Use draft', exact: true }).click();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Review urgent work');
  expect(flowWrites).toBe(0);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => document.documentElement.classList.toggle('dark', value === 'dark'), theme);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `${out}/flow-draft-${width}-${theme}.png`, animations: 'disabled' });
    }
  }
  // Change only the browser's identity fixture, never the stored account or its permissions.
  await page.route('**/api/agents', (route) => route.fulfill({ status: 503, json: { message: 'Temporary outage' } }));
  await page.goto(`${base}/app/agents`);
  await expect(page.getByText('Agent roster unavailable', { exact: true })).toBeVisible();
  await expect(page.getByText('No teammates yet', { exact: true })).toHaveCount(0);
  await page.unroute('**/api/agents');
  await page.getByRole('button', { name: 'Retry agent roster', exact: true }).click();
  await expect(page.getByText('Agent roster unavailable', { exact: true })).toHaveCount(0);
  await page.route('**/api/agents/ledger', (route) => route.fulfill({ status: 503, json: { message: 'Temporary outage' } }));
  await page.reload();
  await expect(page.getByText('Agent ledger unavailable', { exact: true })).toBeVisible();
  await expect(page.getByText('Nothing on the ledger yet.', { exact: true })).toHaveCount(0);
  await page.unroute('**/api/agents/ledger');
  await page.getByRole('button', { name: 'Retry agent ledger', exact: true }).click();
  await expect(page.getByText('Agent ledger unavailable', { exact: true })).toHaveCount(0);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => document.documentElement.classList.toggle('dark', value === 'dark'), theme);
      await page.screenshot({ path: `${out}/agents-reviewed-${width}-${theme}.png`, animations: 'disabled' });
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${base}/app/settings`);
  const fixtureRun = {
    id: 'trace-fixture', capability: 'review_fixture', status: 'COMPLETED', goal: 'Review completed work. '.repeat(80),
    stepCount: 1, maxSteps: 5, costUsd: '0.01', maxCostUsd: '1', level: 'SUGGEST', trigger: 'manual',
    onBehalfOf: { name: 'Review fixture' }, createdAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    steps: [{ id: 'step-fixture', index: 1, kind: 'finish', toolName: null, argsJson: null, resultText: 'Recorded result. '.repeat(100), error: null }]
  };
  await page.route('**/api/agent-runs?*', (route) => route.fulfill({ json: [fixtureRun] }));
  await page.route('**/api/agent-runs/trace-fixture', (route) => route.fulfill({ status: 503, json: { message: 'Temporary outage' } }));
  await page.getByRole('tab', { name: 'AI', exact: true }).click();
  const runsSection = page.getByRole('button', { name: 'Agent runs', exact: true });
  if (await runsSection.getAttribute('aria-expanded') === 'false') await runsSection.click();
  await page.getByRole('button', { name: /review fixture completed/ }).click();
  await expect(page.getByText('Run details unavailable.', { exact: true })).toBeVisible({ timeout: 15000 });
  await page.unroute('**/api/agent-runs/trace-fixture');
  await page.route('**/api/agent-runs/trace-fixture', (route) => route.fulfill({ json: fixtureRun }));
  await page.getByRole('button', { name: 'Retry run details' }).click();
  await expect(page.getByText('Run details unavailable.', { exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 1000 });
  await expect.poll(async () => {
    const box = await page.getByRole('dialog').boundingBox();
    return box && box.height <= 902 && box.y >= 0 && box.y + box.height <= 1002;
  }).toBe(true);
  await page.screenshot({ path: `${out}/agent-trace-mobile.png`, animations: 'disabled' });
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.unroute('**/api/agent-runs?*');
  await page.unroute('**/api/agent-runs/trace-fixture');
  await page.route('**/api/agent-runs?*', (route) => route.fulfill({ json: [{ ...fixtureRun, status: 'RUNNING' }] }));
  await page.reload();
  await page.getByRole('tab', { name: 'AI', exact: true }).click();
  const reloadedRunsSection = page.getByRole('button', { name: 'Agent runs', exact: true });
  if (await reloadedRunsSection.getAttribute('aria-expanded') === 'false') await reloadedRunsSection.click();
  await expect(page.getByRole('button', { name: /review fixture running/ })).toBeVisible();
  await page.route('**/api/agent-runs?*', (route) => route.fulfill({ status: 503, json: { message: 'Temporary refresh outage' } }));
  await page.waitForTimeout(3500);
  await expect(page.getByText('Could not refresh runs. Showing the last loaded list.')).toBeVisible();
  await expect(page.getByRole('button', { name: /review fixture running/ })).toBeVisible();
  await page.unroute('**/api/agent-runs?*');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('tab', { name: 'BCC & forms', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 1000 });
  const selectedSettingsTab = page.getByRole('tab', { name: 'BCC & forms', exact: true });
  await expect.poll(async () => selectedSettingsTab.evaluate((tab) => {
    const parent = tab.closest('[role="tablist"]').getBoundingClientRect();
    const rect = tab.getBoundingClientRect();
    return rect.left >= parent.left - 2 && rect.right <= parent.right + 2;
  })).toBe(true);
  await expect(selectedSettingsTab).toHaveAttribute('aria-selected', 'true');
  await page.screenshot({ path: `${out}/settings-selected-tab-mobile.png`, animations: 'disabled' });
  await page.route('**/api/auth/me', async (route) => {
    const response = await route.fetch();
    const user = await response.json();
    await route.fulfill({ response, json: { ...user, role: 'EMPLOYEE', permissions: [] } });
  });
  let historyRequests = 0;
  await page.route('**/api/ai-chat/history*', async (route) => {
    historyRequests += 1;
    await route.continue();
  });
  await page.goto(`${base}/app/intelligence`);
  await expect(page.getByRole('heading', { name: 'Intelligence center', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Build report', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Recent AI context', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'AI readiness advisor', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Elevated risk/ })).toHaveCount(0);
  expect(historyRequests).toBe(0);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const attentionGrid = page.locator('section[aria-labelledby="attention-title"] > div');
  expect(await attentionGrid.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBe(3);
  expect(await page.locator('section[aria-labelledby="brief-title"]').evaluate((element) =>
    getComputedStyle(element.parentElement).gridTemplateColumns.split(' ').length
  )).toBe(1);
  await page.screenshot({ path: `${out}/intelligence-restricted-desktop.png`, animations: 'disabled' });
  console.log('PASS: setup milestones and progress, both themes at desktop/mobile, no horizontal overflow, copilot draft preservation, report generation/export and prompt handoff. AI response stubbed; no model call or timesheet write.');
} finally {
  await browser.close();
}
