// Isolated latency/traffic regression. No real accounts or production servers.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createSoulFireController } from '../dist/soulfire/controller.js';
import { soulFireRpc } from '../dist/soulfire/rpc.js';
import { LIVE_CAM_OPTIONS } from '../dist/soulfire/liveCam.js';
import { fromJson } from '@bufbuild/protobuf';
import { ValueSchema } from '@bufbuild/protobuf/wkt';
assert.ok(process.env.SOULFIRE_URL && process.env.SOULFIRE_SECRET_KEY_FILE, 'Select an isolated SoulFire service');
const require = createRequire(import.meta.url);
const mc = require(process.env.MINECRAFT_PROTOCOL_MODULE || 'minecraft-protocol');
const root = await mkdtemp(path.join(tmpdir(), 'afk-camera-latency-'));
const clients = [], controllers = [], mappings = [], events = [], timers = [];
const samples = [], images = [], wire = [], failures = [];
const count = Number(process.env.AFK_LATENCY_CLIENTS || 2), duration = Number(process.env.AFK_LATENCY_SECONDS || 8);
const droppedItems = Number(process.env.AFK_LATENCY_ITEMS || 1500);
assert.ok(count >= 2 && count <= 8 && duration >= 4 && duration <= 60 && droppedItems >= 0 && droppedItems <= 10000);
let phase = 'startup', nonce = 0;
const probeTimes = new Map(), positionTimes = new Map();
const server = mc.createServer({ host: '0.0.0.0', port: 0, version: '1.8.8', 'online-mode': false, keepAlive: false });
server.on('playerJoin', client => {
  const index = clients.length; clients.push(client);
  client.on('keep_alive', ({ keepAliveId }) => {
    const entry = probeTimes.get(`${index}:${keepAliveId}`);
    if (entry) { samples.push({ bot: index, kind: 'keepAlive', phase: entry.phase, ms: performance.now() - entry.at }); probeTimes.delete(`${index}:${keepAliveId}`); }
  });
  const position = packet => {
    const id = Math.round((packet.x - .5) * 100000), key = `${index}:${id}`, entry = positionTimes.get(key);
    if (entry && Math.abs(packet.x - entry.x) < 1e-8) { samples.push({ bot: index, kind: 'gameResponse', phase: entry.phase, ms: performance.now() - entry.at }); positionTimes.delete(key); }
  };
  client.on('position', position); client.on('position_look', position);
  client.write('login', { entityId: client.id, gameMode: 0, dimension: 0, difficulty: 1, maxPlayers: count, levelType: 'flat', reducedDebugInfo: false });
  const chunk = Buffer.alloc(8192 + 2048 + 2048 + 256); chunk.fill(255, 10240, 12288); chunk.fill(1, 12288);
  for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) chunk.writeUInt16LE([1, 5, 17, 45, 48][(x + z) % 5] << 4, ((15 * 16 + z) * 16 + x) * 2);
  client.write('map_chunk', { x: 0, z: 0, groundUp: true, bitMap: 8, chunkData: chunk });
  client.write('position', { x: .5, y: 64, z: .5, yaw: 0, pitch: 20, flags: 0 });
  for (let item = 0; item < droppedItems; item++) {
    const entityId = 1000 + item;
    client.write('spawn_entity', { entityId, type: 2, x: Math.round((.5 + item % 20 / 20) * 32), y: 64 * 32, z: Math.round((.5 + Math.floor(item / 20) % 20 / 20) * 32), pitch: 0, yaw: 0, objectData: 1, velocity: { x: 0, y: 0, z: 0 } });
    client.write('entity_metadata', { entityId, metadata: [{ key: 10, type: 5, value: { blockId: 260, itemCount: 64, itemDamage: 0 } }] });
  }
  timers.push(setInterval(() => {
    const id = ++nonce; probeTimes.set(`${index}:${id}`, { phase, at: performance.now() });
    client.write('keep_alive', { keepAliveId: id });
  }, 200));
  timers.push(setInterval(() => {
    const id = ++nonce, x = .5 + id / 100000;
    positionTimes.set(`${index}:${id}`, { phase, at: performance.now(), x });
    client.write('position', { x, y: 64, z: .5, yaw: 0, pitch: 20, flags: 0 });
  }, 500));
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const wait = async check => { const until = Date.now() + 45000; while (!check()) { assert.deepEqual(failures, []); assert.ok(Date.now() < until, 'Latency fixture timed out'); await sleep(50); } };
const measure = async label => { phase = label; console.error(`Measuring ${label}`); await sleep(duration * 1000); phase = 'settling'; await sleep(500); };
const summary = values => {
  const sorted = [...values].sort((a, b) => a - b), quantile = q => sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] * 100) / 100 : null;
  return { n: sorted.length, medianMs: quantile(.5), p95Ms: quantile(.95), maxMs: quantile(1) };
};
const rpc = soulFireRpc();
let liveAbort, liveTask, remoteAbort, remoteTask, inputTimer;
try {
  await once(server, 'listening');
  for (let index = 0; index < count; index++) {
    const controller = createSoulFireController(); controllers.push(controller); events[index] = [];
    let text = ''; controller.stdout.on('data', chunk => { text += chunk; let end; while ((end = text.indexOf('\n')) >= 0) { const event = JSON.parse(text.slice(0, end)); text = text.slice(end + 1); events[index].push(event); if (event.type === 'connection_failed') failures.push(event.error); } });
    controller.stdin.write(JSON.stringify({ host: process.env.MINECRAFT_FIXTURE_HOST || 'host.docker.internal', port: server.socketServer.address().port, username: `Latency${index}_${randomUUID().slice(0, 5)}`, version: '1.8.8', edition: 'JAVA', auth_type: 'offline', cache_dir: path.join(root, String(index)), account_id: `latency-${randomUUID()}`, auto_button: 'off', crouch_enabled: true, autosell_enabled: false }) + '\n');
  }
  await wait(() => events.every(list => list.some(event => event.type === 'spawn')));
  for (let index = 0; index < count; index++) mappings.push(JSON.parse(await readFile(path.join(root, String(index), 'soulfire.json'), 'utf8')));
  await sleep(3000); await measure('idle');
  liveAbort = new AbortController();
  liveTask = (async () => {
    for await (const frame of rpc.bot.watchBotPov({ ...mappings[0], ...LIVE_CAM_OPTIONS }, { signal: liveAbort.signal, timeoutMs: 0 })) {
      const base64 = frame.render?.imageBase64 || '';
      images.push({ phase, bytes: Buffer.byteLength(base64), at: performance.now() });
    }
  })().catch(error => { if (!liveAbort.signal.aborted) failures.push(String(error)); });
  await wait(() => images.length >= 3); await sleep(1000); await measure('live');
  liveAbort.abort(); await liveTask; await sleep(1000);
  remoteAbort = new AbortController(); const sessionId = randomUUID(); let token = '', sequence = 0n, busy = false;
  await rpc.bot.updateBotConfigEntry({ ...mappings[0], namespace: 'afk-service', key: 'remote-control', value: fromJson(ValueSchema, true) });
  remoteTask = (async () => {
    for await (const frame of rpc.pov.watch({ ...mappings[0], sessionId, width: 480, height: 270, maxFps: 15, codecs: ['h264'] }, { signal: remoteAbort.signal, timeoutMs: 0 })) {
      token ||= frame.inputToken;
      if (frame.data.length) wire.push({ phase, bytes: Math.ceil(frame.data.length / 3) * 4, at: performance.now() });
    }
  })().catch(error => { if (!remoteAbort.signal.aborted) failures.push(String(error)); });
  inputTimer = setInterval(() => {
    if (!token || busy) return;
    busy = true;
    void rpc.pov.input({ sessionId, inputToken: token, sequence: ++sequence, captured: true, events: [], width: 480, height: 270, escape: false }, { signal: remoteAbort.signal, timeoutMs: 6000 })
      .catch(error => { if (!remoteAbort.signal.aborted) failures.push(String(error)); }).finally(() => { busy = false; });
  }, 500);
  await wait(() => wire.length >= 3); await sleep(1000); await measure('remote');
  clearInterval(inputTimer); remoteAbort.abort(); await remoteTask;
  await rpc.bot.updateBotConfigEntry({ ...mappings[0], namespace: 'afk-service', key: 'remote-control', value: fromJson(ValueSchema, false) });
  await sleep(1000); await measure('afterCamera');
  assert.deepEqual(failures, []);
  const result = { clients: count, droppedItems, secondsPerPhase: duration, phases: {} };
  for (const label of ['idle', 'live', 'remote', 'afterCamera']) {
    const frames = (label === 'live' ? images : wire).filter(frame => frame.phase === label);
    result.phases[label] = { bots: Array.from({ length: count }, (_, bot) => Object.fromEntries(['keepAlive', 'gameResponse'].map(kind => [kind, summary(samples.filter(sample => sample.phase === label && sample.bot === bot && sample.kind === kind).map(sample => sample.ms))]))), frames: frames.length, fps: frames.length / duration, kilobitsPerSecond: Math.round(frames.reduce((sum, frame) => sum + frame.bytes, 0) * 8 / duration / 1000) };
  }
  console.log(JSON.stringify(result, null, 2));
} finally {
  for (const timer of timers) clearInterval(timer); clearInterval(inputTimer); liveAbort?.abort(); remoteAbort?.abort();
  await Promise.allSettled([liveTask, remoteTask]);
  await Promise.all(controllers.map(async controller => { if (controller.exitCode !== null) return; const done = once(controller, 'close'); controller.kill(); await done; }));
  for (const ids of mappings) await rpc.instance.deleteInstance({ id: ids.instanceId }).catch(() => {});
  for (const client of clients) client.end(); server.close(); await rm(root, { recursive: true, force: true });
}
