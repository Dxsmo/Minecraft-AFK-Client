import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
const run=promisify(execFile),script=fileURLToPath(new URL("../../../scripts/backup-stack.sh",import.meta.url));
async function fixture(fail=false) {
  const dir=await mkdtemp(path.join(os.tmpdir(),"afk-backup-test-")),log=path.join(dir,"calls.jsonl"),output=path.join(dir,"backup");
  await writeFile(path.join(dir,"docker"),`#!/usr/bin/env node
const fs=require('node:fs'),zlib=require('node:zlib'),args=process.argv.slice(2);
fs.appendFileSync(process.env.AFK_BACKUP_TEST_LOG,JSON.stringify(args)+'\\n');
if(args.includes('ps')&&args.at(-1)==='backend')console.log('existing-backend');
if(args.includes('run')){
 if(args.includes('/soulfire-data')&&process.env.AFK_BACKUP_TEST_FAIL==='1')process.exit(3);
 process.stdout.write(zlib.gzipSync(Buffer.from(args.includes('/soulfire-data')?'soulfire-cache':'website-cache')));
}
`,{mode:0o755});
  return {dir,log,output,execute:()=>run("bash",[script,output],{env:{...process.env,PATH:`${dir}:${process.env.PATH}`,AFK_BACKUP_TEST_LOG:log,AFK_BACKUP_TEST_FAIL:fail?'1':'0'}})};
}
it("backs up both private volumes after stopping the running backend and resumes only that service",async()=>{
 const f=await fixture();try{
  await f.execute();const calls=(await readFile(f.log,"utf8")).trim().split("\n").map(line=>JSON.parse(line));
  const stop=calls.findIndex(args=>args.includes('stop')),reads=calls.map((args,index)=>args.includes('run')?index:-1).filter(index=>index>=0);
  expect(reads).toHaveLength(2);expect(reads.every(index=>index>stop)).toBe(true);
  expect(calls[stop]).toEqual(['compose','stop','backend']);expect(calls.at(-1)).toEqual(['compose','start','backend']);
  expect(gunzipSync(await readFile(path.join(f.output,'backend-data.tar.gz'))).toString()).toBe('website-cache');
  expect(gunzipSync(await readFile(path.join(f.output,'soulfire-data.tar.gz'))).toString()).toBe('soulfire-cache');
  expect((await stat(path.join(f.output,'backend-data.tar.gz'))).mode&0o777).toBe(0o600);
 }finally{await rm(f.dir,{recursive:true,force:true});}
});
it("resumes the previous services when backing up the SoulFire volume fails",async()=>{
 const f=await fixture(true);try{
  await expect(f.execute()).rejects.toMatchObject({code:3});
  const calls=(await readFile(f.log,"utf8")).trim().split("\n").map(line=>JSON.parse(line));
  expect(calls.at(-1)).toEqual(['compose','start','backend']);
  await expect(stat(path.join(f.output,'soulfire-data.tar.gz'))).rejects.toThrow();
 }finally{await rm(f.dir,{recursive:true,force:true});}
});
