// Real profile API + disposable SQLite database; never touches Minecraft accounts.
// Build both packages, start Vite preview, then run with PLAYWRIGHT_MODULE if needed.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const base = process.env.UI_URL ?? 'http://127.0.0.1:4173';
const directory = await mkdtemp(join(tmpdir(), 'afk-updates-ui-'));
const screenshots = process.env.SCREENSHOT_DIR ?? join(tmpdir(), 'afk-updates-screenshots');
await mkdir(screenshots, { recursive: true });
Object.assign(process.env, {
  DATABASE_URL: `file:${join(directory, 'fixture.db')}`,
  NODE_ENV: 'test', SESSION_SECRET: 'website-updates-disposable-test-secret',
  SESSION_COOKIE_SECURE: 'false', SESSION_COOKIE_NAME: 'afk_updates_ui_session',
  PUBLIC_ORIGIN: base, CORS_ORIGINS: base, INITIAL_ADMIN_PASSWORD: '',
  LOGIN_RATE_LIMIT_MAX: '100', LOG_LEVEL: 'silent',
});
const backendRequire = createRequire(new URL('../../backend/package.json', import.meta.url));
execFileSync(process.execPath, [backendRequire.resolve('prisma/build/index.js'), 'migrate', 'deploy'], {
  cwd: fileURLToPath(new URL('../../backend/', import.meta.url)), env: process.env, stdio: 'pipe',
});
const { buildApp } = await import('../../backend/dist/app.js');
const { prisma } = await import('../../backend/dist/database/prisma.js');
const { hashPassword } = await import('../../backend/dist/auth/password.js');
const password = 'Updates-fixture-only-2026!';
const passwordHash = await hashPassword(password);
for (const username of ['UpdatesAlice', 'UpdatesBob', 'Updates320', 'Updates390', 'Updates768', 'UpdatesLoading', 'UpdatesStale']) {
  await prisma.user.create({ data: { username, passwordHash } });
}
const app = await buildApp();
await app.listen({ host: '127.0.0.1', port: 0 });
const apiBase = `http://127.0.0.1:${app.server.address().port}`;
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : { channel: 'chrome' }) });
const errors = [], failures = [], results = [];
const unread = '.updates-bell-unread:visible';

async function pageFor({ width = 1280, height = 1000, reducedMotion = 'no-preference' } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion });
  const page = await context.newPage();
  const requests = [];
  const control = { failRead: false, failStatus: false, delayStatus: false, staleStatus: false, requests };
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { window.WebSocket = class { static OPEN=1; readyState=1; constructor(){setTimeout(()=>this.onopen?.({}),0);} close(){} }; });
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url());
    requests.push({ path: url.pathname, method: request.method() });
    if ((control.failRead && url.pathname.endsWith('/updates/read')) || (control.failStatus && url.pathname.endsWith('/profile/updates'))) {
      return route.fulfill({ status: 503, json: { error: 'Synthetic outage' } });
    }
    if (control.delayStatus && url.pathname.endsWith('/profile/updates')) await new Promise(resolve => setTimeout(resolve, 400));
    try {
      const response = await route.fetch({ url: `${apiBase}${url.pathname}${url.search}` });
      if (response.status() >= 500) failures.push({ path: url.pathname, status: response.status() });
      if (control.staleStatus && url.pathname.endsWith('/profile/updates')) {
        const json = await response.json(); json.announcement.id = 'previous-explicit-announcement';
        return route.fulfill({ response, json });
      }
      await route.fulfill({ response });
    } catch (error) { if (!page.isClosed()) errors.push(error.message); }
  });
  await page.goto(base);
  return { page, context, control };
}

async function login(page, username) {
  await page.locator('input[name="username"]').fill(username);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole('button', { name: /sign in|log in|anmelden/i }).click();
  await page.locator('.updates-bell:visible').waitFor();
}
async function waitForRead(username) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await prisma.user.findUniqueOrThrow({ where: { username } })).lastSeenWebsiteUpdate) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('Read marker was not persisted');
}
async function openAndInspect(page, label) {
  await page.locator('.updates-bell:visible').click();
  const dialog = page.getByRole('dialog'); await dialog.waitFor();
  await dialog.locator('.updates-feature').last().waitFor();
  assert.equal(await dialog.locator('.updates-feature').count(), 5);
  await page.waitForFunction(() => [...document.querySelectorAll('.updates-feature img')].every(image => image.complete && image.naturalWidth > 0));
  const bounds = await dialog.boundingBox(), viewport = page.viewportSize();
  assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width && bounds.y + bounds.height <= viewport.height);
  assert.ok(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  // The final feature and close action remain reachable with a short viewport.
  await dialog.getByText('Kleine Änderungen, besserer Alltag').scrollIntoViewIfNeeded();
  await dialog.locator('.updates-content').evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: join(screenshots, `${label}.png`) });
  return dialog;
}

try {
  const desktop = await pageFor();
  await login(desktop.page, 'UpdatesAlice');
  await desktop.page.locator(unread).waitFor();
  assert.equal(await desktop.page.locator('.updates-bell:visible svg').evaluate(element => getComputedStyle(element).animationName), 'updates-bell-ring');
  assert.equal(desktop.control.requests.filter(request => request.path.endsWith('/updates/read')).length, 0);
  assert.equal(desktop.control.requests.filter(request => request.path.includes('/assets/account-items/')).length, 0);
  assert.equal(await desktop.page.getByRole('dialog').count(), 0);
  await desktop.page.screenshot({ path: join(screenshots, 'desktop-unread.png') });
  const dialog = await openAndInspect(desktop.page, 'desktop-menu');
  await waitForRead('UpdatesAlice');
  await desktop.page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
  assert.equal(await desktop.page.locator(unread).count(), 0);
  assert.equal(await desktop.page.locator('.updates-bell:visible svg').evaluate(element => getComputedStyle(element).animationName), 'none');
  assert.ok(await desktop.page.locator('.updates-bell:visible').evaluate(element => element === document.activeElement));
  await desktop.page.locator('.updates-bell:visible').click();
  await desktop.page.getByRole('button', { name: 'Alles klar' }).click();
  assert.equal(desktop.control.requests.filter(request => request.path.endsWith('/updates/read')).length, 1);
  // A separate browser/device restores the server marker after signing in.
  const secondDevice = await pageFor();
  const secondStatus = secondDevice.page.waitForResponse(response => response.url().endsWith('/profile/updates'));
  await login(secondDevice.page, 'UpdatesAlice');
  await secondStatus;
  assert.equal(await secondDevice.page.locator(unread).count(), 0);
  await secondDevice.context.close();
  await desktop.page.getByRole('button', { name: 'Log out', exact: true }).click();
  await desktop.page.locator('input[name="username"]').waitFor();
  await login(desktop.page, 'UpdatesBob'); await desktop.page.locator(unread).waitFor();
  await desktop.context.close();
  results.push('Desktop: unread, lazy images, focus return, reopen, cross-device persistence, shared-browser user switch');

  const bob = await pageFor({ reducedMotion: 'reduce' });
  await login(bob.page, 'UpdatesBob'); await bob.page.locator(unread).waitFor();
  assert.equal(await bob.page.locator('.updates-bell:visible svg').evaluate(element => getComputedStyle(element).animationName), 'none');
  bob.control.failRead = true;
  await openAndInspect(bob.page, 'reduced-motion-menu');
  await bob.page.getByRole('alert').waitFor();
  assert.equal(await bob.page.locator(unread).count(), 0);
  bob.control.failRead = false;
  await bob.page.getByRole('button', { name: 'Erneut versuchen' }).click();
  await waitForRead('UpdatesBob');
  await bob.page.getByRole('alert').waitFor({ state: 'hidden' });
  await bob.page.getByRole('button', { name: 'Updates schließen' }).click();
  await bob.context.close();
  results.push('Independent user, reduced motion, read failure and retry');

  for (const width of [320, 390, 768]) {
    const mobile = await pageFor({ width, height: 720 });
    await login(mobile.page, `Updates${width}`); await mobile.page.locator(unread).waitFor();
    assert.equal(await mobile.page.locator('.updates-bell:visible').count(), 1);
    const bounds = await mobile.page.locator('.updates-bell:visible').boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width);
    await openAndInspect(mobile.page, `mobile-${width}`);
    await waitForRead(`Updates${width}`);
    await mobile.page.mouse.click(2, 2);
    await mobile.page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal(await mobile.page.locator(unread).count(), 0);
    await mobile.context.close();
  }
  results.push('320/390/768px: no overflow, scrollable content, backdrop closing');

  const loading = await pageFor(); loading.control.failStatus = true;
  await login(loading.page, 'UpdatesLoading');
  await loading.page.locator('.updates-bell:visible').click();
  await loading.page.getByRole('alert').waitFor();
  assert.equal(await loading.page.locator('.updates-feature').count(), 0);
  loading.control.failStatus = false; loading.control.delayStatus = true;
  await loading.page.getByRole('button', { name: 'Erneut versuchen' }).click();
  await loading.page.locator('.updates-feature').last().waitFor();
  await waitForRead('UpdatesLoading');
  await loading.context.close();
  results.push('Status load failure recovers inside the open dialog');

  const stale = await pageFor(); stale.control.staleStatus = true;
  await login(stale.page, 'UpdatesStale'); await stale.page.locator(unread).waitFor();
  await stale.page.locator('.updates-bell:visible').click();
  await stale.page.getByText('Die Ankündigung wurde aktualisiert. Bitte erneut laden.').waitFor();
  stale.control.staleStatus = false;
  await stale.page.getByRole('button', { name: 'Erneut versuchen' }).click();
  await stale.page.locator('.updates-feature').last().waitFor();
  await waitForRead('UpdatesStale');
  await stale.context.close();
  results.push('Stale announcement IDs reload before acknowledging the current update');
  assert.deepEqual(errors, []); assert.deepEqual(failures, []);
  console.log(JSON.stringify({ results, errors, failures, screenshots }, null, 2));
} finally {
  await browser.close(); await app.close(); await prisma.$disconnect();
  await rm(directory, { recursive: true, force: true });
}
