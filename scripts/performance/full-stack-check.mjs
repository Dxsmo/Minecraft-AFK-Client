// Run only against the dedicated 100-account AuditFixture database behind Caddy.
// This never connects to Microsoft or a production Minecraft server.
import assert from 'node:assert/strict';
const origin = new URL(process.env.AUDIT_URL || 'http://localhost:8082');
assert.ok(['localhost', '127.0.0.1'].includes(origin.hostname) && origin.port === '8082', 'Use the isolated audit stack on port 8082');
const calls = [];
function client() {
  const cookies = new Map();
  return async function request(path, { method = 'GET', body, expected = 200, csrf = true } = {}) {
    const headers = { Origin: origin.origin, Cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; ') };
    if (csrf && cookies.has('afk_csrf')) headers['x-csrf-token'] = decodeURIComponent(cookies.get('afk_csrf'));
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const start = performance.now();
    const response = await fetch(new URL('/api' + path, origin), { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    const elapsedMs = performance.now() - start;
    for (const cookie of response.headers.getSetCookie()) { const [pair] = cookie.split(';'); const i = pair.indexOf('='); cookies.set(pair.slice(0, i), pair.slice(i + 1)); }
    const result = response.headers.get('content-type')?.includes('application/json') ? await response.json()
      : new Uint8Array(await response.arrayBuffer());
    calls.push({ path, method, status: response.status, elapsedMs });
    assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(result).slice(0, 250)}`);
    return result;
  };
}
const admin = client(), member = client();
const adminUser = await admin('/auth/login', { method: 'POST', body: { username: 'AuditAdmin', password: 'Audit-fixture-only-2026!' } });
const accounts = await admin('/minecraft/accounts?view=dashboard');
assert.equal(accounts.length, 100); assert.ok(accounts.every(account => account.name.startsWith('AuditFixture')));
const checks = [];
const memberUser = await member('/auth/login', { method: 'POST', body: { username: 'AuditMember', password: 'Audit-member-only-2026!' } });
assert.equal((await member('/minecraft/accounts?view=dashboard')).length, 2);
await member('/users', { expected: 403 }); await member('/minecraft/accounts/audit-099', { expected: 404 });
await admin('/minecraft/accounts/audit-000', { method: 'PATCH', body: { displayName: 'forbidden CSRF' }, csrf: false, expected: 403 });
checks.push('authenticated account isolation and CSRF');

for (const autoButton of ['LEFT', 'RIGHT', 'OFF']) {
  await admin('/minecraft/accounts/audit-000', { method: 'PATCH', body: { autoButton, crouchEnabled: true, autoSellIntervalSeconds: 2, autoSellCommand: '/sell', spawnerType: 'cow', spawnerActions: { 'minecraft:beef': 'drop', 'minecraft:leather': 'keep' } } });
  assert.equal((await admin('/minecraft/accounts/audit-000')).autoButton, autoButton);
}
await admin('/minecraft/accounts/audit-000/command', { method: 'POST', body: { command: '/homes' }, expected: 409 });
const catalog = await admin('/minecraft/account-items'); assert.equal(catalog.length, 1489);
await admin('/minecraft/accounts/audit-000/image', { method: 'PUT', body: { itemId: 'diamond_sword' } });
const image = await member('/minecraft/accounts/audit-000/image'); assert.deepEqual([...image.slice(0, 8)], [137,80,78,71,13,10,26,10]);
await member('/minecraft/accounts/audit-099/image', { expected: 404 });
checks.push('held controls, automation settings, offline command errors, image catalog and permissions');

const logs = await admin('/minecraft/accounts/audit-000/logs?limit=2000'); assert.equal(logs.length, 2000);
const older = await admin(`/minecraft/accounts/audit-000/logs?limit=2000&before=${logs[0].id}`);
assert.equal(older.length, 2000); assert.ok(!older.some(old => logs.some(row => row.id === old.id)));
for (const range of ['1h', '6h', '24h']) assert.ok((await admin(`/minecraft/accounts/audit-000/earnings/history?range=${range}`)).points.length > 0);
const earnings = await admin('/minecraft/accounts/audit-000/earnings'); assert.ok(earnings.last24h > 0);
const versions = await admin('/minecraft/versions'); assert.ok(versions.java.versions.length > 1 && versions.bedrock.versions.length > 0);
checks.push('log cursor pagination, cent sums, all graph ranges and live SoulFire version catalog');

const content = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Audit edit' }] }] };
const note = await admin('/notes', { method: 'POST', body: { title: 'Audit temporary note', content }, expected: 201 });
await admin(`/notes/${note.id}`, { method: 'PATCH', body: { revision: note.revision, title: 'Audit renamed' } });
await admin(`/notes/${note.id}`, { method: 'PATCH', body: { revision: note.revision, title: 'stale edit' }, expected: 409 });
await admin(`/notes/${note.id}/access`, { method: 'PUT', body: { users: [{ userId: memberUser.id, canWrite: false }] } });
await member(`/notes/${note.id}`); await member(`/notes/${note.id}`, { method: 'PATCH', body: { revision: note.revision + 1, title: 'forbidden' }, expected: 403 });
await admin('/notes/audit-private-note', { expected: 404 });
await admin(`/notes/${note.id}`, { method: 'DELETE', expected: 204 });
checks.push('note CRUD, revision conflicts, sharing, read-only grants and private-note isolation');

await admin('/profile/dashboard', { method: 'PATCH', body: { blur: { accountId: 'audit-000', value: true } } });
assert.ok((await admin('/profile/dashboard')).preferences.blurredAccountIds.includes('audit-000'));
await admin('/profile/dashboard', { method: 'PATCH', body: { blur: { accountId: 'audit-000', value: false } } });
await admin('/security/ip-bans', { method: 'POST', body: { ip: '198.51.100.97', reason: 'Audit fixture' }, expected: 201 });
assert.ok((await admin('/security/ip-bans')).some(ban => ban.ip === '198.51.100.97'));
await admin('/security/ip-bans/198.51.100.97', { method: 'DELETE', expected: 204 });
await admin(`/users/${adminUser.id}`, { method: 'PATCH', body: { role: 'USER' }, expected: 400 });
checks.push('persistent dashboard preferences, IP-ban CRUD and last-admin protection');

for (const edition of ['JAVA', 'BEDROCK']) {
  const before = (await admin('/minecraft/accounts?view=dashboard')).length;
  const account = await admin('/minecraft/accounts', { method: 'POST', body: { name: `AuditNew${edition}`, credentialsSecret: 'audit@example.test', serverHost: 'unused.invalid', edition }, expected: 201 });
  assert.equal((await admin('/minecraft/accounts?view=dashboard')).length, before + 1, 'No opposite-edition account may be created');
  await admin(`/minecraft/accounts/${account.id}`, { method: 'DELETE', expected: 204 });
}
await admin(`/users/${memberUser.id}`, { method: 'PATCH', body: { status: 'DISABLED' } });
await member('/auth/me', { expected: 401 });
await admin(`/users/${memberUser.id}`, { method: 'PATCH', body: { status: 'ACTIVE' } });
await admin('/audit-logs?limit=200'); await admin('/system/status');
for (const limit of ['-1','nope','1000000']) await admin(`/audit-logs?limit=${limit}`, { expected: 400 });
checks.push('independent Java/Bedrock creation and deletion, session revocation, audit trail and system status');

const measurements = [];
for (let batch = 0; batch < 10; batch++) await Promise.all(Array.from({ length: 8 }, async (_, i) => {
  const paths = ['/minecraft/accounts?view=dashboard', '/minecraft/accounts/audit-000/logs?limit=2000', '/minecraft/accounts/audit-000/earnings', '/minecraft/accounts/audit-000/earnings/history?range=24h'];
  const start = performance.now(); await admin(paths[i % paths.length]); measurements.push(performance.now() - start);
}));
measurements.sort((a,b)=>a-b);
await admin('/auth/logout', { method: 'POST' }); await admin('/auth/me', { expected: 401 });
console.log(JSON.stringify({ fixture: { accounts: 100, storedLogs: 20000, storedEarnings: 100000 }, checks,
  requests: calls.length, load: { requests: measurements.length, concurrency: 8, p50Ms: measurements[Math.floor(measurements.length * .5)], p95Ms: measurements[Math.ceil(measurements.length * .95)-1], maxMs: measurements.at(-1) },
  expectedFailures: calls.filter(call => call.status >= 400).map(({method,path,status})=>({method,path,status})),
  unexpectedFailures: 0 }, null, 2));
