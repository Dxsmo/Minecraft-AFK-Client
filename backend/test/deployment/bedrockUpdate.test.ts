import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const run = promisify(execFile);
const script = fileURLToPath(new URL("../../../scripts/update-bedrock.sh", import.meta.url));

async function fixture(failBuild = false, nodeMajor = "24") {
  const directory = await mkdtemp(path.join(os.tmpdir(), "afk-update-"));
  const log = path.join(directory, "commands.jsonl");
  await writeFile(path.join(directory, "docker"), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const entry = { args };
if (args.includes('build')) entry.override = fs.readFileSync(args[args.lastIndexOf('-f') + 1], 'utf8');
fs.appendFileSync(process.env.AFK_UPDATE_LOG, JSON.stringify(entry) + '\\n');
if (args[0] === 'compose' && args.includes('ps') && args.includes('-q')) console.log('test-backend');
if (args[0] === 'compose' && args.includes('exec')) console.log(${JSON.stringify(nodeMajor)});
if (args[0] === 'inspect') console.log('sha256:test-image');
if (args.includes('build') && process.env.AFK_UPDATE_FAIL === '1') process.exit(3);
`, { mode: 0o755 });
  return { directory, log, execute: () => run("bash", [script], {
    env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, AFK_UPDATE_LOG: log, AFK_UPDATE_FAIL: failBuild ? "1" : "0" },
  }) };
}

it("builds the Node-only update before replacing containers and cleans up its temporary image tag", async () => {
  const f = await fixture();
  try {
    await f.execute();
    const calls = (await readFile(f.log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const build = calls.findIndex(call => call.args.includes("build"));
    const up = calls.findIndex(call => call.args.includes("up"));
    expect(build).toBeGreaterThan(0);
    expect(up).toBeGreaterThan(build);
    expect(calls[build].override).toContain("dockerfile: Dockerfile.node-update");
    expect(calls[build].args.slice(-3)).toEqual(["build", "backend", "web"]);
    expect(calls[up].args).toContain("--no-build");
    expect(calls.at(-1).args.slice(0, 2)).toEqual(["image", "rm"]);
    const dockerfile = await readFile(new URL("../../Dockerfile.node-update", import.meta.url), "utf8");
    expect(dockerfile).not.toMatch(/cargo|rustup|rust-bot\//);
    expect(dockerfile).toContain("FROM ${BACKEND_BASE_IMAGE} AS runtime");
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

it("leaves running containers untouched after a failed build", async () => {
  const f = await fixture(true);
  try {
    await expect(f.execute()).rejects.toMatchObject({ code: 3 });
    const calls = (await readFile(f.log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(calls.some(call => call.args.includes("up"))).toBe(false);
    expect(calls.at(-1).args.slice(0, 2)).toEqual(["image", "rm"]);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

it("rejects an incompatible base runtime before building or changing images", async () => {
  const f = await fixture(false, "20");
  try {
    await expect(f.execute()).rejects.toMatchObject({ code: 1 });
    const calls = (await readFile(f.log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(calls.some(call => call.args.includes("build") || call.args.includes("up") || call.args[0] === "image")).toBe(false);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
