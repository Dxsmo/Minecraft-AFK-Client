import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const run = promisify(execFile);
const script = fileURLToPath(new URL("../../../scripts/diagnose-disconnects.sh", import.meta.url));

it("collects bounded outage diagnostics without changing services or exposing their environment", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "afk-diagnose-"));
  const log = path.join(directory, "calls.jsonl");
  try {
    await writeFile(path.join(directory, "docker"), `#!/usr/bin/env node
const fs = require('node:fs'), args = process.argv.slice(2);
fs.appendFileSync(process.env.AFK_DIAGNOSE_TEST_LOG, JSON.stringify(args) + '\\n');
if (args.includes('ps') && args.includes('-q')) console.log('isolated-soulfire');
if (args[0] === 'inspect') console.log('OOMKilled=true RestartCount=1');
if (args[0] === 'exec') process.exit(1); // A crashed container cannot be queried.
if (args[0] === 'logs') console.log('OutOfMemoryError: Java heap space');
`, { mode: 0o755 });
    const { stdout } = await run("bash", [script, "2026-11-04T07:30:00+01:00"], {
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, AFK_DIAGNOSE_TEST_LOG: log },
    });
    const calls: string[][] = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(stdout).toContain("OOMKilled=true");
    expect(stdout).toContain("OutOfMemoryError");
    expect(calls.every(args => !args.some(arg => ["start", "stop", "restart", "up", "down", "run", "kill", "rm"].includes(arg)))).toBe(true);
    expect(calls.find(args => args[0] === "inspect")?.at(-1)).not.toMatch(/\.Config|\.Env/);
    const events = calls.find(args => args[0] === "events")!;
    expect(events).toContain("--until");
    expect(events).toContain("container=isolated-soulfire");
    const logs = calls.find(args => args[0] === "logs")!;
    expect(logs).toContain("2026-11-04T07:30:00+01:00");
    expect(logs.slice(logs.indexOf("--tail"), logs.indexOf("--tail") + 2)).toEqual(["--tail", "500"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
