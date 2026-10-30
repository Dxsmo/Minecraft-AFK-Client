import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const base = process.env.PERF_URL ?? 'http://127.0.0.1:4173';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const account = {
  id: 'bench', name: 'PerformanceBot', displayName: '', serverHost: 'localhost', serverPort: 25565,
  edition: 'JAVA', authType: 'MICROSOFT', status: 'ONLINE',
  crouchEnabled: true, autoReconnect: true, autoSellEnabled: true, autoSellIntervalSeconds: 1,
  autoSellCommand: '/sell', minecraftVersion: '', notes: '', spawnerType: '', spawnerActions: {},
  createdBy: { id: 'admin' }, assignments: [],
};
const user = { id: 'admin', username: 'Performance', role: 'ADMIN', status: 'ACTIVE' };
const report = { browser: await browser.version(), scenarios: [] };
try {
  for (const count of [2000, 20_000]) {
    const context = await browser.newContext({ viewport: { width: 1365, height: 900 } });
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
      else if (url.pathname.endsWith('/profile/dashboard')) data = { initialized: true, preferences: { accountOrder: [], blurredAccountIds: [], uploaderOrder: [], collapsedUploaderIds: [] } };
      else if (url.pathname.includes('/auth/me')) data = { user };
      else if (url.pathname.endsWith('/logs')) data = Array.from({ length: 2000 }, (_, i) => ({
        id: `older-${i}`, minecraftAccountId: 'bench', type: 'CHAT', message: `Older line ${i}`, createdAt: new Date(1700000000000 + i * 1000).toISOString(),
      }));
      else if (url.pathname.endsWith('/earnings')) data = { last5m: 1071, last1h: 1071, last24h: 1071 };
      else if (url.pathname.endsWith('/earnings/history')) {
        const range = url.searchParams.get('range') ?? '1h';
        const points = { '1h': 12, '6h': 72, '24h': 288 }[range];
        const end = Math.floor(Date.now() / 300_000) * 300_000;
        data = { range, bucketMs: 300_000, start: new Date(end - points * 300_000).toISOString(), end: new Date(end).toISOString(),
          total: points * 42, points: Array.from({ length: points }, (_, i) => ({ at: new Date(end - (points - i) * 300_000).toISOString(), amount: 42 })) };
      }
      else if (url.pathname.endsWith('/accounts/bench')) data = account;
      else if (url.pathname.endsWith('/accounts')) data = [account];
      else if (url.pathname.endsWith('/users')) data = [user];
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    });
    await page.addInitScript(({ count, account }) => {
      const historyTime = Date.now(); // Persisted rows retain their timestamps across reconnects.
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
                id: `line-${i}`, minecraftAccountId: 'bench', type: 'CHAT', message: `History line ${i}`, createdAt: new Date(historyTime - (count - i) * 1000).toISOString(),
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
    await page.locator('a[href="/accounts/bench?tab=console"]').first().click();
    await page.waitForFunction(n => +document.querySelector('.console-output')?.dataset.logCount === n, count);
    await page.waitForFunction(() => document.querySelector('.console-row'));
    const historyMs = await page.evaluate(() => performance.now() - window.__historyStart);
    if (process.env.PERF_DEBUG) console.error('history ready', count, historyMs);
    const layouts = [];
    for (const viewport of [{ width: 1365, height: 600 }, { width: 1365, height: 768 }, { width: 1365, height: 900 }, { width: 1920, height: 1080 }, { width: 390, height: 667 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      // Wait for the tab entrance and console resize before measuring its edge.
      await page.waitForTimeout(550);
      const layout = await page.evaluate(() => {
        const el = document.querySelector('.console-output');
        const style = getComputedStyle(el);
        const earnings = document.querySelector('[aria-label="Sell earnings"]');
        const bottom = earnings ?? document.querySelector('.account-command');
        return {
          consoleHeight: el.clientHeight,
          earningsHeight: earnings?.getBoundingClientRect().height ?? 0,
          visibleLines: +((el.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)) / parseFloat(style.lineHeight)).toFixed(1),
          pageOverflow: document.documentElement.scrollHeight - innerHeight,
          bottomGap: innerHeight - bottom.getBoundingClientRect().bottom - (document.querySelector('.mobile-nav')?.getBoundingClientRect().height ?? 0),
          expectedBottomGap: parseFloat(getComputedStyle(document.querySelector('main')).paddingBottom),
        };
      });
      layouts.push({ ...viewport, ...layout });
      if (process.env.PERF_VERIFY === '1' && (layout.pageOverflow > 1 || Math.abs(layout.bottomGap - layout.expectedBottomGap) > 1)) {
        throw new Error(`Account page does not fit the viewport: ${JSON.stringify(layout)}`);
      }
      if (process.env.PERF_VERIFY === '1' && layout.consoleHeight < layout.earningsHeight * 2) throw new Error('Closed graph does not leave most space to the console');
      // Compact layouts deliberately omit earnings; still check their console fit.
      if (!layout.earningsHeight) continue;
      await page.locator('[aria-label="Sell earnings"] h3').hover();
      await page.waitForTimeout(550);
      const open = await page.evaluate(() => ({
        consoleHeight: document.querySelector('.console-output').clientHeight,
        earningsHeight: document.querySelector('[aria-label="Sell earnings"]').getBoundingClientRect().height,
        graphHeight: document.querySelector('.earnings-chart-svg').getBoundingClientRect().height,
        pageOverflow: document.documentElement.scrollHeight - innerHeight,
        horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
        summaryBottomGap: document.querySelector('.earnings-summary').getBoundingClientRect().bottom
          - document.querySelector('.earnings-totals').getBoundingClientRect().bottom,
      }));
      layouts[layouts.length - 1].open = open;
      if (process.env.PERF_VERIFY === '1' && (open.pageOverflow > 1 || open.horizontalOverflow > 1
        || open.graphHeight < 40 || open.earningsHeight < open.consoleHeight * 2
        || open.summaryBottomGap < (viewport.height > 700 ? 12 : 3))) {
        throw new Error(`Open graph does not fit and dominate the viewport: ${JSON.stringify({ viewport, ...open })}`);
      }
      await page.mouse.move(0, 0);
      await page.waitForTimeout(550);
    }
    await page.setViewportSize({ width: 1365, height: 900 });
    if (process.env.PERF_SCREENSHOT) await page.screenshot({ path: process.env.PERF_SCREENSHOT });
    const live = await page.evaluate(async () => {
      const result = [];
      for (let i = 0; i < 5; i++) {
        window.__formatCalls = 0;
        const el = document.querySelector('.console-output');
        const start = performance.now();
        const done = new Promise((resolve, reject) => {
          const timeout = setTimeout(() => { observer.disconnect(); reject(new Error('Newest console line did not become visible')); }, 5000);
          const observer = new MutationObserver(() => {
            if (el.lastElementChild.textContent.includes(`Live sample ${i}`)) {
              clearTimeout(timeout); observer.disconnect(); resolve(performance.now() - start);
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
    if (process.env.PERF_DEBUG) console.error('live ready', count, live);
    // Scrolling up must stop auto-follow, including when long lines wrap.
    const readingAnchor = await page.evaluate(async () => {
      const el = document.querySelector('.console-output');
      el.scrollTop = 500;
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
      await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
      const anchor = Array.from(el.querySelectorAll('[data-log-id]')).find(row => row.getBoundingClientRect().top >= el.getBoundingClientRect().top + 10);
      return { id: anchor.dataset.logId, lastId: el.dataset.lastLogId, top: anchor.getBoundingClientRect().top - el.getBoundingClientRect().top, scrollTop: el.scrollTop };
    });
    await page.evaluate(() => window.__sockets.findLast(s => s.url.endsWith('/ws/accounts/bench')).deliver({
      type: 'console', event: { minecraftAccountId: 'bench', type: 'CHAT', message: 'Wrapped sample ' + 'long message '.repeat(100), timestamp: new Date().toISOString() },
    }));
    await page.waitForFunction(last => document.querySelector('.console-output').dataset.lastLogId !== last, readingAnchor.lastId);
    const readingAnchorDelta = await page.locator('.console-output').evaluate((el, anchor) => {
      const row = Array.from(el.querySelectorAll('[data-log-id]')).find(child => child.dataset.logId === anchor.id);
      return row.getBoundingClientRect().top - el.getBoundingClientRect().top - anchor.top;
    }, readingAnchor);
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
    const retainedCount = await page.locator('.console-output').evaluate(el => +el.dataset.logCount);
    await page.locator('.console-output').evaluate(el => { el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll')); });
    await page.waitForTimeout(100);
    await page.evaluate(() => window.__sockets.findLast(s => s.url.endsWith('/ws/accounts/bench')).deliver({
      type: 'console', event: { minecraftAccountId: 'bench', type: 'CHAT', message: 'Latest console line', timestamp: new Date().toISOString() },
    }));
    await page.waitForFunction(() => document.querySelector('.console-output').lastElementChild.textContent.includes('Latest console line'));
    const finalCount = await page.locator('.console-output').evaluate(el => +el.dataset.logCount);
    const renderedRows = await page.locator('.console-row').count();
    report.scenarios.push({ count, layouts, finalCount, historyMs: +historyMs.toFixed(1), live, httpCommands,
      draftAfterSend, draftAfterFailure, readingAnchorDelta, renderedRows, errors });
    if (process.env.PERF_VERIFY === '1') {
      if (await page.getByRole('button', { name: /Konsole (aus|ein)klappen/ }).count()) throw new Error('Removed console toggle is still visible');
      if (await page.getByRole('button', { name: 'Ältere Logs laden' }).count()) throw new Error('Removed history button is still visible');
      if (finalCount !== Math.min(20_000, retainedCount + 1)) throw new Error('Console lost buffered history');
      if (renderedRows > 200) throw new Error('Console rendered too many offscreen rows');
      if (JSON.stringify(httpCommands) !== JSON.stringify(['/tpahere Steve', '/home'])) throw new Error('Manual commands were dropped');
      if (draftAfterFailure !== '/homes') throw new Error('Failed command draft was lost');
      if (Math.abs(readingAnchorDelta) > 1) throw new Error('Console reading position jumped');
      if (!(await page.getByRole('alert').textContent()).includes('OFFLINE')) throw new Error('Failed command error is invisible');
      if (errors.length) throw new Error(errors.join('; '));
      if (!(await page.locator('.version-text').textContent())?.match(/^V\d+\.\d+\.\d+$/)) throw new Error('Website version is missing');
    }
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(item => [item.name, item.value]));
    await page.waitForTimeout(200);
    const idleStart = await metrics();
    await page.waitForTimeout(2000);
    const idleEnd = await metrics();
    report.scenarios.at(-1).idle = {
      seconds: idleEnd.Timestamp - idleStart.Timestamp,
      taskCpuPercentOneCore: 100 * (idleEnd.TaskDuration - idleStart.TaskDuration) / (idleEnd.Timestamp - idleStart.Timestamp),
      layouts: idleEnd.LayoutCount - idleStart.LayoutCount,
      styleRecalculations: idleEnd.RecalcStyleCount - idleStart.RecalcStyleCount,
      jsHeapUsedMiB: idleEnd.JSHeapUsedSize / 1024 / 1024,
    };
    await cdp.detach();
    const beforeHidden = await page.locator('.console-output').getAttribute('data-last-log-id');
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange'));
      const socket=window.__sockets.findLast(s=>s.url.endsWith('/ws/accounts/bench'));
      for(let i=0;i<1000;i++)socket.deliver({type:'console',event:{minecraftAccountId:'bench',type:'CHAT',message:`Hidden burst ${i}`,timestamp:new Date().toISOString()}});
    });
    await page.waitForTimeout(150);
    if(await page.locator('.console-output').getAttribute('data-last-log-id')!==beforeHidden)throw new Error('Hidden console kept rendering');
    await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));});
    await page.getByText('Hidden burst 999',{exact:true}).waitFor();
    const burstCount=await page.locator('.console-output').evaluate(el=>+el.dataset.logCount);
    if(burstCount!==Math.min(20000,finalCount+1000))throw new Error(`Hidden console lost buffered lines: actual=${burstCount}, expected=${Math.min(20000,finalCount+1000)}, final=${finalCount}`);
    await page.getByRole('button',{name:'Einstellungen',exact:true}).click();
    await page.evaluate(()=>{const socket=window.__sockets.findLast(s=>s.url.endsWith('/ws/accounts/bench'));for(let i=0;i<1000;i++)socket.deliver({type:'console',event:{minecraftAccountId:'bench',type:'CHAT',message:`Settings burst ${i}`,timestamp:new Date().toISOString()}});});
    await page.getByRole('button',{name:'Console',exact:true}).click();
    await page.getByText('Settings burst 999',{exact:true}).waitFor();
    if(await page.locator('.console-output').evaluate(el=>+el.dataset.logCount)!==Math.min(20000,burstCount+1000))throw new Error('Settings console lost buffered lines');
    report.scenarios.at(-1).bursts={hidden:1000,settings:1000,hiddenDoesNotRender:true,bufferRetained:true};
    await context.close();
  }
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
