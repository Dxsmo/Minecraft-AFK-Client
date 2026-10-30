// Full browser -> authenticated website WebSocket -> native SoulFire -> game
// regression. Uses an explicitly selected isolated SoulFire service and a
// disposable website database. No Microsoft accounts or existing game servers.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
assert.ok(process.env.SOULFIRE_URL && process.env.SOULFIRE_SECRET_KEY_FILE, 'Select an isolated SoulFire service');
const require = createRequire(import.meta.url);
const mc = require(process.env.MINECRAFT_PROTOCOL_MODULE || 'minecraft-protocol');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const directory = await mkdtemp(path.join(tmpdir(), 'afk-remote-website-'));
const root = fileURLToPath(new URL('../', import.meta.url));
const frontend = fileURLToPath(new URL('../../frontend/dist/', import.meta.url));
const port = Number(process.env.AFK_REMOTE_UI_PORT || 4177), origin = `http://127.0.0.1:${port}`;
Object.assign(process.env, { DOTENV_CONFIG_PATH: '/dev/null', NODE_ENV: 'test', LOG_LEVEL: 'silent',
  DATABASE_URL: `file:${path.join(directory, 'fixture.db')}`, SESSION_SECRET: 'isolated-native-browser-remote-secret',
  SESSION_COOKIE_NAME: 'afk_remote_fixture_session', SESSION_COOKIE_SECURE: 'false', INITIAL_ADMIN_PASSWORD: '',
  PUBLIC_ORIGIN: origin, CORS_ORIGINS: origin });
process.chdir(directory); await mkdir('data');
execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'], { cwd: root, env: process.env, stdio: 'pipe' });
const { buildApp } = await import('../dist/app.js');
const { prisma } = await import('../dist/database/prisma.js');
const { hashPassword } = await import('../dist/auth/password.js');
const { clientManager } = await import('../dist/minecraft/ClientManager.js');
const { soulFireRpc } = await import('../dist/soulfire/rpc.js');
const server = mc.createServer({ host: '0.0.0.0', port: 0, version: '1.8.8', 'online-mode': false });
const clients = [], moves = [], actions = [], failures = [];
const sales = [];
let transfers = 0;
const empty = { blockId: -1 };
const inventory = () => Array.from({ length: 63 }, (_, i) => i >= 27 ? { blockId: 260, itemCount: 64, itemDamage: 0 } : empty);
const droppedItems = Number(process.env.AFK_REMOTE_DROPPED_ITEMS || 0);
assert.ok(Number.isInteger(droppedItems) && droppedItems >= 0 && droppedItems <= 10000);
server.on('playerJoin', client => {
  clients.push(client);
  client.on('chat', ({ message }) => {
    if (message !== '/sell') return;
    sales.push(Date.now());
    client.write('open_window', { windowId: 1, inventoryType: 'minecraft:chest', windowTitle: JSON.stringify({ text: 'Items verkaufen' }), slotCount: 27 });
    client.write('window_items', { windowId: 1, items: inventory() });
  });
  client.on('window_click', click => {
    if (click.windowId !== 1) return;
    transfers++;
    client.write('transaction', { windowId: 1, action: click.action, accepted: true });
    client.write('window_items', { windowId: 1, items: inventory() });
    client.write('chat', { message: JSON.stringify({ text: '[HugoSMP] +$121,60 (Basis: $64, Bonus: +$57,60 durch 1.9x)' }), position: 0 });
  });
  client.on('position', packet => moves.push(packet)); client.on('position_look', packet => moves.push(packet));
  client.on('entity_action', packet => actions.push(packet.actionId));
  client.write('login', { entityId: client.id, gameMode: 0, dimension: 0, difficulty: 1, maxPlayers: 2, levelType: 'flat', reducedDebugInfo: false });
  const chunk = Buffer.alloc(8192 + 2048 + 2048 + 256); chunk.fill(255, 10240, 12288);
  client.write('map_chunk', { x: 0, z: 0, groundUp: true, bitMap: 1, chunkData: chunk });
  for (let x = 0; x < 5; x++) for (let z = 0; z < 5; z++) client.write('block_change', { location: { x, y: 63, z }, type: 16 });
  client.write('position', { x: .5, y: 64, z: .5, yaw: 0, pitch: 20, flags: 0 });
  client.write('set_slot', { windowId: 0, slot: 36, item: { blockId: 260, itemCount: 64, itemDamage: 0 } });
  for (let index = 0; index < droppedItems; index++) {
    const entityId = 1000 + index;
    client.write('spawn_entity', { entityId, type: 2, x: Math.round((.5 + (index % 20) / 20) * 32), y: 64 * 32,
      z: Math.round((.5 + Math.floor(index / 20) % 20 / 20) * 32), pitch: 0, yaw: 0, objectData: 1, velocity: { x: 0, y: 0, z: 0 } });
    client.write('entity_metadata', { entityId, metadata: [{ key: 10, type: 5, value: { blockId: 260, itemCount: 64, itemDamage: 0 } }] });
  }
});
const wait = async predicate => {
  const deadline = Date.now() + 35_000;
  while (!await predicate()) { assert.ok(Date.now() < deadline, 'Native website check timed out'); await new Promise(resolve => setTimeout(resolve, 50)); }
};
let app, browser, account, ids;
const originalFetch = globalThis.fetch;
const preparationDelayMs = Number(process.env.AFK_REMOTE_RPC_DELAY_MS || 0);
let delayNextPreparation = false, preparationDelayApplied = false;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (delayNextPreparation && url.pathname.endsWith('/UpdateBotConfigEntry')) {
    delayNextPreparation = false; preparationDelayApplied = true;
    await new Promise(resolve => setTimeout(resolve, preparationDelayMs));
  }
  return originalFetch(input, init);
};
try {
  await once(server, 'listening');
  const password = 'Native-remote-fixture-only-2026!';
  const user = await prisma.user.create({ data: { username: 'RemoteFixture', role: 'ADMIN', passwordHash: await hashPassword(password) } });
  account = await prisma.minecraftAccount.create({ data: { name: 'NativeRemote', edition: 'JAVA', minecraftVersion: '1.8.8',
    authType: 'OFFLINE', serverHost: process.env.MINECRAFT_FIXTURE_HOST || 'host.docker.internal', serverPort: server.socketServer.address().port,
    autoReconnect: false, autoStart: false, crouchEnabled: true, autoSellEnabled: true, autoSellIntervalSeconds: 2, createdById: user.id } });
  clientManager.onConsoleEvent(event => { if (event.type === 'ERROR') failures.push(event.message); });
  await clientManager.loadAll(); clientManager.start(account.id);
  await wait(() => clientManager.get(account.id)?.getStatus().status === 'ONLINE');
  ids = JSON.parse(await readFile(path.join(directory, 'data/bot-cache', account.id, 'soulfire.json'), 'utf8'));
  app = await buildApp();
  app.get('/assets/:file', async (request, reply) => {
    const name = request.params.file; assert.match(name, /^[\w.-]+\.(js|css)$/);
    return reply.type(name.endsWith('.css') ? 'text/css' : 'application/javascript').send(await readFile(path.join(frontend, 'assets', name)));
  });
  app.get('/desmodus-head.svg', async (_request, reply) => reply.type('image/svg+xml').send(await readFile(path.join(frontend, 'desmodus-head.svg'))));
  app.get('/*', async (_request, reply) => reply.type('text/html').send(await readFile(path.join(frontend, 'index.html'))));
  await app.listen({ host: '127.0.0.1', port });
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', error => failures.push(error.message));
  const remoteFrames = [], controlClosed = [], cameraFrames = [];
  page.on('websocket', ws => {
    if (ws.url().endsWith('/camera')) ws.on('framereceived', frame => {
      const message = JSON.parse(String(frame.payload)); if (message.type === 'frame') cameraFrames.push({ at: Date.now(), image: message.image });
    });
    if (ws.url().endsWith('/control')) {
    ws.on('framereceived', frame => { const message = JSON.parse(String(frame.payload)); if (message.type === 'video') remoteFrames.push({ ...message, at: Date.now() }); else if (message.type === 'error') failures.push(message.message); });
    ws.on('close', () => controlClosed.push(Date.now()));
  } });
  await page.goto(origin);
  await page.locator('input[name="username"]').fill(user.username); await page.locator('input[name="password"]').fill(password);
  await page.getByRole('button', { name: /sign in|log in|anmelden/i }).click();
  await page.getByRole('link', { name: `Open console for ${account.name}`, exact: true }).click();
  await page.getByRole('button', { name: 'Live Cam', exact: true }).click();
  const image = page.getByAltText('Liveansicht des Minecraft-Accounts'); await image.waitFor({ state: 'visible', timeout: 35000 });
  await wait(() => cameraFrames.length >= 2 && transfers >= 36);
  const cameraStart = Date.now(), cameraBefore = cameraFrames.length, salesBefore = sales.length;
  await new Promise(resolve => setTimeout(resolve, 6500));
  const liveFps = (cameraFrames.length - cameraBefore) * 1000 / (Date.now() - cameraStart);
  assert.ok(liveFps >= 1, `Live camera too slow: ${liveFps}fps`);
  assert.ok(sales.length >= salesBefore + 2, 'Selling stalled with camera open');
  const cameraSales = sales.filter(at => at >= cameraStart);
  const cameraSellPeriodsMs = cameraSales.slice(1).map((at, i) => at - cameraSales[i]);
  assert.ok(cameraSellPeriodsMs.every(ms => ms <= 3000), `Camera delayed sales: ${cameraSellPeriodsMs}`);
  const { PNG } = require('pngjs');
  const pixels = PNG.sync.read(Buffer.from(cameraFrames.at(-1).image, 'base64'));
  const colors = new Set(); for (let i = 0; i < pixels.data.length; i += 64) colors.add(pixels.data.subarray(i, i + 3).toString('hex'));
  assert.ok(colors.size > 5, 'Camera returned a blank image');
  const durations = [], remoteFps = [];
  for (let run = 0; run < 2; run++) {
    delayNextPreparation = run === 0 && preparationDelayMs > 0;
    const started = Date.now(); await image.click();
    await page.getByRole('region', { name: 'Fernsteuerung', exact: true }).waitFor();
    await page.getByText('Fernsteuerung wird verbunden…', { exact: true }).waitFor({ state: 'hidden', timeout: 35000 });
    assert.deepEqual(failures, []); durations.push(Date.now() - started);
    await wait(() => remoteFrames.length > 1);
    const remoteStart = Date.now(), remoteBefore = remoteFrames.length, pausedSales = sales.length;
    await new Promise(resolve => setTimeout(resolve, 4000));
    remoteFps.push((remoteFrames.length - remoteBefore) * 1000 / (Date.now() - remoteStart));
    assert.ok(remoteFps.at(-1) >= 2, `Remote camera too slow: ${remoteFps.at(-1)}fps`);
    assert.equal(sales.length, pausedSales, 'Native selling must pause during remote control');
    const before = moves.at(-1)?.z ?? .5;
    await page.keyboard.down('w'); await new Promise(resolve => setTimeout(resolve, 400)); await page.keyboard.up('w');
    await wait(() => moves.some(move => move.z > before + .05));
    await page.keyboard.press('e'); await wait(() => remoteFrames.at(-1)?.screenOpen === true);
    await page.keyboard.press('e'); await wait(() => remoteFrames.at(-1)?.screenOpen === false);
    await page.keyboard.press('Escape'); await image.waitFor({ state: 'visible', timeout: 35000 });
    await wait(() => controlClosed.length === run + 1);
    await wait(() => sales.length > pausedSales);
  }
  assert.ok(!actions.includes('stop_sneaking') || actions.includes('start_sneaking'));
  assert.deepEqual(failures, []);
  assert.equal(preparationDelayApplied, preparationDelayMs > 0);
  console.log(JSON.stringify({ browserToNative: true, droppedItems, preparationDelayMs, preparationDelayApplied, startsMs: durations, starts: durations.length, h264Frames: remoteFrames.length,
    liveFps, remoteFps, cameraSellPeriodsMs, transfers, cameraPixels: { width: pixels.width, height: pixels.height, colors: colors.size },
    movement: true, inventoryOpenClose: true, escapeAndRestart: true, autoSellPausedDuringRemote: true, autoSellResumed: true, failures }, null, 2));
} finally {
  await browser?.close(); await clientManager.shutdownAll(); await app?.close();
  if (ids) await soulFireRpc().instance.deleteInstance({ id: ids.instanceId }).catch(() => {});
  for (const client of clients) client.end(); server.close(); await prisma.$disconnect();
  globalThis.fetch = originalFetch;
  process.chdir(root); await rm(directory, { recursive: true, force: true });
}
