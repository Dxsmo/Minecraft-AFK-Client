// Offline protocol 1.21.4 fixture: the version used by the live Java accounts.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,rm} from 'node:fs/promises';
import {once} from 'node:events';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createSoulFireController} from '../dist/soulfire/controller.js';
const require=createRequire(import.meta.url);
const modulePath=process.env.MINECRAFT_PROTOCOL_MODULE||'minecraft-protocol';
const mc=require(modulePath), data=require(require.resolve('minecraft-data',{paths:[path.dirname(require.resolve(modulePath))]}))('1.21.4');
assert.ok(process.env.SOULFIRE_URL,'Select an isolated SoulFire');
const root=await mkdtemp(path.join(os.tmpdir(),'afk-modern-'));
const server=mc.createServer({host:'0.0.0.0',port:0,version:'1.21.4','online-mode':false,registryCodec:{...data.loginPacket.dimensionCodec,'minecraft:enchantment':{id:'minecraft:enchantment',entries:[]}}});
const controllers=[],events=[],packets=[],clients=[],configs=[];
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const wait=async fn=>{const end=Date.now()+20000;while(!fn()){assert.ok(Date.now()<end,'Modern fixture timeout: '+JSON.stringify(events.flat().slice(-5)));await pause(50);}};
const teleport=(client,id)=>client.write('position',{teleportId:id,x:0.5,y:64,z:0.5,dx:0,dy:0,dz:0,yaw:0,pitch:0,flags:0});
server.on('login',client=>{client.on('packet',(p,meta)=>{if(meta.name==='settings')packets.push({clientName:client.username,type:meta.name,data:p,at:Date.now()});});});
server.on('playerJoin',client=>{
 clients.push(client);
 client.on('packet',(p,meta)=>{if(['entity_action','chat_command','chat_command_signed'].includes(meta.name))packets.push({client:clients.indexOf(client),type:meta.name,data:p,at:Date.now()});});
 client.write('login',{...data.loginPacket,entityId:client.id,enforcesSecureChat:false});
 client.write('map_chunk',{x:0,z:0,heightmaps:{type:'compound',value:{}},chunkData:Buffer.alloc(24*8),blockEntities:[],skyLightMask:[],blockLightMask:[],emptySkyLightMask:[[0,0x3ffffff]],emptyBlockLightMask:[[0,0x3ffffff]],skyLight:[],blockLight:[]});
 teleport(client,1);
 client.write('update_health',{health:20,food:20,foodSaturation:5});
});
try{
 await once(server,'listening');
 const connect=config=>{
  const c=createSoulFireController();controllers.push(c);const captured=[];events.push(captured);let buffer='';
  c.stdout.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n'))>=0){captured.push(JSON.parse(buffer.slice(0,end)));buffer=buffer.slice(end+1);}});
  c.stdin.write(JSON.stringify(config)+'\n');return c;
 };
 for(let i=0;i<2;i++){
  configs.push({host:process.env.MINECRAFT_FIXTURE_HOST||'127.0.0.1',port:server.socketServer.address().port,username:'Modern_'+randomUUID().slice(0,6),auth_type:'offline',edition:'JAVA',version:'1.21.4',cache_dir:path.join(root,''+i),crouch_enabled:i===0,auto_button:'off',autosell_enabled:false});
  connect(configs[i]);
 }
 await wait(()=>events.every(list=>list.some(e=>e.type==='spawn')));
 const start=()=>packets.filter(p=>p.client===0&&p.type==='entity_action'&&p.data.actionId==='start_sneaking');
 await wait(()=>start().length>0);
 for(const transition of ['teleport','respawn']){
  const at=Date.now();
  if(transition==='respawn')clients[0].write('respawn',{worldState:data.loginPacket.worldState,copyMetadata:3});
  teleport(clients[0],transition==='teleport'?2:3);
  controllers[0].stdin.write('{"type":"check_crouch"}\n');
  await wait(()=>start().some(p=>p.at>at));
 }
 controllers[0].stdin.write('{"type":"chat","text":"/fixture first"}\n');
 controllers[0].stdin.write('{"type":"chat","text":"/fixture first"}\n');
 await wait(()=>packets.filter(p=>p.type.startsWith('chat_command')&&p.data.command==='fixture first').length===2);
 let restarted=controllers[0];
 for(let cycle=0;cycle<2;cycle++){
  const previous=clients[cycle===0?0:cycle+1];const closed=once(previous,'end');
  restarted.kill();await closed;
  restarted=connect(configs[0]);
  const index=cycle+2;
  await wait(()=>events[index]?.some(e=>e.type==='spawn'));
  await wait(()=>packets.some(p=>p.client===index&&p.type==='entity_action'&&p.data.actionId==='start_sneaking'));
  assert.ok(!clients[1].ended,'Restarting the crouching account disconnected the other account');
 }
 assert.ok(!packets.some(p=>p.type==='entity_action'&&p.data.actionId==='stop_sneaking'));
 assert.ok(!packets.some(p=>p.client===1&&p.type==='entity_action'&&p.data.actionId==='start_sneaking'));
 assert.ok(packets.filter(p=>p.type==='settings').length>=4);
 assert.ok(packets.filter(p=>p.type==='settings').every(p=>p.data.viewDistance===4));
 console.log(JSON.stringify({protocol:'1.21.4',spawnSneak:true,teleportSneak:true,respawnSneak:true,sameAccountRestarts:2,noSyntheticRelease:true,disabledAccountNeverSneaks:true,repeatedManualCommands:2,settings:packets.filter(p=>p.type==='settings').map(p=>({client:p.client,viewDistance:p.data.viewDistance})),warnings:events.flat().filter(e=>e.type==='warning')},null,2));
}finally{
 controllers.forEach(c=>c.kill());await pause(200);server.close();await rm(root,{recursive:true,force:true});
}
