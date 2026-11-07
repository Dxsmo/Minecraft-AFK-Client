// Synthetic test only. Start a fresh, isolated SoulFire with build-emote-probe.py.
// Never install that probe on a production service or use real credentials here.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSoulFireController } from '../dist/soulfire/controller.js';
import { soulFireRpc } from '../dist/soulfire/rpc.js';
assert.ok(process.env.SOULFIRE_URL, 'Select an isolated service');
const container = process.env.AFK_TEST_CONTAINER;
assert.ok(container, 'Select the isolated container with the synthetic emote probe');
const root = await mkdtemp(path.join(os.tmpdir(), 'afk-emote-memory-'));
const mc = createRequire(import.meta.url)(process.env.MINECRAFT_PROTOCOL_MODULE || 'minecraft-protocol');
const server = mc.createServer({ host: process.env.MINECRAFT_FIXTURE_HOST ? '0.0.0.0' : '127.0.0.1', port: 0, version: '1.8.8', 'online-mode': false });
const clients = [];
server.on('playerJoin', client => {
  clients.push(client);
  client.write('login', { entityId: client.id, gameMode: 0, dimension: 0, difficulty: 1, maxPlayers: 2, levelType: 'flat', reducedDebugInfo: false });
  const chunk = Buffer.alloc(8192 + 2048 + 2048 + 256);
  chunk.fill(255, 8192 + 2048, 8192 + 2048 + 2048);
  client.write('map_chunk', { x: 0, z: 0, groundUp: true, bitMap: 1, chunkData: chunk });
  client.write('position', { x: 0.5, y: 64, z: 0.5, yaw: 0, pitch: 0, flags: 0 });
  client.write('update_health', { health: 20, food: 20, foodSaturation: 5 });
});
let controller;
try {
  execFileSync('docker', ['exec', container, 'rm', '-f', '/data/emote-probe.json']);
  await once(server, 'listening');
  controller = createSoulFireController();
  const events = []; let buffer = '';
  controller.stdout.on('data', data => {
    buffer += data;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) { events.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1); }
  });
  controller.stdin.write(JSON.stringify({ host: process.env.MINECRAFT_FIXTURE_HOST || '127.0.0.1', port: server.socketServer.address().port, username: `Emote${randomUUID().slice(0, 8)}`, auth_type: 'offline', edition: 'JAVA', account_id: randomUUID(), cache_dir: root, version: '1.8.8' }) + '\n');
  const deadline = Date.now() + 25_000;
  let result;
  while (!result) {
    const failure = events.find(event => event.type === 'connection_failed');
    if (failure) throw new Error(failure.error);
    assert.ok(Date.now() < deadline, 'The synthetic emote probe did not finish; restart its isolated container before another run');
    try { result = JSON.parse(execFileSync('docker', ['exec', container, 'cat', '/data/emote-probe.json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); } catch {}
    if (!result) await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.equal(result.attempts, 1000);
  if (process.env.EXPECT_EMOTE_LEAK === '1') {
    assert.ok(result.catalogueRequests > 900);
    assert.ok(result.retainedEmoteCallbacks > 900, 'The negative control did not reproduce the retained callback queue');
  } else {
    assert.equal(result.catalogueRequests, 0);
    assert.equal(result.retainedEmoteCallbacks, 0);
  }
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (controller && controller.exitCode === null) { const closed = once(controller, 'close'); controller.kill(); await closed; }
  try { const ids = JSON.parse(await readFile(path.join(root, 'soulfire.json'), 'utf8')); await soulFireRpc().instance.deleteInstance({ id: ids.instanceId }); } catch {}
  clients.forEach(client => client.end()); server.close(); await rm(root, { recursive: true, force: true });
}
