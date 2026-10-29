// Read-only integration check against a running site with online Java/Bedrock
// accounts. UI_CREDENTIALS_FILE can point at the isolated local .env.local.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const credentials = process.env.UI_CREDENTIALS_FILE
  ? Object.fromEntries((await readFile(process.env.UI_CREDENTIALS_FILE, 'utf8')).trim().split('\n').map(line => {
    const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)];
  })) : {};
const username = process.env.UI_USERNAME ?? credentials.INITIAL_ADMIN_USERNAME;
const password = process.env.UI_PASSWORD ?? credentials.INITIAL_ADMIN_PASSWORD;
assert.ok(username && password, 'Provide website test credentials');
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const waitFor = async check => {
  const deadline = Date.now() + 45_000;
  while (!await check()) {
    assert.ok(Date.now() < deadline, 'Camera lifecycle assertion timed out');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
};
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const requests = [], cameras = [], errors = [];
  page.on('request', request => requests.push(request.url()));
  page.on('pageerror', error => errors.push(error.message));
  page.on('websocket', socket => {
    if (!socket.url().endsWith('/camera')) return;
    const entry = { url: socket.url(), frames: 0, closed: false }; cameras.push(entry);
    socket.on('close', () => { entry.closed = true; });
    socket.on('framereceived', frame => {
      try { if (JSON.parse(frame.payload.toString()).type === 'frame') entry.frames++; } catch {}
    });
  });
  const base = process.env.UI_URL ?? 'http://localhost:8080';
  await page.goto(base);
  await page.locator('input[name="username"]').fill(username);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL('**/dashboard');
  const accounts = await page.evaluate(async () => (await fetch('/api/minecraft/accounts?view=dashboard')).json());
  const java = accounts.find(account => account.edition === 'JAVA' && account.live?.status === 'ONLINE');
  const bedrock = accounts.find(account => account.edition === 'BEDROCK' && account.live?.status === 'ONLINE');
  const offline = accounts.find(account => account.live?.status === 'OFFLINE');
  assert.ok(java && bedrock && offline, 'Need online Java/Bedrock and one offline account');
  const navigate = (id, tab) => page.evaluate(({ id, tab }) => {
    history.pushState(null, '', `/accounts/${id}?tab=${tab}`); dispatchEvent(new PopStateEvent('popstate'));
  }, { id, tab });
  const image = page.getByAltText('Liveansicht des Minecraft-Accounts');
  const loaded = () => waitFor(async () => await image.count() > 0 && await image.evaluate(img => !img.hidden && img.naturalWidth === 640 && img.naturalHeight === 360));

  await navigate(java.id, 'console');
  await page.getByRole('button', { name: 'Live Cam', exact: true }).waitFor();
  assert.equal(cameras.length, 0);
  assert.equal(requests.some(url => /\/LiveCamPanel-/.test(url)), false);
  assert.deepEqual(await page.locator('.tab-bar button').allTextContents(), ['Console', 'Live Cam', 'Einstellungen']);
  await page.getByRole('button', { name: 'Live Cam', exact: true }).click();
  await loaded(); await waitFor(() => cameras[0]?.frames >= 2);
  assert.ok(cameras[0].url.includes(java.id));
  await page.screenshot({ path: '/tmp/afk-live-cam-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Einstellungen', exact: true }).click();
  await waitFor(() => cameras.every(camera => camera.closed));

  await page.getByRole('button', { name: 'Live Cam', exact: true }).click(); await loaded();
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await waitFor(() => cameras.every(camera => camera.closed));
  const hiddenCount = cameras.length;
  await page.getByText('Die Übertragung pausiert, solange dieser Browser-Tab nicht sichtbar ist.').waitFor();
  assert.equal(cameras.length, hiddenCount);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await loaded();

  await navigate(bedrock.id, 'camera'); await loaded();
  await waitFor(() => cameras.filter(camera => !camera.closed).length === 1);
  assert.ok(cameras.filter(camera => !camera.closed)[0].url.includes(bedrock.id));
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: '/tmp/afk-live-cam-mobile.png', fullPage: true });
  await navigate(offline.id, 'camera');
  await page.getByText('Der Account ist offline. Die Live Cam startet, sobald er verbunden ist.').waitFor();
  await waitFor(() => cameras.every(camera => camera.closed));
  assert.equal(cameras.some(camera => camera.url.includes(offline.id)), false);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ javaLiveFrames: true, bedrockLiveFrames: true, lazyLoaded: true,
    stopsOnTabChange: true, hiddenPagePauses: true, accountIsolation: true, offlineDoesNotRender: true,
    mobileOverflow: false, pageErrors: errors.length }));
} finally { await browser.close(); }
