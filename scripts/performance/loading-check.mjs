import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const base = process.env.PERF_URL ?? 'http://127.0.0.1:4175';
const verify = process.env.PERF_VERIFY === '1';
const ensure = (condition, message) => { if (!condition) throw new Error(message); };
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1365, height: 900 } });
const page = await context.newPage();
const requests = new Map();
const errors = [];
const user = { id: 'admin', username: 'Performance', role: 'ADMIN', status: 'ACTIVE' };
const note = { id: 'note', title: 'Performance note', owner: user, ownerId: user.id,
  content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Lazy editor check' }] }] },
  revision: 0, canWrite: true, isOwner: true, shared: false, grants: [],
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
const scripts = [];
page.on('request', request => { if (new URL(request.url()).pathname.endsWith('.js')) scripts.push(request.url()); });
const accounts = Array.from({ length: 100 }, (_, i) => ({
  id: `bench-${i}`, name: `PerformanceBot${i}`, displayName: '', serverHost: 'localhost', serverPort: 25565,
  edition: 'JAVA', authType: 'MICROSOFT', status: 'ONLINE', health: 20, food: 20,
  crouchEnabled: true, autoReconnect: true, autoSellEnabled: true, autoSellIntervalSeconds: 1,
  autoSellCommand: '/sell', minecraftVersion: '', notes: '', spawnerType: '', spawnerActions: {},
  lastSellAt: null, imageUrl: null,
  createdBy: { id: 'admin', username: 'Performance', minecraftUsername: null }, assignments: [],
}));
let releaseSlowDashboard;
let blockDashboard = false;
page.on('pageerror', e => errors.push(e.message));
await page.route('**/api/**', async route => {
  const url = new URL(route.request().url());
  const key = url.pathname + url.search;
  requests.set(key, (requests.get(key) ?? 0) + 1);
  await new Promise(resolve => setTimeout(resolve, url.pathname.endsWith('/logout') ? 800 : 100));
  let data = {};
  if (url.pathname.endsWith('/auth/login')) data = user;
  else if (url.pathname.endsWith('/auth/me')) data = { user };
  else if (url.pathname.endsWith('/namesniper/accounts')) data = [];
  else if (url.pathname.endsWith('/notes/note')) data = note;
  else if (url.pathname.endsWith('/notes')) data = [note];
  else if (url.pathname.endsWith('/accounts')) data = accounts;
  else if (url.pathname.endsWith('/accounts/bench-0')) data = accounts[0];
  else if (url.pathname.endsWith('/earnings')) data = { last5m: 42, last1h: 84, last24h: 168 };
  else if (url.pathname.endsWith('/earnings/history')) {
    const range = url.searchParams.get('range') ?? '1h';
    const count = { '30m': 6, '1h': 12, '6h': 72, '24h': 288 }[range];
    const end = Math.floor(Date.now() / 300_000) * 300_000;
    data = { range, bucketMs: 300_000, start: new Date(end - count * 300_000).toISOString(), end: new Date(end).toISOString(),
      total: count * 42, points: Array.from({ length: count }, (_, i) => ({ at: new Date(end - (count - i) * 300_000).toISOString(), amount: 42 })) };
  } else if (url.pathname.endsWith('/minigames/admin/dashboard')) {
    if (blockDashboard) await new Promise(resolve => { releaseSlowDashboard = resolve; });
    data = { serviceStatus: 'ok', databaseStatus: 'ok', uptimeSeconds: 5, connectedClients: 0,
      activeLobbies: 0, runningGames: 0, gamesToday: 0, websocketConnections: 0,
      versionDistribution: {}, protocolDistribution: {}, recentErrors: [] };
  } else if (url.pathname.endsWith('/logs') || url.pathname.endsWith('/audit-logs') || url.pathname.endsWith('/notes') || url.pathname.endsWith('/users') || url.pathname.endsWith('/ip-bans')) data = [];
  else if (url.pathname.endsWith('/item-worth')) data = { status: 'IDLE', cursor: 0, total: 0, scanNumber: 0,
    changedCount: 0, missedCount: 0, delaySeconds: 5, accountIds: [], accounts: [], values: [], recent: [], suspicious: [],
    registryTotal: 0, minDelaySeconds: 1, maxDelaySeconds: 3600, etaSeconds: null };
  await route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) }).catch(() => {});
});
await page.addInitScript(({ accounts }) => {
  window.__sockets = [];
  window.__formatCalls = 0;
  const format = Date.prototype.toLocaleTimeString;
  Date.prototype.toLocaleTimeString = function (...args) { window.__formatCalls++; return format.apply(this, args); };
  class FakeSocket {
    static OPEN = 1;
    readyState = 1;
    constructor(url) {
      this.url = url;
      window.__sockets.push(this);
      setTimeout(() => {
        this.onopen?.({});
        if (url.endsWith('/ws/dashboard')) this.deliver({ type: 'statuses', statuses: accounts });
        if (url.endsWith('/ws/accounts/bench-0')) {
          this.deliver({ type: 'history', logs: [] });
          this.deliver({ type: 'status', status: accounts[0] });
        }
      }, 10);
    }
    deliver(data) { this.onmessage?.({ data: JSON.stringify(data) }); }
    close() { this.readyState = 3; this.onclose?.({}); }
  }
  window.WebSocket = FakeSocket;
}, { accounts });
try {
  const start = Date.now();
  await page.goto(base);
  await page.locator('#login-username').waitFor();
  const loginFormMs = Date.now() - start;
  await page.locator('#login-username').fill('Performance');
  await page.locator('#login-password').fill('test');
  const loginStart = Date.now();
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.locator('.account-card').nth(99).waitFor();
  const dashboardMs = Date.now() - loginStart;
  await page.waitForTimeout(250);
  const initialAccountRequests = [...requests.entries()].filter(([key]) => key.split('?', 1)[0] === '/api/minecraft/accounts').reduce((sum, [, count]) => sum + count, 0);
  await page.locator('a[href="/accounts/bench-0?tab=console"]').click();
  const consoleHeight = await page.locator('.console-output').evaluate(el => el.clientHeight);
  const consoleTabWidth = await page.locator('.tab-bar').evaluate(el => el.getBoundingClientRect().width);
  const closedGeometry = await page.evaluate(() => ({
    contentWidth: document.documentElement.clientWidth,
    mainLeft: document.querySelector('main').getBoundingClientRect().left,
    scrollbarGutter: getComputedStyle(document.documentElement).scrollbarGutter,
  }));
  await page.locator('[aria-label="Sell earnings"] h3').hover();
  await page.waitForTimeout(220);
  const graphMidHeight = await page.locator('.earnings-details').evaluate(el => el.getBoundingClientRect().height);
  await page.getByRole('img', { name: /Verkaufsgraph der letzten Stunde/ }).waitFor();
  await page.waitForTimeout(400);
  const graphOpenHeight = await page.locator('.earnings-details').evaluate(el => el.getBoundingClientRect().height);
  const openGeometry = await page.evaluate(() => ({
    contentWidth: document.documentElement.clientWidth,
    mainLeft: document.querySelector('main').getBoundingClientRect().left,
  }));
  const expandedConsoleHeight = await page.locator('.console-output').evaluate(el => el.clientHeight);
  if (verify) {
    ensure(graphMidHeight > 0 && graphMidHeight < graphOpenHeight - 10,
      `Graph did not open gradually: mid=${graphMidHeight}, open=${graphOpenHeight}`);
    ensure(closedGeometry.scrollbarGutter === 'stable' && closedGeometry.contentWidth === openGeometry.contentWidth
      && Math.abs(closedGeometry.mainLeft - openGeometry.mainLeft) < 0.5,
      `Opening graph shifted the page horizontally: ${JSON.stringify({ closedGeometry, openGeometry })}`);
    ensure(expandedConsoleHeight >= 158, 'Expanded graph hid the console');
    ensure(Math.abs(consoleHeight - expandedConsoleHeight - 135) < 3,
      `Graph changed ${consoleHeight - expandedConsoleHeight}px of console instead of five lines (closed=${consoleHeight}, open=${expandedConsoleHeight})`);
  }
  await page.getByRole('button', { name: '24 Stunden', exact: true }).click();
  const chart = page.getByRole('img', { name: /Verkaufsgraph der letzten 24 Stunden/ });
  await chart.waitFor();
  const interactions = await chart.evaluate(async node => {
    const samples = [];
    node.focus();
    for (let i = 0; i < 5; i++) {
      window.__formatCalls = 0;
      const start = performance.now();
      const changed = new Promise(resolve => {
        const observer = new MutationObserver(() => { observer.disconnect(); resolve(performance.now() - start); });
        observer.observe(node.parentElement, { subtree: true, childList: true, characterData: true });
      });
      node.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      samples.push({ commitMs: +(await changed).toFixed(2), repeatedDateFormats: window.__formatCalls });
    }
    return samples;
  });
  await page.getByRole('button', { name: '1 Stunde', exact: true }).click();
  await page.getByRole('img', { name: /Verkaufsgraph der letzten Stunde/ }).waitFor();
  await page.getByRole('button', { name: 'Verkaufsgraph einklappen' }).click();
  await page.waitForTimeout(550);
  if (verify) {
    ensure(await page.locator('.console-output').evaluate((el, height) => el.clientHeight === height, consoleHeight), 'Collapsing the graph did not restore console height');
    const collapsedLayout = await page.evaluate(() => ({ page: document.documentElement.scrollHeight, viewport: innerHeight,
      graph: document.querySelector('.earnings-details').getBoundingClientRect().height,
      output: document.querySelector('.console-output').getBoundingClientRect().height,
      graphBox: document.querySelector('.earnings-details').getBoundingClientRect().toJSON(),
      clipBox: document.querySelector('.earnings-details-clip').getBoundingClientRect().toJSON(),
      earningsBox: document.querySelector('[aria-label="Sell earnings"]').getBoundingClientRect().toJSON(),
      mainBox: document.querySelector('main').getBoundingClientRect().toJSON(),
      expanded: document.querySelector('.earnings-details').dataset.expanded }));
    ensure(collapsedLayout.page <= collapsedLayout.viewport + 1, `Collapsed graph left the account page scrolling: ${JSON.stringify(collapsedLayout)}`);
  }
  await page.getByRole('button', { name: 'Verkaufsgraph ausklappen' }).click();
  await page.getByRole('img', { name: /Verkaufsgraph der letzten Stunde/ }).waitFor();
  const graphRequests = requests.get('/api/minecraft/accounts/bench-0/earnings/history?range=1h');
  let backgroundRequests = null;
  let slowDashboardRequests = null;
  const pageChecks = [];
  if (verify) {
    ensure(initialAccountRequests === 1, 'Dashboard made duplicate account-list requests');
    ensure(graphRequests === 1, 'Reopening/changing back to a graph repeated its request');
    await page.getByRole('button', { name: 'Einstellungen', exact: true }).click();
    ensure(Math.abs((await page.locator('.tab-bar').evaluate(el => el.getBoundingClientRect().width)) - consoleTabWidth) < 1,
      'Account tabs stretched only on the console page');
    await page.getByRole('button', { name: 'Save settings', exact: true }).waitFor();
    pageChecks.push('account-settings');
    await page.getByRole('button', { name: 'Console', exact: true }).click();
    await page.getByRole('button', { name: 'Verkaufsgraph ausklappen' }).waitFor();
    await page.getByText('$42', { exact: true }).waitFor();
    await page.clock.install();
    const earningsKey = '/api/minecraft/accounts/bench-0/earnings';
    const before = requests.get(earningsKey);
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
    await page.clock.fastForward(31_000);
    await page.waitForTimeout(150);
    backgroundRequests = (requests.get(earningsKey) ?? 0) - before;
    ensure(backgroundRequests === 0, 'Hidden tab continued polling earnings');
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForTimeout(200);
    ensure(requests.get(earningsKey) > before, 'Visible tab did not refresh earnings');
    blockDashboard = true;
    await page.locator('a[href="/minigames"]').click();
    await page.waitForTimeout(200);
    ensure(releaseSlowDashboard, 'Minigames request was not started');
    await page.clock.fastForward(11_000);
    await page.waitForTimeout(200);
    slowDashboardRequests = requests.get('/api/minigames/admin/dashboard');
    ensure(slowDashboardRequests === 1, 'Slow request was repeatedly restarted by polling');
    blockDashboard = false;
    releaseSlowDashboard();
    await page.getByText('Datenbank: ok', { exact: true }).waitFor();
    for (const [path, heading] of [['/item-worth', 'Item Wert'], ['/namesniper', 'Name Sniper'], ['/users', 'Users'], ['/logs', 'Audit Logs'], ['/settings', 'Settings'], ['/notes', 'Notizen']]) {
      await page.locator(`aside a[href="${path}"]`).click();
      await page.getByRole('heading', { name: heading, exact: true }).waitFor();
      await page.waitForTimeout(150);
      pageChecks.push(path);
    }
    ensure(!scripts.some(url => url.includes('/NoteEditor-')), 'Note list loaded the complete rich-text editor');
    await page.getByRole('navigation', { name: 'Notizenliste' }).getByRole('link').click();
    await page.getByRole('textbox', { name: 'Notizinhalt' }).waitFor();
    ensure((await page.getByRole('textbox', { name: 'Notizinhalt' }).textContent()).includes('Lazy editor check'), 'Lazy note editor did not load note content');
    pageChecks.push('/notes/note');
    await page.locator('aside a[href="/dashboard"]').click();
    await page.locator('.account-card').nth(99).waitFor();
    await page.getByRole('button', { name: '+ New account', exact: true }).click();
    await page.getByRole('heading', { name: 'New Minecraft account', exact: true }).waitFor();
    pageChecks.push('create-account-dialog');
  }
  ensure(errors.length === 0, errors.join('; '));
  console.log(JSON.stringify({ browser: await browser.version(), fixture: { accounts: 100, apiDelayMs: 100, startupLogoutDelayMs: 800 },
    loginFormMs, dashboardMs, initialAccountRequests, graphRequests, interactions,
    backgroundRequests, slowDashboardRequests, pageChecks, errors }, null, 2));
} finally { await browser.close(); }
