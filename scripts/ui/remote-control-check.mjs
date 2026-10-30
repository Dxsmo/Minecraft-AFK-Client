// UI input lifecycle with real H.264 frames from the isolated native fixture.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { installLiveCamFixture } from './live-cam-fixture.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
assert.ok(process.env.REMOTE_VIDEO_FIXTURE, 'Provide encoded video from audit-soulfire-actions.mjs');
const video = JSON.parse(await readFile(process.env.REMOTE_VIDEO_FIXTURE, 'utf8'));
assert.ok(video.length && video[0].keyFrame);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const cameras = [], controls = [], errors = [];
  let forceGui = false, controlFailure = false;
  page.on('pageerror', error => errors.push(error.message));
  await installLiveCamFixture(page, cameras);
  await page.addInitScript(() => {
    let locked = null;
    window.__decoded = 0;
    window.VideoDecoder = new Proxy(window.VideoDecoder, { construct(Target, args) {
      const options = args[0], output = options.output;
      options.output = frame => { window.__decoded++; output(frame); };
      window.__decoderError = options.error;
      const decoder = Reflect.construct(Target, args); window.__decoder = decoder; return decoder;
    } });
    Object.defineProperty(document, 'pointerLockElement', { get: () => locked });
    HTMLElement.prototype.requestPointerLock = function () { locked = this; queueMicrotask(() => document.dispatchEvent(new Event('pointerlockchange'))); return Promise.resolve(); };
    document.exitPointerLock = () => { locked = null; queueMicrotask(() => document.dispatchEvent(new Event('pointerlockchange'))); };
  });
  await page.routeWebSocket('**/ws/accounts/*/control', socket => {
    const entry = { inputs: [], closed: false }; controls.push(entry);
    let index = 0, timer;
    socket.onMessage(data => {
      const body = JSON.parse(data.toString()); entry.inputs.push(body);
      if (body.type === 'start' && controlFailure) {
        socket.send(JSON.stringify({ type: 'error', message: 'Native encoder unavailable (synthetic fixture)' }));
        socket.close({ code: 1011, reason: 'Control unavailable' }); return;
      }
      if (body.type === 'start') timer = setInterval(() => {
        const source = video[index % video.length];
        socket.send(JSON.stringify({ ...source, screenOpen: forceGui || source.screenOpen, timestamp: index++ * 66667 }));
      }, 70);
      timer?.unref();
      if (body.type === 'stop') { clearInterval(timer); socket.close(); }
    });
    socket.onClose(() => { clearInterval(timer); entry.closed = true; });
  });
  await page.goto(process.env.UI_URL || 'http://127.0.0.1:4173');
  await page.locator('#login-username').fill('CameraFixture');
  await page.locator('#login-password').fill('fixture-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.locator('a[href="/accounts/camera-0?tab=console"]').first().click();
  await page.getByRole('button', { name: 'Live Cam', exact: true }).click();
  const image = page.getByAltText('Liveansicht des Minecraft-Accounts');
  await image.waitFor({ state: 'visible' });
  assert.equal(controls.length, 0);
  await image.click();
  await page.getByRole('region', { name: 'Fernsteuerung', exact: true }).waitFor();
  await page.getByText('Fernsteuerung wird verbunden…', { exact: true }).waitFor({ state: 'hidden' });
  assert.equal(controls.length, 1);
  const previousFrames = await page.evaluate(() => { window.__decoder.close(); window.__decoderError(new Error("fixture decoder reset")); return window.__decoded; });
  await page.waitForFunction(previous => window.__decoded > previous, previousFrames);
  await page.keyboard.down('w'); await page.waitForTimeout(100); await page.keyboard.up('w');
  await page.keyboard.press('e'); await page.waitForTimeout(100);
  forceGui = true; await page.waitForTimeout(150);
  const box = await page.getByLabel('Minecraft fernsteuern', { exact: true }).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down(); await page.mouse.move(1, 1); await page.mouse.up(); await page.waitForTimeout(100);

  await page.keyboard.press('Escape');
  await image.waitFor({ state: 'visible' });
  await page.waitForTimeout(100);
  const events = controls[0].inputs.flatMap(input => input.events || []);
  assert.ok(events.some(event => event.kind === 0 && event.code === 87 && event.action === 1));
  assert.ok(events.some(event => event.kind === 0 && event.code === 87 && event.action === 0));
  assert.ok(events.some(event => event.kind === 0 && event.code === 69));
  assert.ok(events.some(event => event.kind === 2 && event.action === 1));
  assert.ok(events.some(event => event.kind === 2 && event.action === 0));
  assert.ok(!events.some(event => event.code === 256));
  assert.ok(controls[0].closed && controls[0].inputs.some(input => input.type === 'stop'));
  await image.click();
  await page.getByRole('region', { name: 'Fernsteuerung', exact: true }).waitFor();
  await page.evaluate(() => dispatchEvent(new Event('blur')));
  await image.waitFor({ state: 'visible' }); await page.waitForTimeout(100);
  assert.ok(controls.every(control => control.closed));
  controlFailure = true; await image.click();
  await page.getByText('Native encoder unavailable (synthetic fixture)', { exact: true }).waitFor();
  await page.waitForTimeout(100);
  assert.equal(await page.getByText('Die Fernsteuerung wurde beendet. Du kannst zur Live Cam zurückkehren.', { exact: true }).count(), 0);
  await page.keyboard.press('Escape'); await image.waitFor({ state: 'visible' });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ nativeH264Decoded: true, decoderRecovery: true, lazyControlConnection: true, keyDownAndUp: true, inventoryKey: true,
    escapeIsLocal: true, mouseReleasedOutsideImage: true, releaseOnBlur: true, nativeErrorPreservedAfterClose: true, pageErrors: errors }, null, 2));
} finally { await browser.close(); }
