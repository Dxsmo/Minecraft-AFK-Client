// Isolated test only. Requires the test-only plugin from
// soulfire/test/build-fault-plugin.py and an explicit SOULFIRE_URL.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { createSoulFireController } from '../dist/soulfire/controller.js';
import { soulFireRpc } from '../dist/soulfire/rpc.js';
import { BotDesiredState } from '@soulfiremc/sdk/generated/soulfire/bot_pb';
assert.ok(process.env.SOULFIRE_URL, 'Select an isolated service with the fault fixture');
assert.ok(process.env.AFK_TEST_CONTAINER, 'Name the isolated fault-fixture Docker container');
const startedAt=Date.now();
const mc=createRequire(import.meta.url)(process.env.MINECRAFT_PROTOCOL_MODULE||'minecraft-protocol');
const root=await mkdtemp(path.join(os.tmpdir(),'afk-disconnect-fault-'));
const controllers=[],clients=[],events=[],rpc=soulFireRpc();
const names=[`CleanupFault${randomUUID().slice(0,3)}`,`CleanupPeer${randomUUID().slice(0,3)}`];
const accountIds=[randomUUID(),randomUUID()];
const server=mc.createServer({host:process.env.MINECRAFT_FIXTURE_HOST?'0.0.0.0':'127.0.0.1',port:0,version:'1.8.8','online-mode':false});
server.on('playerJoin',client=>{
 clients.push(client);
 client.write('login',{entityId:client.id,gameMode:0,dimension:0,difficulty:1,maxPlayers:4,levelType:'flat',reducedDebugInfo:false});
 const chunk=Buffer.alloc(8192+2048+2048+256);chunk.fill(255,8192+2048,8192+2048+2048);
 client.write('map_chunk',{x:0,z:0,groundUp:true,bitMap:1,chunkData:chunk});
 client.write('position',{x:0.5,y:64,z:0.5,yaw:0,pitch:0,flags:0});
 client.write('update_health',{health:20,food:20,foodSaturation:5});
});
const waitFor=async predicate=>{
 const deadline=Date.now()+25_000;
 while(!predicate()){assert.ok(Date.now()<deadline,'The same profile failed to reconnect after a closed-channel shutdown error');await new Promise(r=>setTimeout(r,100));}
};
function start(index,port){
 const controller=createSoulFireController(), output=[];controllers.push(controller);events.push(output);
 let buffer='';controller.stdout.on('data',data=>{buffer+=data;let end;while((end=buffer.indexOf('\n'))>=0){output.push(JSON.parse(buffer.slice(0,end)));buffer=buffer.slice(end+1)}});
 controller.stdin.write(JSON.stringify({host:process.env.MINECRAFT_FIXTURE_HOST||'127.0.0.1',port,username:names[index],auth_type:'offline',edition:'JAVA',account_id:accountIds[index],cache_dir:path.join(root,String(index)),version:'1.8.8'})+'\n');
 return {controller,output};
}
try{
 await once(server,'listening');const port=server.socketServer.address().port;
 const first=start(0,port),peer=start(1,port);
 await waitFor(()=>[first,peer].every(client=>client.output.some(event=>event.type==='spawn')));
 const ids=JSON.parse(await readFile(path.join(root,'0/soulfire.json'),'utf8'));
 try{await rpc.bot.setBotsDesiredState({instanceId:ids.instanceId,botIds:[ids.botId],desiredState:BotDesiredState.STOPPED},{timeoutMs:15000});}
 catch(error){assert.match(error.message,/AFK fixture: closed-channel shutdown failure/);}
 await waitFor(()=>first.controller.exitCode!==null);
 const replacement=start(0,port);
 await waitFor(()=>replacement.output.some(event=>event.type==='spawn'));
 const replacementIds=JSON.parse(await readFile(path.join(root,'0/soulfire.json'),'utf8'));
 assert.deepEqual(replacementIds,ids,'The recovery must reuse the same instance and profile');
 assert.equal(clients.filter(client=>client.username===names[0]).length,2);
 assert.equal(clients.filter(client=>client.username===names[1]).length,1);
 assert.equal(peer.controller.exitCode,null,'Another account was stopped during recovery');
 const marker=Number(execFileSync('docker',['exec',process.env.AFK_TEST_CONTAINER,'cat','/data/afk-disconnect-fault.marker'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim());
 assert.ok(marker>=startedAt,'The test-only shutdown failure was not injected during this run');
 console.log(JSON.stringify({faultInjected:true,reconnectedSameInstance:true,reconnectedSameProfile:true,stoppedSocketlessConnectionReleased:true,affectedAccountConnections:2,unaffectedPeerConnections:1,peerRemainedOnline:true},null,2));
}finally{
 await Promise.all(controllers.map(async controller=>{if(controller.exitCode!==null||controller.signalCode!==null)return;const closed=once(controller,'close');controller.kill();await closed;}));
 for(let index=0;index<2;index++){try{const ids=JSON.parse(await readFile(path.join(root,String(index),'soulfire.json'),'utf8'));await rpc.instance.deleteInstance({id:ids.instanceId},{timeoutMs:5000});}catch{}}
 clients.forEach(client=>client.end());server.close();await rm(root,{recursive:true,force:true});
}
