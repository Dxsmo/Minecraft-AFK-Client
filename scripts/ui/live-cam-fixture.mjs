// Isolated UI lifecycle fixture. Native Java rendering is checked separately.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
export async function installLiveCamFixture(page, cameras) {
  const { PNG } = require('../../backend/node_modules/pngjs');
  const png = new PNG({ width: 640, height: 360 });
  png.data.fill(255);
  const image = PNG.sync.write(png).toString('base64');
  const user = { id: 'fixture-admin', username: 'CameraFixture', role: 'ADMIN', status: 'ACTIVE' };
  const accounts = ['JAVA', 'BEDROCK', 'JAVA'].map((edition, i) => ({
    id: `camera-${i}`, name: `CameraFixture${i}`, edition, displayName: '', authType: 'OFFLINE',
    serverHost: 'unused.invalid', serverPort: 25565, minecraftVersion: '', notes: '',
    crouchEnabled: true, autoReconnect: true, autoButton: 'OFF', autoSellEnabled: false,
    autoSellIntervalSeconds: 2, autoSellCommand: '/sell', spawnerType: '', spawnerActions: {},
    assignments: [], createdBy: user, imageUrl: null, lastSellAt: null,
    live: { id: `camera-${i}`, status: i === 2 ? 'OFFLINE' : 'ONLINE', health: 20, food: 20 },
  }));
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname;
    const account = accounts.find(account => path.endsWith(`/accounts/${account.id}`));
    let data = {};
    if (path.endsWith('/auth/login')) data = user;
    else if (path.endsWith('/auth/me')) data = { user };
    else if (path.endsWith('/profile/dashboard')) data = { initialized: true, preferences: { accountOrder: [], blurredAccountIds: [], uploaderOrder: [], collapsedUploaderIds: [] } };
    else if (path.endsWith('/users')) data = [user];
    else if (path.endsWith('/accounts')) data = accounts;
    else if (account) data = account;
    else if (path.endsWith('/earnings')) data = { last5m: 0, last1h: 0, last24h: 0 };
    else if (path.endsWith('/earnings/history')) data = { points: [], total: 0, range: '1h' };
    else if (path.endsWith('/logs')) data = [];
    await route.fulfill({ json: data });
  });
  await page.routeWebSocket('**/ws/**', socket => {
    let timer;
    if (socket.url().endsWith('/camera')) {
      const entry = { url: socket.url(), frames: 0, closed: false }; cameras.push(entry);
      timer = setInterval(() => { entry.frames++; socket.send(JSON.stringify({ type: 'frame', image })); }, 100);
      timer.unref(); // Browser teardown need not emit the fixture's close event.
      socket.onClose(() => { clearInterval(timer); entry.closed = true; });
      return;
    } else if (socket.url().endsWith('/dashboard')) socket.send(JSON.stringify({ type: 'statuses', statuses: accounts.map(account => account.live) }));
    else {
      const account = accounts.find(account => socket.url().endsWith(`/accounts/${account.id}`));
      socket.send(JSON.stringify({ type: 'history', logs: [] }));
      if (account) socket.send(JSON.stringify({ type: 'status', status: account.live }));
    }
    socket.onClose(() => clearInterval(timer));
  });
}
