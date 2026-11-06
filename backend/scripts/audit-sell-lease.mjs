// Run against an explicitly selected isolated SoulFire + AFK extension.
// Verifies that heartbeat RPCs do not rewrite persisted account settings.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fromJson } from '@bufbuild/protobuf';
import { ValueSchema } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError } from '@connectrpc/connect';
import { AccountTypeCredentials } from '@soulfiremc/sdk/generated/soulfire/common_pb';
import { soulFireRpc } from '../dist/soulfire/rpc.js';

assert.ok(process.env.SOULFIRE_URL, 'Select an isolated SoulFire service');
const rpc = soulFireRpc();
const instance = await rpc.instance.getOrCreateInstance({ name: `lease-${randomUUID().slice(0, 24)}` });
try {
  let account;
  for await (const result of rpc.auth.loginCredentials({ instanceId: instance.id,
    service: AccountTypeCredentials.OFFLINE, payload: ['LeaseFixture'] })) {
    if (result.data.case === 'oneSuccess') account = result.data.value.account;
  }
  assert.ok(account);
  await rpc.instance.replaceInstanceAccounts({ id: instance.id, accounts: [account] });
  const ids = { instanceId: instance.id, botId: account.profileId };
  const update = (key, value, overrides = {}) => rpc.bot.updateBotConfigEntry({
    ...ids, namespace: 'afk-service', key, value: fromJson(ValueSchema, value), ...overrides,
  });
  const persisted = async () => {
    const result = await rpc.instance.getInstanceInfo({ id: instance.id });
    assert.equal(result.result.case, 'info');
    return result.result.value.config.accounts;
  };
  await update('native-auto-sell', '{"enabled":false,"intervalMs":500,"command":"/sell"}');
  const before = await persisted();
  for (let index = 0; index < 20; index++) await update('sell-lease-until', Date.now() + 15_000);
  assert.deepEqual(await persisted(), before, 'Lease renewal persisted a setting or changed ordinary configuration');
  const failsWith = code => error => ConnectError.from(error).code === code;
  await assert.rejects(update('sell-lease-until', 'invalid'), failsWith(Code.InvalidArgument));
  await assert.rejects(update('sell-lease-until', Date.now(), { botId: randomUUID() }), failsWith(Code.NotFound));
  await assert.rejects(update('sell-lease-until', Date.now(), { instanceId: randomUUID() }), failsWith(Code.NotFound));
  await update('sell-lease-until', 0);
  assert.deepEqual(await persisted(), before, 'Lease revocation persisted a setting');
  console.log(JSON.stringify({ renewals: 20, persistedLeaseWrites: 0, ordinarySettingsPreserved: true,
    invalidDeadlineRejected: true, missingBotRejected: true, missingInstanceRejected: true }, null, 2));
} finally {
  await rpc.instance.deleteInstance({ id: instance.id });
}
