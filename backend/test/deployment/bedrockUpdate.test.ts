import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
const run = promisify(execFile);
const script = fileURLToPath(new URL("../../../scripts/update-bedrock.sh", import.meta.url));
async function fixture(failBuild = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "afk-update-")), log = path.join(directory, "commands.jsonl");
  await writeFile(path.join(directory, "docker"), `#!/usr/bin/env node
const fs=require('node:fs'),args=process.argv.slice(2);
fs.appendFileSync(process.env.AFK_UPDATE_LOG,JSON.stringify(args)+'\\n');
if(args.includes('build')&&process.env.AFK_UPDATE_FAIL==='1')process.exit(3);
`, { mode: 0o755 });
  return { directory, log, execute: (args: string[] = []) => run("bash", [script, ...args], { env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, AFK_UPDATE_LOG: log, AFK_UPDATE_FAIL: failBuild ? "1" : "0" } }) };
}
it("builds both editions' SoulFire runtime and website before replacing containers", async () => {
  const f=await fixture(); try {
    await f.execute(); const calls=(await readFile(f.log,"utf8")).trim().split("\n").map(line=>JSON.parse(line));
    expect(calls[0]).toEqual(["compose","build","soulfire","backend","web"]);
    expect(calls[1]).toContain("--no-build"); expect(calls[1].slice(-3)).toEqual(["soulfire","backend","web"]);
    const dockerfile=await readFile(new URL("../../Dockerfile",import.meta.url),"utf8");
    expect(dockerfile).not.toMatch(/cargo|rustup|rust-bot|azalea-bot/); expect(dockerfile).toContain("COPY assets ./assets");
  } finally { await rm(f.directory,{recursive:true,force:true}); }
});
it("can recreate the runtime to clear native caches only after all builds succeed", async () => {
  const f=await fixture(); try {
    await f.execute(["--recreate"]);
    const calls=(await readFile(f.log,"utf8")).trim().split("\n").map(line=>JSON.parse(line));
    expect(calls[0]).toEqual(["compose","build","soulfire","backend","web"]);
    expect(calls[1]).toContain("--force-recreate");
    expect(calls.flat()).not.toContain("--volumes");
  } finally { await rm(f.directory,{recursive:true,force:true}); }
  const failed=await fixture(true); try {
    await expect(failed.execute(["--recreate"])).rejects.toMatchObject({code:3});
    expect((await readFile(failed.log,"utf8")).trim().split("\n")).toHaveLength(1);
  } finally { await rm(failed.directory,{recursive:true,force:true}); }
});
it("leaves running containers untouched after a failed build", async () => {
  const f=await fixture(true); try {
    await expect(f.execute()).rejects.toMatchObject({code:3});
    const calls=(await readFile(f.log,"utf8")).trim().split("\n").map(line=>JSON.parse(line));
    expect(calls).toHaveLength(1); expect(calls[0]).toContain("build");
  } finally { await rm(f.directory,{recursive:true,force:true}); }
});
