import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { createApp } from '../server/app.js';

const dataDir = await mkdtemp(join(tmpdir(), 'commonroom-browser-'));
const service = await createApp({ dataDir, agentsEnabled: false });
let browser;
try {
  const { port } = await service.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  const executablePath = process.env.CHROMIUM_BIN || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const adminContext = await browser.newContext();
  const memberContext = await browser.newContext();
  const admin = await adminContext.newPage();
  const member = await memberContext.newPage();
  const errors = [];
  for (const page of [admin, member]) page.on('pageerror', error => errors.push(error.message));
  await admin.goto(base);
  if (process.env.BROWSER_SCREENSHOTS) {
    await admin.locator('#auth-form').waitFor();
    await admin.setViewportSize({ width: 1440, height: 900 });
    await admin.screenshot({ path: join(process.env.BROWSER_SCREENSHOTS, 'commonroom-auth.png'), fullPage: true });
  }
  await admin.locator('#auth-form [name="display_name"]').fill('Browser Admin');
  await admin.locator('#auth-form [name="username"]').fill('admin');
  await admin.locator('#auth-form [name="password"]').fill('browser test password');
  await admin.locator('#auth-form button[type="submit"]').click();
  await admin.locator('#message-input').waitFor();
  await admin.getByRole('button', { name: 'Manage workspace', exact: true }).click();
  await admin.locator('[data-tab="people"]').click();
  await admin.locator('[data-action="new-user"]').click();
  await admin.locator('#user-form [name="display_name"]').fill('Browser Member');
  await admin.locator('#user-form [name="username"]').fill('member');
  await admin.locator('#user-form [name="password"]').fill('member test password');
  await admin.locator('#user-form button[type="submit"]').click();
  await admin.locator('#user-form').waitFor({ state: 'detached' });
  if (await admin.locator('[data-action="close-modal"]').count()) await admin.locator('[data-action="close-modal"]').click();
  await admin.getByRole('button', { name: 'Create an AI agent', exact: true }).click();
  await admin.locator('#agent-form [name="display_name"]').fill('Quiet Observer');
  await admin.locator('#agent-form [name="username"]').fill('observer');
  await admin.locator('#agent-form [name="instructions"]').fill('Listen carefully. Only speak when useful. Silence is welcome.');
  await admin.locator('#agent-form [name="subscriptions"]').first().check();
  await admin.locator('#agent-form button[type="submit"]').click();
  await admin.locator('#agent-form').waitFor({ state: 'detached' });
  if (await admin.locator('[data-action="close-modal"]').count()) await admin.locator('[data-action="close-modal"]').click();
  await member.goto(base);
  await member.locator('#auth-form [name="username"]').fill('member');
  await member.locator('#auth-form [name="password"]').fill('member test password');
  await member.locator('#auth-form button[type="submit"]').click();
  await member.locator('#message-input').waitFor();
  assert.equal(await member.getByRole('button', { name: 'Manage workspace', exact: true }).count(), 0);
  await admin.locator('#message-input').fill('Hello from the admin browser');
  await admin.getByRole('button', { name: 'Send message', exact: true }).click();
  await member.getByText('Hello from the admin browser', { exact: true }).waitFor();
  await member.locator('#message-input').fill('<script>window.unsafe = true</script>');
  await member.getByRole('button', { name: 'Send message', exact: true }).click();
  await admin.getByText('<script>window.unsafe = true</script>', { exact: true }).waitFor();
  assert.equal(await admin.evaluate(() => window.unsafe), undefined);
  if (process.env.BROWSER_SCREENSHOTS) {
    await member.setViewportSize({ width: 390, height: 844 });
    await member.screenshot({ path: join(process.env.BROWSER_SCREENSHOTS, 'commonroom-mobile-chat.png'), fullPage: true });
  }
  await member.locator('.reply-button').first().click();
  await member.locator('#thread-panel textarea').fill('A threaded browser reply');
  await member.locator('#thread-panel button[type="submit"]').click();
  await member.getByText('A threaded browser reply', { exact: true }).waitFor();
  if (process.env.BROWSER_SCREENSHOTS) {
    await admin.setViewportSize({ width: 1440, height: 900 });
    await admin.screenshot({ path: join(process.env.BROWSER_SCREENSHOTS, 'commonroom-desktop.png'), fullPage: true });
    await member.setViewportSize({ width: 390, height: 844 });
    await member.screenshot({ path: join(process.env.BROWSER_SCREENSHOTS, 'commonroom-mobile.png'), fullPage: true });
  }
  assert.deepEqual(errors, []);
  console.log('Browser checks passed: admin setup, human and agent creation, separate user login, realtime chat, safe rendering and threads.');
} finally {
  await browser?.close();
  await service.close();
  await rm(dataDir, { recursive: true, force: true });
}
