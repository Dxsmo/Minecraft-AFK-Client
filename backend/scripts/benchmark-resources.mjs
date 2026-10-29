// Isolated API/backend measurements. No Minecraft connections or production DB.
import { fork, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir, cpus, totalmem, platform, arch } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import http from 'node:http';

const here = dirname(fileURLToPath(import.meta.url));
const backend = resolve(here, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const stats = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? { mean: values.reduce((a, b) => a + b, 0) / values.length,
    p95: sorted[Math.ceil(sorted.length * .95) - 1], max: sorted.at(-1) } : null;
};

function requireIsolatedDatabase() {
  if (process.env.RESOURCE_BENCH_WORKER !== 'isolated' ||
      !process.env.DATABASE_URL?.endsWith('/resource-benchmark.db')) {
    throw new Error('Worker requires its isolated database.');
  }
}

if (process.argv.includes('--seed')) {
  requireIsolatedDatabase();
  const { prisma } = await import('../dist/database/prisma.js');
  try {
    const user = await prisma.user.create({ data: {
      username: 'ResourceBenchmark', passwordHash: 'unused-fixture', role: 'ADMIN',
    } });
    let firstId;
    for (let i = 0; i < 100; i++) {
      const account = await prisma.minecraftAccount.create({ data: {
        name: `ResourceFixture${i}`, serverHost: '127.0.0.1', autoStart: false,
        assignments: { create: { userId: user.id } },
      } });
      firstId ??= account.id;
    }
    await prisma.consoleLog.createMany({ data: Array.from({ length: 20_000 }, (_, i) => ({
      minecraftAccountId: firstId, type: 'CHAT', message: `Synthetic log ${i}`,
      createdAt: new Date(Date.now() - 20_000 + i),
    })) });
  } finally {
    await prisma.$disconnect();
  }
} else if (process.argv.includes('--worker')) {
  requireIsolatedDatabase();
  const { buildApp } = await import('../dist/app.js');
  const { prisma } = await import('../dist/database/prisma.js');
  const { createSession } = await import('../dist/auth/session.js');
  const { clientManager } = await import('../dist/minecraft/ClientManager.js');
  const { persistConsoleLog, flushConsoleLogs } = await import('../dist/logging/consoleLogService.js');
  const app = await buildApp();
  await app.listen({ host: '127.0.0.1', port: 0 });
  let ids = [], phase;
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  const sampler = setInterval(() => {
    if (phase) phase.memoryMiB.push(process.memoryUsage().rss / 1024 ** 2);
  }, 1000);
  process.on('message', async message => {
    try {
      if (message.type === 'fixture') {
        const user = await prisma.user.findUniqueOrThrow({ where: { username: 'ResourceBenchmark' } });
        ids = (await prisma.minecraftAccount.findMany({ select: { id: true }, orderBy: { name: 'asc' } })).map(a => a.id);
        await clientManager.loadAll(); // All fixtures remain offline.
        const session = await createSession(user.id, {});
        process.send({ type: 'fixture', cookie: `afk_session=${session.sessionId}`, accountId: ids[0] });
      } else if (message.type === 'start') {
        loop.reset();
        phase = { name: message.name, started: performance.now(), cpu: process.cpuUsage(),
          memoryMiB: [process.memoryUsage().rss / 1024 ** 2] };
        process.send({ type: 'started' });
      } else if (message.type === 'logs') {
        await Promise.all(Array.from({ length: message.count }, (_, i) =>
          persistConsoleLog(ids[i % ids.length], 'CHAT', 'Synthetic resource benchmark')));
      } else if (message.type === 'end') {
        await flushConsoleLogs();
        const cpu = process.cpuUsage(phase.cpu);
        const elapsedMs = performance.now() - phase.started;
        process.send({ type: 'result', result: {
          name: phase.name, elapsedSeconds: elapsedMs / 1000,
          cpuPercentOneCore: (cpu.user + cpu.system) / (elapsedMs * 10),
          rssMiB: stats(phase.memoryMiB), eventLoopDelayP95Ms: loop.percentile(95) / 1e6,
          processesMeasured: 1, connectedMinecraftAccounts: 0,
        } });
        phase = undefined;
      } else if (message.type === 'stop') {
        clearInterval(sampler);
        loop.disable();
        clientManager.shutdownAll();
        await app.close();
        await prisma.$disconnect();
        process.disconnect();
      }
    } catch (error) {
      process.send({ type: 'failure', error: String(error) });
    }
  });
  process.send({ type: 'ready', port: app.server.address().port });
} else {
  const duration = Number(process.env.RESOURCE_BENCH_SECONDS ?? 30);
  if (!Number.isFinite(duration) || duration < 2 || duration > 3600) throw new Error('Invalid phase duration');
  const directory = await mkdtemp(join(tmpdir(), 'afk-resources-'));
  const env = { ...process.env, DOTENV_CONFIG_PATH: '/dev/null', NODE_ENV: 'production',
    DATABASE_URL: `file:${join(directory, 'resource-benchmark.db')}`,
    SESSION_SECRET: 'isolated-resource-benchmark-secret', SESSION_COOKIE_SECURE: 'false',
    SESSION_COOKIE_NAME: 'afk_session', INITIAL_ADMIN_PASSWORD: '', LOG_LEVEL: 'silent',
    RESOURCE_BENCH_WORKER: 'isolated', PUBLIC_ORIGIN: 'http://localhost:5173',
    CORS_ORIGINS: 'http://localhost:5173', TRUSTED_PROXIES: 'loopback' };
  const migration = spawnSync(process.execPath, [join(backend, 'node_modules/prisma/build/index.js'),
    'migrate', 'deploy', '--schema', join(backend, 'prisma/schema.prisma')],
  { cwd: directory, env, encoding: 'utf8' });
  if (migration.status !== 0) throw new Error(`Isolated migration failed: ${migration.stderr}`);
  const child = fork(fileURLToPath(import.meta.url), ['--worker'], {
    cwd: directory, env, execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const queued = [], waiters = [];
  let failure;
  child.on('error', error => { failure = error; waiters.splice(0).forEach(w => w.reject(error)); });
  child.on('exit', code => {
    if (code) { failure = new Error(`Worker exited with ${code}`); waiters.splice(0).forEach(w => w.reject(failure)); }
  });
  child.stderr.on('data', data => process.stderr.write(data));
  child.on('message', message => {
    if (message.type === 'failure') {
      failure = new Error(message.error);
      waiters.splice(0).forEach(w => w.reject(failure));
      return;
    }
    const index = waiters.findIndex(w => w.type === message.type);
    if (index < 0) queued.push(message);
    else waiters.splice(index, 1)[0].resolve(message);
  });
  function receive(type) {
    if (failure) return Promise.reject(failure);
    const index = queued.findIndex(m => m.type === type);
    if (index >= 0) return Promise.resolve(queued.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const entry = { type, resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); } };
      const timer = setTimeout(() => { waiters.splice(waiters.indexOf(entry), 1); reject(new Error(`Timeout: ${type}`)); }, 30_000);
      waiters.push(entry);
    });
  }
  const report = { measuredAt: new Date().toISOString(), scope: 'local isolated API/backend only',
    machine: { platform: platform(), arch: arch(), cpu: cpus()[0]?.model,
      logicalCpus: cpus().length, memoryGiB: totalmem() / 1024 ** 3, node: process.version },
    limitations: ['No Minecraft server connections; no per-bot capacity measurement.',
      'No Caddy, Cloudflare, browser rendering or authenticated WebSocket clients.',
      'CPU: 100% means one logical core. Load generator is a separate process.',
      'Fixture bulk insertion is performed in a separate unmeasured process.',
      'Short sequential phases; RSS includes allocator/JIT/cache retained from earlier phases.'],
    phases: [] };
  const agent = new http.Agent({ keepAlive: true, maxSockets: 20 });
  try {
    const { port } = await receive('ready');
    await sleep(3000);
    async function phase(name, load) {
      child.send({ type: 'start', name });
      await receive('started');
      console.log(`Measuring ${name} (${duration}s)`);
      const latencies = [], statuses = {}, pending = new Set();
      let sequence = 0, skippedBatches = 0, logBatches = 0;
      function request() {
        const index = sequence++;
        const start = performance.now();
        const paths = ['/api/minecraft/accounts?view=dashboard',
          `/api/minecraft/accounts/${load.accountId}/logs?limit=2000`,
          `/api/minecraft/accounts/${load.accountId}/earnings`, '/api/system/status'];
        return new Promise(resolve => {
          const req = http.get({ hostname: '127.0.0.1', port, path: paths[index % paths.length], agent,
            headers: { cookie: load.cookie, 'x-forwarded-for': `192.0.2.${1 + index % 100}` } }, res => {
            res.resume();
            res.on('end', () => { statuses[res.statusCode] = (statuses[res.statusCode] ?? 0) + 1;
              latencies.push(performance.now() - start); resolve(); });
            res.on('error', () => { statuses.error = (statuses.error ?? 0) + 1; resolve(); });
          });
          req.setTimeout(5000, () => req.destroy());
          req.on('error', () => { statuses.error = (statuses.error ?? 0) + 1; resolve(); });
        });
      }
      const timer = load && setInterval(() => {
        if (pending.size >= 20) { skippedBatches++; return; }
        for (let i = 0; i < 2; i++) {
          const work = request().finally(() => pending.delete(work));
          pending.add(work);
        }
        child.send({ type: 'logs', count: 2 });
        logBatches++;
      }, 100); // 20 HTTP requests/s and 20 synthetic persisted log lines/s.
      await sleep(duration * 1000);
      if (timer) clearInterval(timer);
      await Promise.all(pending);
      child.send({ type: 'end' });
      const { result } = await receive('result');
      if (load) Object.assign(result, { httpRequests: sequence, statuses, latencyMs: stats(latencies),
        skippedBatches, syntheticLogLines: logBatches * 2 });
      report.phases.push(result);
    }
    await phase('empty-backend-idle');
    const seed = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--seed'],
      { cwd: directory, env, encoding: 'utf8', timeout: 60_000 });
    if (seed.status !== 0) throw new Error(`Isolated fixture seeding failed: ${seed.stderr}`);
    child.send({ type: 'fixture' });
    const fixture = await receive('fixture');
    await phase('100-offline-account-records-idle');
    await phase('100-offline-records-api-and-log-load', fixture);
    child.send({ type: 'stop' });
    await new Promise((resolve, reject) => { child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Exit ${code}`))); });
    const output = resolve(process.env.RESOURCE_BENCH_OUTPUT ?? join(directory, 'report.json'));
    await writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify(report, null, 2));
    console.log(`Report: ${output}`);
    console.log(`Isolated fixtures: ${directory}`);
  } finally {
    agent.destroy();
    if (child.exitCode === null) child.kill('SIGTERM');
  }
}
