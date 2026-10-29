// UI-only fixture. Run against Vite; no Microsoft or Minecraft connections.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const base = process.env.UI_URL ?? 'http://127.0.0.1:4175';
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : { channel: 'chrome' }) });
const catalog = JSON.parse(await readFile(new URL('../../backend/assets/account-items/catalog.json', import.meta.url), 'utf8'));
const errors = [], selections = [];
const user = { id: 'picker-user', username: 'PickerUser', role: 'USER', status: 'ACTIVE' };
const account = { id: 'picker-account', name: 'PickerTest', edition: 'JAVA', serverHost: 'localhost', serverPort: 25565, status: 'OFFLINE', displayName: '', imageUrl: null, notes: '', lastSellAt: null, assignments: [], createdBy: user };
try {
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { window.WebSocket = class { static OPEN=1; readyState=1; constructor(){setTimeout(()=>this.onopen?.({}),0);} close(){} }; });
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    let json = {};
    if (path.endsWith('/auth/login')) json = user;
    else if (path.endsWith('/auth/me')) json = { user };
    else if (path.includes('/profile/dashboard')) json = { initialized: true, preferences: { accountOrder: [], blurredAccountIds: [], uploaderOrder: [], collapsedUploaderIds: [] } };
    else if (path === '/api/minecraft/account-items') json = catalog;
    else if (path.startsWith('/api/assets/account-items/')) {
      const file = path.split('/').at(-1);
      assert.match(file, /^[a-z0-9_]+\.png$/);
      return route.fulfill({ contentType: 'image/png', body: await readFile(new URL(`../../backend/assets/account-items/${file}`, import.meta.url)) });
    } else if (path.endsWith('/image') && request.method() === 'PUT') { selections.push(request.postDataJSON()); account.imageUrl = '/api/account-fixture-image'; json = { id: account.id, imageUrl: account.imageUrl }; }
    else if (path === '/api/account-fixture-image') return route.fulfill({ contentType: 'image/png', body: await readFile(new URL('../../backend/assets/account-items/diamond_sword.png', import.meta.url)) });
    else if (path === '/api/minecraft/accounts') json = [account];
    await route.fulfill({ json });
  });
  await page.goto(base);
  await page.locator('input[name="username"]').fill('PickerUser'); await page.locator('input[name="password"]').fill('test');
  await page.getByRole('button', { name: /sign in|log in|anmelden/i }).click();
  const picker = page.getByRole('button', { name: 'Account-Bild auswählen' }); await picker.waitFor();
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await picker.click(); const dialog=page.getByRole('dialog'); await dialog.waitFor();
    await page.getByText('1489 Items · A–Z', { exact: true }).waitFor();
    const bounds=await dialog.boundingBox(); assert.ok(bounds.width <= width - 24);
    const firstNames = await dialog.locator('button[title]').evaluateAll(nodes => nodes.slice(0,20).map(node=>node.title));
    assert.deepEqual(firstNames,[...firstNames].sort((a,b)=>a.localeCompare(b)));
    const search=dialog.getByRole('searchbox',{name:'Items suchen'}); await search.fill('diamond_sword');
    await dialog.getByRole('button',{ name:'diamond sword',exact:true }).waitFor();
    assert.equal(await dialog.locator('button[title]').count(),1);
    await page.screenshot({path:`/tmp/afk-item-picker-${width}.png`});
    await dialog.getByRole('button',{name:'diamond sword',exact:true}).click(); await dialog.waitFor({state:'hidden'});
    assert.deepEqual(selections.at(-1),{itemId:'diamond_sword'});
    assert.ok(await picker.locator('img').isVisible());
    await picker.click(); await search.fill('no such minecraft item'); await dialog.getByText('Keine passenden Items gefunden.').waitFor();
    await page.keyboard.press('Escape'); await dialog.waitFor({state:'hidden'});
  }
  assert.deepEqual(errors,[]); console.log(JSON.stringify({ widths:[1280,390],items:catalog.length,selections:selections.length,errors },null,2));
} finally { await browser.close(); }
