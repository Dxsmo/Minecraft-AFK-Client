// Run against Vite with PLAYWRIGHT_MODULE pointing to an installed Playwright.
// All application APIs and sockets are mocked; no Minecraft accounts connect.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const base = process.env.UI_URL ?? 'http://127.0.0.1:4175';
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : { channel: 'chrome' }) });
const errors = [], report = [];
const user = (id, username, role = 'USER', status = 'ACTIVE') => ({ id, username, role, status });
const admin = user('admin', 'TestAdmin', 'ADMIN');
const otherAdmin = user('other-admin', 'OtherAdmin', 'ADMIN');
const alice = user('alice', 'Alice');
const bob = user('bob', 'Bob_with_a_very_long_username_'.repeat(2));
const empty = user('empty', 'EmptyUser', 'USER', 'DISABLED');
// Select the category itself, rather than relying on translated button text.
const group = (page, id) => page.locator(`.uploader-category[data-uploader-id="${id}"]`);
const order = page => page.locator('.uploader-category').evaluateAll(nodes => nodes.map(node => node.dataset.uploaderId));
const accountIds = locator => locator.locator('.account-row-link').evaluateAll(nodes => nodes.map(node => node.getAttribute('href').split('/')[2].split('?')[0]));
const key = id => `afk.uploaderCategories.v1.${id}`;
const initialOrder = ['user:alice', 'user:bob', 'user:empty', 'user:other-admin', 'user:admin', 'unassigned'];

async function setup(page, { blockUsers = false, unavailableStorage = false } = {}) {
  const state = { active: admin, users: [admin, otherAdmin, alice, bob, empty], userRequests: [], reorders: [], failUsers: false };
  state.accounts = [['a1', alice], ['b1', bob], ['a2', alice], ['b2', bob], ['legacy', null]].map(([id, creator]) => ({
    id, name: `Bot_${id}`, displayName: '', serverHost: 'localhost', serverPort: 25565, edition: 'JAVA',
    minecraftVersion: '', status: 'ONLINE', imageUrl: null, notes: '', lastSellAt: null,
    createdBy: creator && { ...creator, minecraftUsername: null }, assignments: [{ userId: bob.id }],
  }));
  let releaseUsers;
  const usersReady = blockUsers ? new Promise(resolve => { releaseUsers = resolve; }) : Promise.resolve();
  state.releaseUsers = () => releaseUsers?.();
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ unavailableStorage }) => {
    window.__sockets = [];
    window.WebSocket = class {
      static OPEN = 1; readyState = 1;
      constructor() { window.__sockets.push(this); setTimeout(() => {
        this.onopen?.({}); this.deliver({ type: 'statuses', statuses: [] });
      }, 10); }
      deliver(data) { this.onmessage?.({ data: JSON.stringify(data) }); }
      close() { this.readyState = 3; }
    };
    if (unavailableStorage) for (const name of ['getItem', 'setItem']) {
      Storage.prototype[name] = () => { throw new Error('Browser storage unavailable'); };
    }
  }, { unavailableStorage });
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    let data = {}, status = 200;
    if (path.endsWith('/auth/login')) {
      const name = request.postDataJSON().username;
      state.active = name === otherAdmin.username ? otherAdmin : name === bob.username ? bob : admin;
      data = state.active;
    } else if (path.endsWith('/auth/me')) data = { user: state.active };
    else if (path.endsWith('/users')) {
      state.userRequests.push(state.active.id);
      assert.equal(state.active.role, 'ADMIN', 'Normal users must never fetch the user list');
      await usersReady;
      if (state.failUsers) { status = 503; data = { error: 'User list temporarily unavailable' }; }
      else data = state.users;
    } else if (path.endsWith('/minecraft/accounts/reorder')) {
      const ids = request.postDataJSON().accountIds;
      state.reorders.push(ids);
      assert.equal(new Set(ids).size, ids.length);
      const sorted = ids.map(id => state.accounts.find(account => account.id === id));
      const unseen = state.accounts.filter(account => !ids.includes(account.id));
      state.accounts = [...sorted, ...unseen];
      data = { ok: true };
    } else if (path.endsWith('/minecraft/accounts')) {
      data = state.active.role === 'ADMIN' ? state.accounts : state.accounts.filter(account => ['a1', 'b1'].includes(account.id));
    }
    await route.fulfill({ json: data, status });
  });
  return state;
}

async function login(page, username = admin.username) {
  await page.locator('#login-username').waitFor();
  await page.locator('#login-username').fill(username);
  await page.locator('#login-password').fill('mock-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL('**/dashboard');
}
async function reloadAndLogin(page, username) {
  await page.reload();
  await login(page, username);
  await page.locator('.uploader-category, .account-card').first().waitFor();
}
async function animate(locator) {
  return locator.evaluate(async element => {
    const content = element.querySelector('.uploader-content');
    const before = content.getBoundingClientRect().height;
    element.querySelector('.uploader-toggle').click();
    const samples = [], start = performance.now();
    await new Promise(resolve => {
      function frame() {
        const elapsed = performance.now() - start;
        samples.push({ elapsed, height: content.getBoundingClientRect().height,
          opacity: Number(getComputedStyle(element.querySelector('.uploader-accounts')).opacity) });
        if (elapsed < 600) requestAnimationFrame(frame); else resolve();
      }
      requestAnimationFrame(frame);
    });
    return { before, after: content.getBoundingClientRect().height, samples,
      duration: getComputedStyle(content).transitionDuration };
  });
}
async function fits(page) {
  const size = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  assert(size.document <= size.viewport + 1 && size.body <= size.viewport + 1, JSON.stringify(size));
}

try {
  for (const width of [320, 390, 768, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 1024, hasTouch: width < 1024 });
    const page = await context.newPage();
    const state = await setup(page, { blockUsers: true });
    await page.goto(base);
    await login(page);
    await page.getByText('Loading accounts…', { exact: true }).waitFor();
    assert.equal(await page.locator('.uploader-category, .account-card').count(), 0);
    state.releaseUsers();
    await group(page, 'user:alice').waitFor();
    assert.deepEqual(await order(page), initialOrder);
    assert.deepEqual(await accountIds(group(page, 'user:alice')), ['a1', 'a2']);
    assert.deepEqual(await accountIds(group(page, 'user:bob')), ['b1', 'b2']);
    assert.deepEqual(await accountIds(group(page, 'unassigned')), ['legacy']);
    assert.equal(await group(page, 'user:empty').getByText('Keine Accounts hochgeladen.', { exact: true }).count(), 1);
    await fits(page);
    const closing = await animate(group(page, 'user:alice'));
    assert.equal(closing.duration, '0.5s');
    assert.equal(closing.after, 0);
    assert(closing.samples.some(sample => sample.elapsed > 100 && sample.elapsed < 400 && sample.height > 1 && sample.height < closing.before - 1 && sample.opacity > 0 && sample.opacity < 1));
    assert.equal(await group(page, 'user:alice').getByRole('link').count(), 0, 'Collapsed accounts must be inaccessible');
    assert.equal(await group(page, 'user:alice').locator('.uploader-content').evaluate(element => element.inert), true);
    await group(page, 'user:alice').getByRole('button', { name: 'Alice: Kategorie nach unten', exact: true }).click();
    const reordered = ['user:bob', 'user:alice', ...initialOrder.slice(2)];
    assert.deepEqual(await order(page), reordered);
    assert.equal(state.reorders.length, 0, 'Category arrows must not change shared account ordering');
    await reloadAndLogin(page);
    assert.deepEqual(await order(page), reordered);
    assert.equal(await group(page, 'user:alice').locator('.uploader-toggle').getAttribute('aria-expanded'), 'false');
    const opening = await animate(group(page, 'user:alice'));
    assert.equal(opening.before, 0);
    assert(opening.after > 50);
    assert(opening.samples.some(sample => sample.elapsed > 100 && sample.elapsed < 400 && sample.height > 1 && sample.height < opening.after - 1));
    // Interrupt and reverse an animation; the final state must still settle.
    await group(page, 'user:alice').locator('.uploader-toggle').click();
    await page.waitForTimeout(100);
    await group(page, 'user:alice').locator('.uploader-toggle').click();
    await page.waitForTimeout(600);
    // Hover details can change the natural card height while toggling. The
    // panel must settle at its current content height, without clipping it.
    const settled = await group(page, 'user:alice').evaluate(element => ({
      panel: element.querySelector('.uploader-content').getBoundingClientRect().height,
      content: element.querySelector('.uploader-accounts').getBoundingClientRect().height,
      expanded: element.dataset.expanded,
    }));
    assert.equal(settled.expanded, 'true');
    assert(Math.abs(settled.panel - settled.content) <= 1, JSON.stringify(settled));
    if (width >= 1024) {
      const cards = group(page, 'user:alice').locator('.account-card');
      assert.equal(await cards.first().getByRole('button', { name: 'Move up', exact: true }).isDisabled(), true);
      assert.equal(await cards.last().getByRole('button', { name: 'Move down', exact: true }).isDisabled(), true);
      const response = page.waitForResponse(response => response.url().endsWith('/minecraft/accounts/reorder'));
      await cards.first().getByRole('button', { name: 'Move down', exact: true }).click();
      await response;
      await page.waitForFunction(() => document.querySelector('[data-uploader-id="user:alice"] .account-row-link').getAttribute('href').includes('/a2?'));
      assert.deepEqual(state.reorders.at(-1), ['a2', 'b1', 'a1', 'b2', 'legacy']);
      assert.deepEqual(await accountIds(group(page, 'user:bob')), ['b1', 'b2']);
      await page.mouse.move(0, 0);
    }
    await group(page, 'user:alice').locator('.uploader-toggle').click();
    await page.waitForTimeout(550);
    await reloadAndLogin(page, otherAdmin.username);
    assert.deepEqual(await order(page), initialOrder, 'Category preferences must be private to each admin');
    assert.equal(await group(page, 'user:alice').locator('.uploader-toggle').getAttribute('aria-expanded'), 'true');
    await reloadAndLogin(page, bob.username);
    assert.equal(await page.locator('.uploader-category').count(), 0);
    assert.deepEqual(await accountIds(page), state.accounts.filter(account => ['a1', 'b1'].includes(account.id)).map(account => account.id));
    assert(!state.userRequests.includes(bob.id));
    await reloadAndLogin(page);
    assert.deepEqual(await order(page), reordered);
    assert.equal(await group(page, 'user:alice').locator('.uploader-toggle').getAttribute('aria-expanded'), 'false');
    state.users = state.users.map(user => user.id === alice.id ? { ...user, username: 'RenamedAlice' } : user);
    state.users.push(user('new', 'AAA_NewUser'));
    state.users = state.users.filter(user => user.id !== empty.id);
    await reloadAndLogin(page);
    assert.deepEqual(await order(page), [...reordered.filter(id => id !== 'user:empty'), 'user:new']);
    assert.equal(await group(page, 'user:alice').getByRole('button', { name: 'Accounts von RenamedAlice', exact: true }).getAttribute('aria-expanded'), 'false');
    assert.equal(await group(page, 'user:new').locator('.uploader-toggle').getAttribute('aria-expanded'), 'true');
    state.users = state.users.filter(user => user.id !== alice.id);
    state.accounts = state.accounts.map(account => account.createdBy?.id === alice.id ? { ...account, createdBy: null } : account);
    await reloadAndLogin(page);
    assert.equal(await group(page, 'user:alice').count(), 0);
    assert.deepEqual((await accountIds(group(page, 'unassigned'))).sort(), ['a1', 'a2', 'legacy']);
    assert.equal((await accountIds(page)).length, 5, 'Deleted creators must not hide any accounts');
    await fits(page);
    if (width === 390) await page.screenshot({ path: '/tmp/afk-uploader-categories-mobile.png', fullPage: true });
    await page.evaluate(storageKey => localStorage.setItem(storageKey, '{broken json'), key(admin.id));
    await reloadAndLogin(page);
    assert.equal(await page.locator('.uploader-toggle[aria-expanded="false"]').count(), 0);
    state.failUsers = true;
    await page.reload();
    await login(page);
    await page.getByText('User list temporarily unavailable', { exact: true }).waitFor();
    assert.equal(await page.locator('.uploader-category').count(), 0);
    state.failUsers = false;
    await page.evaluate(() => window.__sockets.filter(socket => socket.readyState === 1).forEach(socket => socket.deliver({ type: 'statuses', statuses: [] })));
    await group(page, 'user:bob').waitFor();
    assert.equal((await accountIds(page)).length, 5);
    report.push({ width, groups: await order(page), closingMidHeight: closing.samples.find(sample => sample.elapsed > 220)?.height,
      openingMidHeight: opening.samples.find(sample => sample.elapsed > 220)?.height, animation: closing.duration });
    await context.close();
  }
  const page = await browser.newPage();
  await setup(page, { unavailableStorage: true });
  await page.goto(base);
  await login(page);
  await group(page, 'user:alice').waitFor();
  await group(page, 'user:alice').locator('.uploader-toggle').click();
  assert.equal(await group(page, 'user:alice').locator('.uploader-toggle').getAttribute('aria-expanded'), 'false');
  await group(page, 'user:alice').getByRole('button', { name: 'Alice: Kategorie nach unten', exact: true }).click();
  assert.equal((await order(page))[1], 'user:alice');
  await page.close();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ scenarios: report, unavailableStorage: 'usable', errors }, null, 2));
} finally { await browser.close(); }
