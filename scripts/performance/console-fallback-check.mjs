import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const base = process.env.PERF_URL ?? 'http://127.0.0.1:4175';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const account = { id: 'fallback', name: 'FallbackBot', serverHost: 'localhost', serverPort: 25565,
  status: 'ONLINE', edition: 'JAVA', createdBy: null, assignments: [] };
const user = { id: 'admin', username: 'Performance', role: 'ADMIN' };
const timestamp = new Date().toISOString();
const history = ['HTTP history', 'Already persisted live line'].map((message, i) => ({
  id: `history-${i}`, minecraftAccountId: account.id, type: 'CHAT', message, createdAt: timestamp,
}));
const page = await browser.newPage();
const errors = [];
let historyRequests = 0;
page.on('pageerror', error => errors.push(error.message));
try {
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    let data = {};
    if (path.endsWith('/login')) data = user;
    else if (path.endsWith('/users')) data = [user];
    else if (path.endsWith('/accounts')) data = [account];
    else if (path.endsWith('/accounts/fallback')) data = account;
    else if (path.endsWith('/logs')) { historyRequests++; data = history; }
    else if (path.endsWith('/earnings')) data = { last5m: 0, last1h: 0, last24h: 0 };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
  });
  await page.addInitScript(({ timestamp, account }) => {
    window.WebSocket = class {
      static OPEN = 1;
      readyState = 1;
      constructor(url) {
        setTimeout(() => {
          this.onopen?.({});
          if (!url.endsWith('/ws/accounts/fallback')) return;
          // The connection never supplies history, but live messages arrive.
          this.onmessage?.({ data: JSON.stringify({ type: 'status', status: account }) });
          for (const message of ['Already persisted live line', 'New live line']) this.onmessage?.({
            data: JSON.stringify({ type: 'console', event: { minecraftAccountId: account.id, type: 'CHAT', message, timestamp } }),
          });
        }, 100);
      }
      close() { this.readyState = 3; }
    };
  }, { timestamp, account });
  await page.goto(base);
  await page.locator('#login-username').fill('Performance');
  await page.locator('#login-password').fill('test');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.locator('a[href="/accounts/fallback?tab=console"]').click();
  await page.locator('.console-output').getByText('HTTP history', { exact: true }).waitFor({ timeout: 5000 });
  const lines = await page.locator('.console-output > div').count();
  if (lines !== 3 || historyRequests !== 1 || errors.length) throw new Error(JSON.stringify({ lines, historyRequests, errors }));
  console.log(JSON.stringify({ blockedSocketHistory: true, historyRequests, retainedLines: lines, errors }, null, 2));
} finally { await browser.close(); }
