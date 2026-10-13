import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const base = process.env.PERF_URL ?? 'http://127.0.0.1:4175';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const results = [];
try {
  for (const hanging of [false, true]) {
    const context = await browser.newContext();
    await context.addCookies([{ name: 'afk_csrf', value: 'old-session', url: base }]);
    const page = await context.newPage();
    const errors = [];
    let logoutFinished = false;
    let loginStarted = false;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/logout')) {
        if (hanging) return; // No response: the browser must abort the old request.
        await new Promise(resolve => setTimeout(resolve, 1500));
        logoutFinished = true;
        await route.fulfill({ contentType: 'application/json', body: '{}' });
      } else if (path.endsWith('/login')) {
        loginStarted = true;
        if (!hanging && !logoutFinished) errors.push('Login raced the old logout');
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ id: 'admin', username: 'Performance', role: 'ADMIN' }) });
      } else {
        const data = path.endsWith('/profile/dashboard') ? { initialized: true, preferences: { accountOrder: [], blurredAccountIds: [], uploaderOrder: [], collapsedUploaderIds: [] } }
          : path.endsWith('/users') ? [{ id: 'admin', username: 'Performance', role: 'ADMIN' }]
          : path.endsWith('/accounts') ? [] : {};
        await route.fulfill({ json: data });
      }
    });
    await page.addInitScript(() => {
      window.WebSocket = class {
        static OPEN = 1;
        readyState = 1;
        constructor() { setTimeout(() => this.onopen?.({}), 0); }
        close() { this.readyState = 3; }
      };
    });
    const start = Date.now();
    await page.goto(base);
    await page.locator('#login-username').waitFor();
    const loginFormMs = Date.now() - start;
    if (logoutFinished) throw new Error('Login form waited for server cleanup');
    await page.locator('#login-username').fill('Performance');
    await page.locator('#login-password').fill('test');
    const submitStart = Date.now();
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByText('Keine Accounts hochgeladen.', { exact: true }).waitFor({ timeout: 6000 });
    if (!loginStarted || errors.length) throw new Error(errors.join('; ') || 'No login request');
    results.push({ hangingLogout: hanging, loginFormMs, loginToDashboardMs: Date.now() - submitStart, errors });
    await context.close();
  }
  console.log(JSON.stringify(results, null, 2));
} finally { await browser.close(); }
