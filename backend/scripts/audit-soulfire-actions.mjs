// Native RPC/game-packet regression using temporary offline accounts only.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createSoulFireController } from '../dist/soulfire/controller.js';
import { soulFireRpc } from '../dist/soulfire/rpc.js';
const require = createRequire(import.meta.url);
const mc = require(process.env.MINECRAFT_PROTOCOL_MODULE || 'minecraft-protocol');
assert.ok(process.env.SOULFIRE_URL, 'Select an isolated SoulFire service');
const accountId = `actions-${randomUUID()}`;
const root = await mkdtemp(path.join(tmpdir(), 'afk-actions-'));
const host = process.env.MINECRAFT_FIXTURE_HOST || '127.0.0.1';
const server = mc.createServer({ host: host === '127.0.0.1' ? host : '0.0.0.0', port: 0, version: '1.8.8', 'online-mode': false });
const empty = { blockId: -1 }, events = [], clicks = [], commands = [], clients = [];
let movementPackets = 0, lastZ = 0.5, lastYaw = 0;
const controller = createSoulFireController();
let pending = '', spawnerOpen = false, stock;
const sneakActions = [];
const item = (id, name, lore = []) => ({ blockId: id, itemCount: 64, itemDamage: 0, nbtData: { type: 'compound', name: '', value: {
  display: { type: 'compound', value: { Name: { type: 'string', value: name }, Lore: { type: 'list', value: { type: 'string', value: lore } } } },
} } });
const wait = async predicate => {
  const deadline = Date.now() + 20_000;
  while (!predicate()) {
    const failed = events.find(event => event.type === 'connection_failed' || event.type === 'warning');
    assert.ok(!failed, JSON.stringify(failed)); assert.ok(Date.now() < deadline, 'Native action fixture timed out');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
};
const send = message => controller.stdin.write(JSON.stringify(message) + '\n');
controller.stdout.on('data', data => {
  pending += data.toString(); let end;
  while ((end = pending.indexOf('\n')) >= 0) { events.push(JSON.parse(pending.slice(0, end))); pending = pending.slice(end + 1); }
});
server.on('playerJoin', client => {
  clients.push(client);
  client.on('position', data => { movementPackets++; lastZ = data.z; });
  client.on('position_look', data => { movementPackets++; lastZ = data.z; lastYaw = data.yaw; });
  client.on('look', data => { lastYaw = data.yaw; });
  client.on('entity_action', action => sneakActions.push(action.actionId));
  client.on('chat', ({ message }) => {
    commands.push(message);
    if (message === '/sellmulti') {
      client.write('open_window', { windowId: 2, inventoryType: 'minecraft:chest', windowTitle: JSON.stringify({ text: 'SELL MULTI' }), slotCount: 9 });
      client.write('window_items', { windowId: 2, items: Array.from({ length: 45 }, (_, i) => i < 9
        ? item(260, `Category ${i}`, ['Aktueller Multiplikator: 2x', 'Fortschritt: 50$/100$ - 50%']) : empty) });
    }
  });
  client.on('block_place', () => {
    if (spawnerOpen) return; spawnerOpen = true;
    stock = [item(363, 'Beef'), item(363, 'Beef'), item(334, 'Leather'), item(334, 'Leather'), item(352, 'Bone'), item(352, 'Bone'), item(388, 'Verkaufen'), item(264, 'Keep')];
    client.write('open_window', { windowId: 3, inventoryType: 'minecraft:chest', windowTitle: JSON.stringify({ text: 'Spawner' }), slotCount: 27 });
    client.write('window_items', { windowId: 3, items: Array.from({ length: 63 }, (_, i) => stock[i] ?? empty) });
  });
  client.on('window_click', click => {
    clicks.push(click); client.write('transaction', { windowId: click.windowId, action: click.action, accepted: true });
    if (click.windowId !== 3) return;
    if (click.mode === 4) { assert.ok([0, 2].includes(click.slot), 'A retained or foreign item was dropped'); stock[click.slot] = empty; }
    else if (click.slot === 6) stock[4] = empty;
    else assert.fail('Unexpected spawner action');
    client.write('window_items', { windowId: 3, items: Array.from({ length: 63 }, (_, i) => stock[i] ?? empty) });
  });
  client.write('login', { entityId: client.id, gameMode: 0, dimension: 0, difficulty: 1, maxPlayers: 4, levelType: 'flat', reducedDebugInfo: false });
  const chunk = Buffer.alloc(8192 + 2048 + 2048 + 256); chunk.fill(255, 10240, 12288);
  client.write('map_chunk', { x: 0, z: 0, groundUp: true, bitMap: 1, chunkData: chunk });
  for (let x = 0; x < 5; x++) for (let z = 0; z < 5; z++) client.write('block_change', { location: { x, y: 63, z }, type: 16 });
  client.write('block_change', { location: { x: 0, y: 64, z: 2 }, type: 52 << 4 });
  client.write('position', { x: 0.5, y: 64, z: 0.5, yaw: 0, pitch: 30, flags: 0 });
});
try {
  await once(server, 'listening');
  send({ host, port: server.socketServer.address().port, username: `Audit_${randomUUID().slice(0, 6)}`, auth_type: 'offline', edition: 'JAVA',
    cache_dir: root, account_id: accountId, version: '1.8.8', crouch_enabled: true, auto_button: 'off',
    spawner_type: 'cow', spawner_drop_items: ['minecraft:beef', 'minecraft:leather'], spawner_sell_items: ['minecraft:bone'] });
  await wait(() => events.some(event => event.type === 'spawn'));
  send({ type: 'read_sell_multipliers' }); await wait(() => events.some(event => event.type === 'sell_multipliers'));
  const multipliers = events.find(event => event.type === 'sell_multipliers').entries;
  assert.equal(multipliers.length, 9); assert.ok(multipliers.every(entry => entry.multiplier === '2x'));
  send({ type: 'clean_spawner' }); await wait(() => events.some(event => event.message === 'Spawner aufgeräumt; Menü geschlossen'));
  assert.deepEqual(clicks.filter(click => click.mode === 4).map(click => click.slot), [0, 2]);
  assert.equal(stock[1].blockId, 363); assert.equal(stock[3].blockId, 334); assert.equal(stock[5].blockId, 352); assert.equal(stock[7].blockId, 264);
  send({ type: 'chat', text: '/homes' }); send({ type: 'chat', text: '/tpaccept' });
  await wait(() => commands.includes('/tpaccept'));
  assert.deepEqual(commands, ['/sellmulti', '/homes', '/tpaccept']);
  assert.ok(sneakActions.includes('start_sneaking'), 'Configured sneak must reach the server');
  assert.ok(!sneakActions.includes('stop_sneaking'), 'Checks and foreground tasks must never release held sneak');
  process.env.DATABASE_URL ??= 'file:/tmp/audit-camera.db';
  process.env.SESSION_SECRET ??= 'isolated-native-camera-fixture';
  const { LiveCamStreams, LIVE_CAM_OPTIONS } = await import('../dist/soulfire/liveCam.js');
  const ids = JSON.parse(await readFile(path.join(root, 'soulfire.json'), 'utf8'));
  let upstreams = 0, cameraClosed = false;
  const cameraErrors = [], frames = [[], []];
  const camera = new LiveCamStreams(async function* (_id, signal) {
    upstreams++;
    try { yield* soulFireRpc().bot.watchBotPov({ ...ids, ...LIVE_CAM_OPTIONS }, { signal, timeoutMs: 0 }); }
    finally { cameraClosed = true; }
  });
  assert.equal(upstreams, 0);
  const viewers = frames.map(target => ({ frame: frame => target.push(frame), error: error => cameraErrors.push(String(error)) }));
  const stopFirst = camera.subscribe(ids.botId, viewers[0]);
  const stopSecond = camera.subscribe(ids.botId, viewers[1]);
  try {
    await wait(() => { assert.deepEqual(cameraErrors, []); return frames.every(target => target.length >= 2); });
    assert.equal(upstreams, 1);
    const png = Buffer.from(frames[0][0].image, 'base64');
    assert.deepEqual([...png.subarray(0, 8)], [137,80,78,71,13,10,26,10]);
    assert.equal(png.readUInt32BE(16), 480); assert.equal(png.readUInt32BE(20), 270);
    const beforeWorldChange = frames.map(target => target.length);
    clients[0].write('respawn', { dimension: -1, difficulty: 1, gamemode: 0, levelType: 'flat' });
    await new Promise(resolve => setTimeout(resolve, 150));
    clients[0].write('respawn', { dimension: 0, difficulty: 1, gamemode: 0, levelType: 'flat' });
    const freshChunk = Buffer.alloc(8192 + 2048 + 2048 + 256); freshChunk.fill(255, 10240, 12288);
    clients[0].write('map_chunk', { x: 0, z: 0, groundUp: true, bitMap: 1, chunkData: freshChunk });
    for (let x = 0; x < 5; x++) for (let z = 0; z < 5; z++) clients[0].write('block_change', { location: { x, y: 63, z }, type: 16 });
    clients[0].write('position', { x: 0.5, y: 64, z: 0.5, yaw: 0, pitch: 30, flags: 0 });
    await wait(() => frames.every((target, i) => target.length >= beforeWorldChange[i] + 2));
    stopFirst(); assert.equal(cameraClosed, false);
    stopSecond(); await wait(() => cameraClosed);
    assert.equal(upstreams, 1);
  } finally { stopFirst(); stopSecond(); await camera.close(); }
  const { config: websiteConfig } = await import('../dist/config/config.js');
  const { RemoteControlSession } = await import('../dist/soulfire/remoteControl.js');
  const mappingDir = path.join(websiteConfig.dataDir, 'bot-cache', accountId);
  await mkdir(mappingDir, { recursive: true }); await writeFile(path.join(mappingDir, 'soulfire.json'), JSON.stringify(ids));
  const video = [], remoteErrors = [];
  const remote = new RemoteControlSession(accountId, message => { video.push(message); return true; }, error => remoteErrors.push(error));
  let heartbeat;
  try {
    await remote.start();
    heartbeat = setInterval(() => remote.input({ type: 'input', captured: true, events: [] }), 500);
    await wait(() => { assert.deepEqual(remoteErrors, []); return video.length >= 2; });
    assert.ok(video.some(frame => frame.keyFrame && frame.codec.startsWith('avc1.')));
    assert.ok(!JSON.stringify(video).includes('inputToken'));
    const before = lastZ;
    remote.input({ type: 'input', captured: true, events: [{ kind: 0, code: 87, action: 1, modifiers: 0, x: 0, y: 0, relative: false, key: 'w' }] });
    await wait(() => lastZ > before + 0.05);
    remote.input({ type: 'input', captured: true, events: [
      { kind: 0, code: 87, action: 0, modifiers: 0, x: 0, y: 0, relative: false, key: 'w' },
      { kind: 0, code: 69, action: 1, modifiers: 0, x: 0, y: 0, relative: false, key: 'e' },
      { kind: 0, code: 69, action: 0, modifiers: 0, x: 0, y: 0, relative: false, key: 'e' },
    ] });
    await wait(() => video.some(frame => frame.screenOpen));
    remote.input({ type: 'input', captured: true, events: [
      { kind: 0, code: 69, action: 1, modifiers: 0, x: 0, y: 0, relative: false, key: 'e' },
      { kind: 0, code: 69, action: 0, modifiers: 0, x: 0, y: 0, relative: false, key: 'e' },
    ] });
    const openAt = video.length;
    await wait(() => video.slice(openAt).some(frame => !frame.screenOpen));
    const yawBefore = lastYaw;
    remote.input({ type: 'input', captured: true, events: [{ kind: 3, code: 0, action: 0, modifiers: 0, x: 60, y: 0, relative: true }] });
    await wait(() => Math.abs(lastYaw - yawBefore) > 1);
    // Opening the command chat and typing /afk must be blocked natively too.
    const key = (code, action, logical) => ({ kind: 0, code, action, modifiers: 0, x: 0, y: 0, relative: false, key: logical });
    remote.input({ type: 'input', captured: true, events: [key(47, 1, '/'), key(47, 0, '/')] });
    await new Promise(resolve => setTimeout(resolve, 150));
    remote.input({ type: 'input', captured: true, events: [
      ...[97,102,107].map(code => ({ kind: 1, code, action: 0, modifiers: 0, x: 0, y: 0, relative: false })),
      key(257, 1, 'Enter'), key(257, 0, 'Enter'),
    ] });
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.ok(!commands.some(command => /^\/afk/i.test(command)));
    if (process.env.AFK_REMOTE_VIDEO_FILE) await writeFile(process.env.AFK_REMOTE_VIDEO_FILE, JSON.stringify(video.slice(0, 10)));

  } finally { clearInterval(heartbeat); await remote.stop(); await rm(mappingDir, { recursive: true, force: true }); }
  console.log(JSON.stringify({ nativeRemoteControl: { h264Frames: video.length, movement: true, mouseLook: true, inventory: true, afkBlocked: true, released: true },
    nativeCamera: { width: 480, height: 270, sharedUpstreams: upstreams, viewerFrames: frames.map(target => target.length), stoppedAfterLastViewer: cameraClosed, survivedWorldChange: true },
    sneakPreserved: true, nativeMultipliers: multipliers.length, nativeSpawnerDrop: true, nativeSpawnerSell: true,
    retainedStackPerItem: true, retainedForeignItems: true, manualCommandOrder: true, warnings: 0 }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ spawnerOpen, clicks, commands, events: events.slice(-5) }));
  throw error;
} finally {
  if (controller.exitCode === null && controller.signalCode === null) { const closed = once(controller, 'close'); controller.kill(); await closed; }
  try { const ids = JSON.parse(await readFile(path.join(root, 'soulfire.json'), 'utf8')); await soulFireRpc().instance.deleteInstance({ id: ids.instanceId }); } catch {}
  for (const client of clients) client.end(); server.close(); await rm(root, { recursive: true, force: true });
}
