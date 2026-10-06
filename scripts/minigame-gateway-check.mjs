import { createServer } from "node:http";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import assert from "node:assert/strict";

const require = createRequire(
  new URL("../backend/package.json", import.meta.url),
);
const { WebSocket, WebSocketServer } = require("ws");
const directory = await mkdtemp(join(tmpdir(), "ghgames-gateway-"));
const backend = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      path: req.url,
      authorized: req.headers.authorization === "Bearer fixture-bearer",
    }),
  );
});
const sockets = new WebSocketServer({ server: backend, path: "/ws/minigames" });
sockets.on("connection", (socket, req) =>
  socket.send(
    JSON.stringify({
      type: "FIXTURE",
      authorized: req.headers.authorization === "Bearer fixture-bearer",
    }),
  ),
);
let caddy;
let output = "";
const checks = [];
try {
  backend.listen(0, "127.0.0.1");
  await once(backend, "listening");
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  await writeFile(
    join(directory, "index.html"),
    "<html>AFK website fixture</html>",
  );
  const original = await readFile(
    new URL("../frontend/Caddyfile", import.meta.url),
    "utf8",
  );
  const config =
    `{\n admin off\n}\n` +
    original
      .replaceAll("backend:4000", `127.0.0.1:${backend.address().port}`)
      .replace("root * /srv", `root * ${directory}`);
  await writeFile(join(directory, "Caddyfile"), config);
  caddy = spawn(
    process.env.CADDY_BIN ?? "caddy",
    ["run", "--config", join(directory, "Caddyfile"), "--adapter", "caddyfile"],
    {
      env: { ...process.env, SITE_ADDRESS: `http://127.0.0.1:${port}` },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  caddy.stdout.on("data", (data) => {
    output += data;
  });
  caddy.stderr.on("data", (data) => {
    output += data;
  });
  caddy.on("error", (err) => {
    output += String(err);
  });
  const origin = `http://127.0.0.1:${port}`;
  for (let attempt = 0; ; attempt++) {
    try {
      if ((await fetch(origin + "/api/health")).ok) break;
    } catch {}
    if (attempt >= 50 || caddy.exitCode !== null)
      throw new Error("Caddy did not start: " + output);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  for (const path of [
    "/api/health",
    "/api/minigames/auth/challenge",
    "/api/minigames/auth/session",
    "/api/minigames/content",
    "/api/minigames/photos",
    "/api/minigames/photos/fixture",
  ]) {
    const response = await fetch(origin + "/ghgames" + path, {
      headers: { Authorization: "Bearer fixture-bearer" },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { path, authorized: true });
  }
  checks.push("Player API prefix removed correctly; Authorization preserved");
  for (const path of [
    "/ghgames",
    "/ghgames/",
    "/ghgames/login",
    "/ghgames/minigames",
    "/ghgames/api/auth/login",
    "/ghgames/api/minigames/admin/dashboard",
    "/ghgames/api/minigames/admin/lobbies",
    "/ghgames/api/minigames/admin/content",
    "/ghgames/api/minigames/photos/%2e%2e/admin/dashboard",
    "/ghgames/api/minigames/photos/../admin/content",
  ]) {
    const response = await fetch(origin + path);
    assert.equal(response.status, 404, path);
    assert.equal(
      (await response.text()).includes("AFK website fixture"),
      false,
    );
  }
  checks.push("Gateway does not serve website, login, or admin endpoints");
  assert.equal(
    await (await fetch(origin + "/namesniper")).text(),
    "<html>AFK website fixture</html>",
  );
  assert.deepEqual(
    await (await fetch(origin + "/api/minigames/admin/dashboard")).json(),
    { path: "/api/minigames/admin/dashboard", authorized: false },
  );
  checks.push("Existing website SPA and API routes remain unchanged");
  for (const path of ["/ws/minigames", "/ghgames/ws/minigames"]) {
    const socket = new WebSocket(origin.replace("http:", "ws:") + path, {
      headers: { Authorization: "Bearer fixture-bearer" },
    });
    const [message] = await Promise.race([
      once(socket, "message"),
      new Promise((_, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("WebSocket upgrade timed out")),
          5000,
        );
        timeout.unref();
      }),
    ]);
    assert.deepEqual(JSON.parse(message), {
      type: "FIXTURE",
      authorized: true,
    });
    socket.close();
    await once(socket, "close");
  }
  checks.push(
    "Original and gateway WebSocket upgrade with Authorization preserved",
  );
  console.log(JSON.stringify({ checks, passed: true }, null, 2));
} finally {
  if (caddy?.pid && caddy.exitCode === null && caddy.signalCode === null) {
    caddy.kill("SIGTERM");
    await once(caddy, "exit");
  }
  for (const socket of sockets.clients) socket.terminate();
  await new Promise((resolve) => sockets.close(resolve));
  await new Promise((resolve) => backend.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
