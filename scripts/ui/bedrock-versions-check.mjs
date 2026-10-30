import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
// The website consumes SoulFire's runtime catalog for both editions.
const catalog = { java: { versions: ['26.3', '26.2'], defaultVersion: '26.3' },
  bedrock: { versions: ['1.26.51', '1.26.50'], defaultVersion: '1.26.51' } };

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const base = process.env.PERF_URL ?? 'http://127.0.0.1:4176';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
const errors = [];
const user = { id: 'admin', username: 'VersionCheck', role: 'ADMIN', status: 'ACTIVE' };
const accounts = ['BEDROCK', 'JAVA'].map((edition, index) => ({
  id: edition.toLowerCase(), name: `${edition}Bot`, edition, displayName: '',
  serverHost: 'localhost', serverPort: index ? 25565 : 19132, minecraftVersion: index ? '26.2' : '',
  authType: 'MICROSOFT', status: 'OFFLINE', crouchEnabled: false, autoReconnect: true,
  autoSellEnabled: false, autoSellIntervalSeconds: 60, autoSellCommand: '/sell', notes: '',
  spawnerType: '', spawnerActions: {}, createdBy: user, assignments: [], imageUrl: null, lastSellAt: null,
}));
let failNextCatalog = false;
let catalogRequests = 0;
page.on('pageerror', error => errors.push(error.message));
await page.route('**/api/**', async route => {
  const request = route.request();
  const path = new URL(request.url()).pathname;
  let data = {};
  if (path.endsWith('/auth/login')) data = user;
  else if (path.endsWith('/auth/me')) data = { user };
  else if (path.endsWith('/profile/dashboard')) data = { initialized: true, preferences: {
    accountOrder: [], blurredAccountIds: [], uploaderOrder: [], collapsedUploaderIds: [],
  } };
  else if (path.endsWith('/minecraft/versions')) {
    catalogRequests++;
    if (failNextCatalog) {
      failNextCatalog = false;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Fixture offline' }) });
      return;
    }
    data = catalog;
  } else if (path.endsWith('/users')) data = [];
  else if (path.endsWith('/accounts')) data = accounts;
  else if (accounts.some(account => path.endsWith(`/accounts/${account.id}`))) {
    data = accounts.find(account => path.endsWith(`/accounts/${account.id}`));
    if (request.method() === 'PATCH') Object.assign(data, request.postDataJSON());
  } else if (path.endsWith('/earnings')) data = { last5m: 0, last1h: 0, last24h: 0 };
  else if (path.endsWith('/logs')) data = [];
  await route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
});
await page.addInitScript(() => {
  window.WebSocket = class {
    static OPEN = 1;
    readyState = 1;
    constructor() { setTimeout(() => this.onopen?.(), 0); }
    close() { this.readyState = 3; }
    send() {}
  };
});

const select = () => page.getByRole('combobox', { name: 'Minecraft version' });
const options = () => select().locator('option').evaluateAll(entries => entries.filter(entry => !entry.disabled).map(entry => entry.value));
async function expectJava() {
  await page.waitForFunction(() => [...document.querySelectorAll('select[aria-label="Minecraft version"] option')].some(option => !option.disabled && option.value === '26.2'));
  assert.deepEqual(await options(), ['', ...catalog.java.versions]);
}
async function expectBedrock() {
  await page.waitForFunction(() => [...document.querySelectorAll('select[aria-label="Minecraft version"] option')].some(option => option.value === '1.26.51'));
  assert.deepEqual(await options(), ['', ...catalog.bedrock.versions]);
  assert(!(await options()).includes('26.2'));
}

try {
  await page.goto(base);
  await page.locator('#login-username').fill('VersionCheck');
  await page.locator('#login-password').fill('test');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.locator('.account-card').nth(1).waitFor();
  await page.getByRole('button', { name: '+ New account', exact: true }).click();
  await select().selectOption('26.2');
  await page.getByRole('button', { name: 'Bedrock', exact: true }).click();
  await expectBedrock();
  assert.equal(await select().inputValue(), '');
  await select().selectOption('1.26.51');
  await page.getByRole('button', { name: 'Java', exact: true }).click();
  assert.equal(await select().inputValue(), '');
  await expectJava();
  assert(!(await options()).includes('1.26.51'));
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();

  for (const edition of ['bedrock', 'java']) {
    await page.locator(`a[href="/accounts/${edition}?tab=console"]`).first().click();
    await page.getByRole('button', { name: 'Einstellungen', exact: true }).click();
    await page.getByRole('button', { name: /^Connection/ }).click();
    if (edition === 'bedrock') await expectBedrock();
    else {
      await expectJava();
      assert(!(await options()).includes('1.26.51'));
    }
    await page.locator('aside a[href="/dashboard"]').click();
    await page.locator('.account-card').nth(1).waitFor();
  }

  await page.getByRole('button', { name: '+ New account', exact: true }).click();
  await expectJava();
  failNextCatalog = true;
  await page.getByRole('button', { name: 'Bedrock', exact: true }).click();
  await page.getByRole('button', { name: 'Erneut laden', exact: true }).waitFor();
  assert.deepEqual(await options(), ['']);
  const beforeRetry = catalogRequests;
  await page.getByRole('button', { name: 'Erneut laden', exact: true }).click();
  await expectBedrock();
  assert.equal(catalogRequests, beforeRetry + 1);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks: ['creation', 'edition reset', 'Bedrock settings', 'Java settings', 'failed catalogue retry'], catalogRequests, errors }));
} finally { await browser.close(); }
