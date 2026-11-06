// Read-only; works in the current backend container without installing files:
// docker compose exec -T backend node --input-type=module - frustrieren < backend/scripts/diagnose-world-entry.mjs
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BotDesiredState, BotRuntimeState } from '@soulfiremc/sdk/generated/soulfire/bot_pb';

const failure = error => ({ error: String(error?.message || error).slice(0, 800) });
const statusSummary = status => status ? {
  desiredState: BotDesiredState[status.desiredState] ?? status.desiredState,
  runtimeState: BotRuntimeState[status.runtimeState] ?? status.runtimeState,
  updatedAt: status.updatedAt ? new Date(Number(status.updatedAt.seconds) * 1000 + status.updatedAt.nanos / 1e6).toISOString() : null,
  lastError: status.lastError?.slice(0, 800) || null,
} : null;

export async function diagnoseWorldEntry(rpc, ids, timeoutMs = 5000) {
  async function controlStatus() {
    const abort = new AbortController();
    try {
      // This snapshot is independent of the bot's game thread. getBotInfo
      // alone cannot tell a stuck game thread from an unavailable RPC service.
      for await (const frame of rpc.bot.watchBotStatuses({ instanceId: ids.instanceId }, { signal: abort.signal, timeoutMs })) {
        const event = frame.event;
        const status = event.case === 'snapshot' ? event.value.bots.find(bot => bot.profileId === ids.botId)
          : event.case === 'update' && event.value.profileId === ids.botId ? event.value : undefined;
        if (status) { abort.abort(); return statusSummary(status); }
        if (event.case === 'snapshot') return { error: 'Account fehlt im Status-Snapshot dieser Instanz' };
      }
      return { error: 'Statusstream endete ohne Accountstatus' };
    } catch (error) { return failure(error); }
    finally { abort.abort(); }
  }
  async function gameClient() {
    try {
      const result = await rpc.bot.getBotInfo(ids, { timeoutMs });
      // Never dump liveState: it includes the whole player inventory. Nor
      // should this diagnostic print account configuration or auth responses.
      return { status: statusSummary(result.status), playerPresent: !!result.liveState };
    } catch (error) { return failure(error); }
  }
  const [control, game] = await Promise.all([controlStatus(), gameClient()]);
  return { control, game };
}

async function main() {
  const name = process.argv[2];
  if (!name) throw new Error('Accountname oder Website-Account-ID als Argument angeben');
  const backend = process.argv[1] === '-' ? process.cwd() : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { PrismaClient } = await import('@prisma/client');
  const { soulFireRpc } = await import(pathToFileURL(path.join(backend, 'dist/soulfire/rpc.js')).href);
  const prisma = new PrismaClient();
  try {
    const accounts = await prisma.minecraftAccount.findMany({ select: {
      id: true, name: true, edition: true, serverHost: true, serverPort: true, minecraftVersion: true, status: true,
    } });
    const matches = accounts.filter(account => account.id === name || account.name.toLowerCase() === name.toLowerCase());
    if (matches.length !== 1) throw new Error(matches.length ? 'Mehrere Accounts mit diesem Namen; Website-Account-ID verwenden' : 'Account nicht gefunden');
    const account = matches[0];
    const stored = JSON.parse(await readFile(path.join(backend, 'data/bot-cache', account.id, 'soulfire.json'), 'utf8'));
    if (typeof stored.instanceId !== 'string' || typeof stored.botId !== 'string') throw new Error('Keine gültige SoulFire-Zuordnung vorhanden');
    const ids = { instanceId: stored.instanceId, botId: stored.botId };
    const result = await diagnoseWorldEntry(soulFireRpc(), ids);
    console.log(JSON.stringify({ checkedAt: new Date().toISOString(), account, ...ids, ...result }, null, 2));
  } finally { await prisma.$disconnect(); }
}

if (process.argv[1] === '-' || (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url)) {
  main().catch(error => { console.error(`Weltbeitritt-Diagnose fehlgeschlagen: ${failure(error).error}`); process.exitCode = 1; });
}
