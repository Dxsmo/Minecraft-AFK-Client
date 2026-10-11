import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base = new URL(process.argv[2] ?? process.env.PERF_URL ?? 'http://localhost');
if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('Supply an HTTP(S) website URL without credentials.');
const exec = promisify(execFile);
const dir = await mkdtemp(join(tmpdir(), 'mcafk-network-'));
let sequence = 0;
async function measure(url) {
  const index = sequence++;
  const bodyPath = join(dir, `${index}.body`);
  const headersPath = join(dir, `${index}.headers`);
  let output;
  let error;
  try {
    output = (await exec('curl', ['--silent', '--show-error', '--compressed', '--location',
      '--proto', '=http,https', '--proto-redir', '=http,https', '--max-time', '15',
      '--connect-timeout', '5', '--output', bodyPath, '--dump-header', headersPath,
      '--write-out', '%{json}', url.href], { maxBuffer: 64 * 1024 })).stdout;
  } catch (failure) { output = failure.stdout; error = `curl exit ${failure.code}`; }
  const metrics = JSON.parse(output || '{}');
  const headers = await readFile(headersPath, 'utf8').catch(() => '');
  const serverTiming = [...headers.matchAll(/^server-timing:\s*(.*)$/gim)].at(-1)?.[1].trim() ?? null;
  const report = { path: url.pathname, status: metrics.http_code ?? 0, error,
    dnsMs: Math.round((metrics.time_namelookup ?? 0) * 1000),
    connectMs: Math.round((metrics.time_connect ?? 0) * 1000),
    tlsMs: Math.round((metrics.time_appconnect ?? 0) * 1000),
    firstByteMs: Math.round((metrics.time_starttransfer ?? 0) * 1000),
    totalMs: Math.round((metrics.time_total ?? 0) * 1000),
    bytes: metrics.size_download ?? 0, serverTiming };
  return { report, body: await readFile(bodyPath, 'utf8').catch(() => '') };
}
try {
  const document = await measure(base);
  const assets = [...document.body.matchAll(/(?:src|href)=["']([^"']+\.(?:js|css))["']/g)]
    .map(match => new URL(match[1], base)).filter(url => url.origin === base.origin);
  const urls = [...assets, new URL('/api/health', base), new URL('/api/auth/me', base)];
  const measurements = await Promise.all(urls.map(measure));
  console.log(JSON.stringify({ origin: base.origin, measuredAt: new Date().toISOString(),
    requests: [document.report, ...measurements.map(result => result.report)] }, null, 2));
} finally { await rm(dir, { recursive: true, force: true }); }
