import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const base = process.env.PERF_URL ?? 'http://127.0.0.1:4173';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const account = {
  id: 'bench', name: 'PerformanceBot', displayName: '', serverHost: 'localhost', serverPort: 25565,
  edition: 'JAVA', authType: 'MICROSOFT', status: 'ONLINE', health: 20, food: 20,
  crouchEnabled: true, autoReconnect: true, autoSellEnabled: true, autoSellIntervalSeconds: 1,
  autoSellCommand: '/sell', minecraftVersion: '', notes: '', spawnerType: '', spawnerActions: {},
  spawnerClearEnabled: false, spawnerClearTimes: [], createdBy: { id: 'admin' }, assignments: [],
};
const user = { id: 'admin', username: 'Performance', role: 'ADMIN', status: 'ACTIVE' };
const report = { browser: await browser.version(), scenarios: [] };
try {
  for (const count of [2000, 20_000]) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    let failCommand = false;
    const httpCommands = [];
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url());
      let data = {};
      let status = 200;
      if (url.pathname.endsWith('/command')) {
        if (failCommand) { status = 409; data = { error: 'OFFLINE' }; }
        else { httpCommands.push(route.request().postDataJSON().command); data = { ok: true }; }
      } else if (url.pathname.includes('/auth/login')) data = user;
      else if (url.pathname.includes('/auth/me')) data = { user };
      else if (url.pathname.endsWith('/logs')) data = Array.from({ length: 2000 }, (_, i) => ({
        id: `older-${i}`, minecraftAccountId: 'bench', type: 'CHAT', message: `Older line ${i}`, createdAt: new Date(1700000000000 + i * 1000).toISOString(),
      }));
      else if (url.pathname.endsWith('/earnings')) data = { last5m: 1071, last1h: 1071, last24h: 1071 };
      else if (url.pathname.endsWith('/accounts/bench')) data = account;
      else if (url.pathname.endsWith('/accounts')) data = [account];
      else if (url.pathname.endsWith('/users')) data = [user];
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    });
    await page.addInitScript(({ count, account }) => {
      window.__sockets = [];
      window.__formatCalls = 0;
      const format = Date.prototype.toLocaleTimeString;
      Date.prototype.toLocaleTimeString = function (...args) { window.__formatCalls++; return format.apply(this, args); };
      window.__wireCommands = [];
      class FakeSocket {
        static OPEN = 1;
        readyState = 1;
        constructor(url) {
          this.url = url;
          window.__sockets.push(this);
          setTimeout(() => {
            this.onopen?.({});
            if (url.endsWith('/ws/dashboard')) this.deliver({ type: 'statuses', statuses: [account] });
            if (url.endsWith('/ws/accounts/bench')) {
              window.__historyStart = performance.now();
              this.deliver({ type: 'history', logs: Array.from({ length: count }, (_, i) => ({
                id: `line-${i}`, minecraftAccountId: 'bench', type: 'CHAT', message: `History line ${i}`, createdAt: new Date(Date.now() - (count - i) * 1000).toISOString(),
              })) });
              this.deliver({ type: 'status', status: account });
            }
          }, 10);
        }
        deliver(data) { this.onmessage?.({ data: JSON.stringify(data) }); }
        send(data) { window.__wireCommands.push(JSON.parse(data)); }
        close() { this.readyState = 3; this.onclose?.({}); }
      }
      window.WebSocket = FakeSocket;
    }, { count, account });
    await page.goto(base);
    await page.locator('input').nth(0).fill('Performance');
    await page.locator('input[type="password"]').fill('test');
    await page.locator('button[type="submit"]').click();
    await page.locator('a[href="/accounts/bench"]').first().click();
    await page.waitForFunction(n => document.querySelectorAll('.console-output > div').length === n, count);
    const historyMs = await page.evaluate(() => performance.now() - window.__historyStart);
    const live = await page.evaluate(async () => {
      const result = [];
      for (let i = 0; i < 5; i++) {
        window.__formatCalls = 0;
        const el = document.querySelector('.console-output');
        const start = performance.now();
        const done = new Promise(resolve => {
          const observer = new MutationObserver(() => {
            if (el.lastElementChild.textContent.includes(`Live sample ${i}`)) {
              observer.disconnect(); resolve(performance.now() - start);
            }
          });
          observer.observe(el, { childList: true, subtree: true, characterData: true });
        });
        window.__sockets.findLast(s => s.url.endsWith('/ws/accounts/bench')).deliver({
          type: 'console', event: { minecraftAccountId: 'bench', type: 'CHAT', message: `Live sample ${i}`, timestamp: new Date().toISOString() },
        });
        result.push({ commitMs: await done, repeatedDateFormats: window.__formatCalls });
      }
      return result;
    });
    // Scrolling up must stop auto-follow, including when long lines wrap.
    const readingAnchor = await page.evaluate(() => {
      const el = document.querySelector('.console-output');
      el.scrollTop = 500;
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
      const anchor = el.children[30];
      return { text: anchor.textContent, top: anchor.getBoundingClientRect().top - el.getBoundingClientRect().top, scrollTop: el.scrollTop };
    });
    await page.evaluate(() => window.__sockets.findLast(s => s.url.endsWith('/ws/accounts/bench')).deliver({
      type: 'console', event: { minecraftAccountId: 'bench', type: 'CHAT', message: 'Wrapped sample ' + 'long message '.repeat(100), timestamp: new Date().toISOString() },
    }));
    await page.waitForFunction(() => document.querySelector('.console-output').lastElementChild.textContent.includes('Wrapped sample'));
    const readingAnchorDelta = await page.locator('.console-output').evaluate((el, anchor) => {
      const row = Array.from(el.children).find(child => child.textContent === anchor.text);
      return row.getBoundingClientRect().top - el.getBoundingClientRect().top - anchor.top;
    }, readingAnchor);
    let historyAnchorDelta = null;
    if (count === 2000) {
      const anchorBefore = await page.locator('.console-output > div').first().evaluate(el => el.getBoundingClientRect().top - el.parentElement.getBoundingClientRect().top);
      await page.getByRole('button', { name: 'Ältere Logs laden' }).click();
      await page.waitForFunction(() => document.querySelectorAll('.console-output > div').length === 4006);
      const anchorAfter = await page.locator('.console-output > div').filter({ hasText: 'History line 0' }).evaluate(el => el.getBoundingClientRect().top - el.parentElement.getBoundingClientRect().top);
      historyAnchorDelta = anchorAfter - anchorBefore;
    }
    const input = page.locator('input[placeholder="/gamemode creative"]');
    await page.evaluate(() => window.__sockets.findLast(s => s.url.endsWith('/ws/accounts/bench')).close());
    await input.fill('/tpahere Steve');
    await input.press('Enter');
    await page.waitForTimeout(150);
    const draftAfterSend = await input.inputValue();
    await input.fill('/home');
    await input.press('Enter');
    await page.waitForTimeout(150);
    failCommand = true;
    await input.fill('/homes');
    await input.press('Enter');
    await page.waitForTimeout(150);
    const draftAfterFailure = await input.inputValue();
    report.scenarios.push({ count, historyMs: +historyMs.toFixed(1), live, httpCommands,
      draftAfterSend, draftAfterFailure, readingAnchorDelta, historyAnchorDelta, errors });
    if (process.env.PERF_VERIFY === '1') {
      if (JSON.stringify(httpCommands) !== JSON.stringify(['/tpahere Steve', '/home'])) throw new Error('Manual commands were dropped');
      if (draftAfterFailure !== '/homes') throw new Error('Failed command draft was lost');
      if (Math.abs(readingAnchorDelta) > 1) throw new Error('Console reading position jumped');
      if (historyAnchorDelta !== null && Math.abs(historyAnchorDelta) > 1) throw new Error('Older history changed the reading position');
      if (!(await page.getByRole('alert').textContent()).includes('OFFLINE')) throw new Error('Failed command error is invisible');
      if (errors.length) throw new Error(errors.join('; '));
      if (await page.locator('.version-text').textContent() !== 'V1.6.1') throw new Error('Wrong website version');
    }
    await context.close();
  }
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
