// Run against Vite with PLAYWRIGHT_MODULE pointing to an installed Playwright.
// All application APIs and sockets are mocked; no Minecraft accounts connect.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const base = process.env.UI_URL ?? 'http://127.0.0.1:4175';
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : { channel: 'chrome' }) });
const errors = [], report = [], deviceChecks = [];
const user = (id, username, role = 'USER', status = 'ACTIVE') => ({ id, username, role, status });
const admin = user('admin', 'TestAdmin', 'ADMIN');
const otherAdmin = user('other-admin', 'OtherAdmin', 'ADMIN');
const alice = { ...user('alice', 'Alice'), minecraftUsername: 'MogliHD' };
const bob = user('bob', 'Bob_with_a_very_long_username_'.repeat(2));
const empty = user('empty', 'EmptyUser', 'USER', 'DISABLED');
// Select the category itself, rather than relying on translated button text.
const group = (page, id) => page.locator(`.uploader-category[data-uploader-id="${id}"]`);
const order = page => page.locator('.uploader-category').evaluateAll(nodes => nodes.map(node => node.dataset.uploaderId));
const accountIds = locator => locator.locator('.account-row-link').evaluateAll(nodes => nodes.map(node => node.getAttribute('href').split('/')[2].split('?')[0]));
const key = id => `afk.uploaderCategories.v1.${id}`;
const initialOrder = ['user:alice', 'user:bob', 'user:empty', 'user:other-admin', 'user:admin', 'unassigned'];

const emptyPreferences = () => ({ accountOrder: [], blurredAccountIds: [], uploaderOrder: [], collapsedUploaderIds: [] });
async function setup(page, { blockUsers = false, blockProfile = false, unavailableStorage = false, profiles = new Map(), legacy = null } = {}) {
  const state = { active: admin, users: [admin, otherAdmin, alice, bob, empty], userRequests: [], reorders: [], failUsers: false,
    profiles, failProfileOnce: false, profileFailureStatus: 503, profileDelay: 0 };
  state.accounts = [['a1', alice], ['b1', bob], ['a2', alice], ['b2', bob], ['legacy', null]].map(([id, creator]) => ({
    id, name: `Bot_${id}`, displayName: '', serverHost: 'localhost', serverPort: 25565, edition: 'JAVA',
    minecraftVersion: '', status: 'ONLINE', imageUrl: null, notes: '', lastSellAt: null,
    createdBy: creator && { ...creator, minecraftUsername: null }, assignments: [{ userId: bob.id }],
  }));
  let releaseUsers;
  const usersReady = blockUsers ? new Promise(resolve => { releaseUsers = resolve; }) : Promise.resolve();
  state.releaseUsers = () => releaseUsers?.();
  let releaseProfile;
  const profileReady = blockProfile ? new Promise(resolve => { releaseProfile = resolve; }) : Promise.resolve();
  state.releaseProfile = () => releaseProfile?.();
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ unavailableStorage, legacy }) => {
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
    if (legacy && !sessionStorage.getItem('legacy-seeded')) {
      for (const [key, value] of Object.entries(legacy)) localStorage.setItem(key, JSON.stringify(value));
      sessionStorage.setItem('legacy-seeded', 'yes');
    }
  }, { unavailableStorage, legacy });
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    let data = {}, status = 200;
    if (path.endsWith('/auth/login')) {
      const name = request.postDataJSON().username;
      state.active = name === otherAdmin.username ? otherAdmin : name === bob.username ? bob : admin;
      data = state.active;
    } else if (path.endsWith('/auth/me')) data = { user: state.active };
    else if (path.endsWith('/avatar')) {
      await route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64') });
      return;
    }
    else if (path.includes('/profile/dashboard')) {
      await profileReady;
      await new Promise(resolve => setTimeout(resolve, state.profileDelay));
      const saved = profiles.get(state.active.id) ?? { initialized: false, preferences: emptyPreferences() };
      if (request.method() !== 'GET') {
        if (state.failProfileOnce) {
          state.failProfileOnce = false;
          await route.fulfill({ status: state.profileFailureStatus, json: { error: 'Profile storage temporarily unavailable' } });
          return;
        }
        const patch = request.postDataJSON();
        const membership = (ids, id, value) => value ? [...new Set([...ids, id])] : ids.filter(item => item !== id);
        if (path.endsWith('/import')) {
          if (!saved.initialized) saved.preferences = patch;
        } else {
          if (patch.accountOrder) { saved.preferences.accountOrder = patch.accountOrder; state.reorders.push(patch.accountOrder); }
          if (patch.uploaderOrder) saved.preferences.uploaderOrder = patch.uploaderOrder;
          if (patch.blur) saved.preferences.blurredAccountIds = membership(saved.preferences.blurredAccountIds, patch.blur.accountId, patch.blur.value);
          if (patch.collapse) saved.preferences.collapsedUploaderIds = membership(saved.preferences.collapsedUploaderIds, patch.collapse.uploaderId, patch.collapse.value);
        }
        saved.initialized = true;
        profiles.set(state.active.id, saved);
      }
      const preferences = saved.preferences;
      const accountIds = state.accounts.filter(account => state.active.role === 'ADMIN' || ['a1', 'b1'].includes(account.id)).map(account => account.id);
      const uploaderIds = state.active.role === 'ADMIN' ? ['unassigned', ...state.users.map(user => `user:${user.id}`)] : [];
      data = { initialized: saved.initialized, preferences: {
        accountOrder: preferences.accountOrder.filter(id => accountIds.includes(id)),
        blurredAccountIds: preferences.blurredAccountIds.filter(id => accountIds.includes(id)),
        uploaderOrder: preferences.uploaderOrder.filter(id => uploaderIds.includes(id)),
        collapsedUploaderIds: preferences.collapsedUploaderIds.filter(id => uploaderIds.includes(id)),
      } };
    }
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
  try { await page.locator('.uploader-category, .account-card').first().waitFor(); }
  catch (failure) {
    console.error(JSON.stringify({ url: page.url(), body: await page.locator('body').innerText(), errors }, null, 2));
    throw failure;
  }
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
  for (const width of process.env.UI_DEVICES_ONLY === '1' ? [] : [320, 390, 768, 1280]) {
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
    assert.equal(await page.locator('.uploader-avatar').count(), 5);
    const head = group(page, 'user:alice').locator('.uploader-avatar img');
    await head.waitFor();
    assert.equal(await head.getAttribute('src'), '/api/users/alice/avatar?v=MogliHD');
    assert.equal(await head.evaluate(image => image.getBoundingClientRect().width), 20);
    assert.equal(await group(page, 'unassigned').locator('.uploader-avatar').count(), 0);
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
      const response = page.waitForResponse(response => response.url().endsWith('/profile/dashboard') && response.request().method() === 'PATCH' && response.request().postDataJSON().accountOrder);
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
  // Separate browser contexts have no shared cookies or local storage. Only
  // the mocked server profile is shared, exactly as on different devices.
  const profiles = new Map();
  const desktop = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const first = await desktop.newPage(), second = await mobile.newPage();
  const firstState = await setup(first, { profiles, legacy: {
    'afk.blurredAccounts.admin': ['a1'],
    [key(admin.id)]: { order: [...initialOrder].reverse(), collapsed: ['user:alice'] },
  } });
  const secondState = await setup(second, { profiles, blockProfile: true });
  await first.goto(base);
  await login(first);
  await group(first, 'user:alice').waitFor();
  assert.deepEqual(await order(first), [...initialOrder].reverse());
  assert.equal(await group(first, 'user:alice').locator('.uploader-toggle').getAttribute('aria-expanded'), 'false');
  assert.equal(await first.locator('a[href="/accounts/a1?tab=console"]').getAttribute('aria-label'), 'Open console for account');
  assert.equal(await first.evaluate(() => localStorage.getItem('afk.blurredAccounts.admin')), null);
  assert.equal(await first.evaluate(storageKey => localStorage.getItem(storageKey), key(admin.id)), null);
  deviceChecks.push('legacy browser settings imported and cleaned up');
  await second.goto(base);
  await login(second);
  await second.getByText('Loading accounts…', { exact: true }).waitFor();
  assert.equal(await second.locator('.account-card').count(), 0, 'Account cards must wait for the profile to prevent an unblurred flash');
  secondState.releaseProfile();
  await group(second, 'user:alice').waitFor();
  assert.deepEqual(await order(second), [...initialOrder].reverse());
  assert.equal(await group(second, 'user:alice').locator('.uploader-toggle').getAttribute('aria-expanded'), 'false');
  assert.equal(await second.locator('a[href="/accounts/a1?tab=console"]').getAttribute('aria-label'), 'Open console for account');
  assert.equal(await second.evaluate(storageKey => localStorage.getItem(storageKey), key(admin.id)), null);
  secondState.profileDelay = 0;
  deviceChecks.push('admin profile restored on a fresh mobile device before rendering cards');
  await group(first, 'user:bob').locator('.account-card').first().getByRole('button', { name: 'Blur account', exact: true }).click();
  await first.getByRole('status').filter({ hasText: 'Ansicht wird gespeichert' }).waitFor({ state: 'hidden' });
  await group(second, 'user:alice').locator('.uploader-toggle').click();
  await second.getByRole('status').filter({ hasText: 'Ansicht wird gespeichert' }).waitFor({ state: 'hidden' });
  await group(second, 'user:alice').getByRole('button', { name: 'Reveal account', exact: true }).click();
  await second.getByRole('status').filter({ hasText: 'Ansicht wird gespeichert' }).waitFor({ state: 'hidden' });
  assert.deepEqual(profiles.get(admin.id).preferences.blurredAccountIds, ['b1']);
  await first.evaluate(() => dispatchEvent(new Event('focus')));
  await first.waitForFunction(() => document.querySelector('a[href="/accounts/a1?tab=console"]').getAttribute('aria-label') === 'Open console for Bot_a1');
  assert.equal(await first.locator('a[href="/accounts/b1?tab=console"]').getAttribute('aria-label'), 'Open console for account');
  deviceChecks.push('individual edits from different devices preserve other blur settings');
  firstState.failProfileOnce = true;
  await group(first, 'user:alice').locator('.account-card').first().getByRole('button', { name: 'Blur account', exact: true }).click();
  await first.getByRole('alert').filter({ hasText: 'Ansicht konnte nicht gespeichert werden' }).waitFor();
  assert.deepEqual(profiles.get(admin.id).preferences.blurredAccountIds, ['b1']);
  await first.getByRole('button', { name: 'Erneut versuchen', exact: true }).click();
  await first.getByRole('status').filter({ hasText: 'Ansicht wird gespeichert' }).waitFor({ state: 'hidden' });
  assert.deepEqual(profiles.get(admin.id).preferences.blurredAccountIds, ['b1', 'a1']);
  assert.equal(await first.getByRole('alert').count(), 0);
  deviceChecks.push('failed writes are visible and can be retried');
  firstState.failProfileOnce = true;
  firstState.profileFailureStatus = 400;
  await group(first, 'user:alice').locator('.account-card').first().getByRole('button', { name: 'Move down', exact: true }).click();
  await first.getByRole('alert').filter({ hasText: 'Ansicht konnte nicht gespeichert werden' }).waitFor();
  assert.deepEqual(await accountIds(group(first, 'user:alice')), ['a2', 'a1']);
  await first.getByRole('button', { name: 'Erneut versuchen', exact: true }).click();
  await first.waitForFunction(() => document.querySelector('[data-uploader-id="user:alice"] .account-row-link').getAttribute('href').includes('/a1?'));
  assert.deepEqual(await accountIds(group(first, 'user:alice')), ['a1', 'a2']);
  firstState.profileFailureStatus = 503;
  deviceChecks.push('rejected outdated orders recover without blocking later changes');
  firstState.profileDelay = 200;
  const finished = first.waitForResponse(response => response.url().endsWith('/profile/dashboard') && response.request().method() === 'PATCH' && response.request().postDataJSON().collapse);
  await group(first, 'user:alice').locator('.account-card').first().getByRole('button', { name: 'Reveal account', exact: true }).click();
  await group(first, 'user:alice').locator('.account-card').first().getByRole('button', { name: 'Blur account', exact: true }).click();
  await group(first, 'user:alice').locator('.uploader-toggle').click();
  await first.evaluate(() => { history.pushState({}, '', '/settings'); dispatchEvent(new PopStateEvent('popstate')); });
  await first.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  await finished;
  assert.deepEqual(profiles.get(admin.id).preferences.blurredAccountIds, ['b1', 'a1']);
  assert.deepEqual(profiles.get(admin.id).preferences.collapsedUploaderIds, ['user:alice']);
  deviceChecks.push('rapid edits stay ordered and finish after page navigation');
  firstState.profileDelay = 0;
  await reloadAndLogin(first, bob.username);
  assert.equal(await first.locator('.uploader-category').count(), 0);
  assert.deepEqual(await accountIds(first), ['a1', 'b1']);
  const savedOrder = first.waitForResponse(response => response.url().endsWith('/profile/dashboard') && response.request().method() === 'PATCH' && response.request().postDataJSON().accountOrder);
  await first.locator('.account-card').first().getByRole('button', { name: 'Move down', exact: true }).click();
  await savedOrder;
  await first.locator('a[href="/accounts/a1?tab=console"]').locator('..').getByRole('button', { name: 'Blur account', exact: true }).click();
  await first.getByRole('status').filter({ hasText: 'Ansicht wird gespeichert' }).waitFor({ state: 'hidden' });
  await reloadAndLogin(second, bob.username);
  assert.deepEqual(await accountIds(second), ['b1', 'a1']);
  assert.equal(await second.locator('.uploader-category').count(), 0);
  assert.equal(await second.locator('a[href="/accounts/a1?tab=console"]').getAttribute('aria-label'), 'Open console for account');
  assert.deepEqual(profiles.get(admin.id).preferences.blurredAccountIds, ['b1', 'a1']);
  deviceChecks.push('normal-user ordering and blur restored on another device independently of admins');
  await desktop.close();
  await mobile.close();
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
  console.log(JSON.stringify({ scenarios: report, deviceChecks, unavailableStorage: 'usable', errors }, null, 2));
} catch (failure) {
  for (const context of browser.contexts()) for (const page of context.pages()) {
    console.error(JSON.stringify({ url: page.url(), body: await page.locator('body').innerText().catch(() => ''), errors }, null, 2));
  }
  throw failure;
} finally { await browser.close(); }
