// Browser integration against the disposable AuditFixture stack; no real accounts.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.AUDIT_URL || 'http://localhost:8082';
const origin = new URL(base);
assert.ok(['localhost', '127.0.0.1'].includes(origin.hostname) && origin.port === '8082');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [], checks = [], layouts = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  const login = async () => {
    await page.locator('#login-username').fill('AuditAdmin');
    await page.locator('#login-password').fill('Audit-fixture-only-2026!');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL('**/dashboard');
    await page.locator('.account-card').nth(99).waitFor();
  };
  const navigate = path => page.evaluate(path => {
    history.pushState(null, '', path); dispatchEvent(new PopStateEvent('popstate'));
  }, path);
  const readAccount = () => page.evaluate(async () => (await fetch('/api/minecraft/accounts/audit-000')).json());
  await login();
  assert.equal(await page.locator('.account-card').count(), 100);
  assert.ok((await readAccount()).name.startsWith('AuditFixture'));
  await page.locator('a[href="/accounts/audit-000?tab=console"]').first().click();
  await page.waitForFunction(() => +document.querySelector('.console-output')?.dataset.logCount >= 2000);
  assert.ok(await page.locator('.console-row').count() < 100);
  await page.getByRole('button', { name: 'Einstellungen', exact: true }).click();
  for (const category of ['General', 'Connection', 'Behavior', 'Auto-sell', 'Auto button', 'Spawner', 'Access']) {
    await page.getByRole('button', { name: new RegExp('^' + category) }).click();
    await page.getByRole('button', { name: 'Save settings', exact: true }).waitFor();
  }
  await page.getByRole('button', { name: /^Auto button/ }).click();
  await page.getByRole('radio', { name: 'Rechter Mausklick', exact: true }).check({ force: true });
  const saved = page.waitForResponse(response => response.url().endsWith('/accounts/audit-000') && response.request().method() === 'PATCH');
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  assert.equal((await saved).status(), 200);
  assert.equal((await readAccount()).autoButton, 'RIGHT');
  checks.push('real login, 100 dashboard accounts, virtual console and all account settings categories');
  checks.push('held button saved through real API');
  await page.getByRole('button', { name: 'Live Cam', exact: true }).click();
  await page.getByText('Der Account ist offline. Die Live Cam startet, sobald er verbunden ist.').waitFor();
  checks.push('offline Live Cam does not open a render stream');
  await navigate('/dashboard'); await page.locator('.account-card').nth(99).waitFor();
  await page.getByRole('button', { name: 'Account-Bild auswählen', exact: true }).first().click();
  await page.getByRole('searchbox', { name: 'Items suchen' }).fill('diamond_sword');
  await page.getByRole('button', { name: 'diamond sword', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.ok((await readAccount()).imageUrl);
  checks.push('real item catalog, normalized search and image persistence');
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(150);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    assert.ok(overflow <= 1, `Dashboard overflow at ${width}: ${overflow}`);
    layouts.push({ width, overflow });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await navigate('/settings');
  const passwords = page.locator('input[type="password"]');
  await passwords.nth(0).fill('incorrect-current-password');
  await passwords.nth(1).fill('Do-not-save-this-fixture-password');
  await passwords.nth(2).fill('Do-not-save-this-fixture-password');
  await page.getByRole('button', { name: 'Update password', exact: true }).click();
  await page.getByText('Current password is incorrect', { exact: true }).waitFor();
  assert.ok(page.url().endsWith('/settings'));
  checks.push('incorrect current password shows an error without expiring the session');
  await navigate('/dashboard'); await page.locator('.account-card').nth(99).waitFor();
  const failLogout = route => route.fulfill({ status: 503, json: { error: 'Isolated test outage' } });
  await page.route('**/api/auth/logout', failLogout);
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Abmelden ist gerade nicht möglich' }).waitFor();
  assert.ok(await page.getByRole('button', { name: 'Log out', exact: true }).isEnabled());
  await page.unroute('**/api/auth/logout', failLogout);
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await page.locator('#login-username').waitFor();
  checks.push('failed logout is visible and retry succeeds');
  await login();
  // Destroy only this synthetic browser session server-side, leaving React unaware.
  await page.evaluate(async () => {
    const token = document.cookie.split('; ').find(row => row.startsWith('afk_csrf=')).split('=').slice(1).join('=');
    const result = await fetch('/api/auth/logout', { method: 'POST', headers: { 'x-csrf-token': decodeURIComponent(token) } });
    if (!result.ok) throw new Error('Synthetic session cleanup failed');
  });
  await navigate('/accounts/audit-000?tab=console');
  await page.locator('#login-username').waitFor();
  checks.push('expired real session returns to login without an endless reconnect loop');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, layouts, pageErrors: errors }, null, 2));
} finally { await browser.close(); }
