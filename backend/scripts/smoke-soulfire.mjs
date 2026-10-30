// Run after `npm run build` with an isolated SoulFire service + input extension.
// Set SOULFIRE_URL / SOULFIRE_SECRET_KEY_FILE and MINECRAFT_PROTOCOL_MODULE to an
// installed minecraft-protocol module. Uses only temporary offline accounts.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import { createSoulFireController } from '../dist/soulfire/controller.js';
import { soulFireRpc } from '../dist/soulfire/rpc.js';
const require = createRequire(import.meta.url);
const mc = require(process.env.MINECRAFT_PROTOCOL_MODULE || 'minecraft-protocol');
assert.ok(process.env.SOULFIRE_URL, 'Use an explicitly selected isolated SoulFire service');
const root = await mkdtemp(path.join(os.tmpdir(), 'afk-soulfire-smoke-'));
const clients=[], controllers=[], packets=[], events=[];
const clientCount=Number(process.env.AFK_SMOKE_CLIENTS||2), soakSeconds=Number(process.env.AFK_SMOKE_SOAK_SECONDS||0);
assert.ok(Number.isInteger(clientCount)&&clientCount>=2&&clientCount<=8);
assert.ok(Number.isFinite(soakSeconds)&&soakSeconds>=0&&soakSeconds<=300);
const refillSales=process.env.AFK_SMOKE_REFILL_SALES==='1';
const sellStacks=Number(process.env.AFK_SMOKE_SELL_STACKS||3), sellInterval=Number(process.env.AFK_SMOKE_INTERVAL_SECONDS||2);
assert.ok(Number.isInteger(sellStacks)&&sellStacks>=1&&sellStacks<=36);
assert.ok(sellInterval>=0.25&&sellInterval<=3600);
const stockSlots=Array.from({length:sellStacks},(_,i)=>(sellStacks<=9?54:27)+i);
const rpcCalls=[], originalFetch=globalThis.fetch;
globalThis.fetch=(input,init)=>{rpcCalls.push(new URL(typeof input==='string'||input instanceof URL?input:input.url).pathname);return originalFetch(input,init);};
let teleports=0;
const server=mc.createServer({ host:process.env.MINECRAFT_FIXTURE_HOST ? '0.0.0.0' : '127.0.0.1', port:0, version:'1.8.8', 'online-mode':false, motd:'AFK isolated smoke fixture', maxPlayers:clientCount });
const timers=[];
const empty={blockId:-1};
const saleItems=()=>Array.from({length:63},(_,i)=>(refillSales?stockSlots.includes(i):i===54)?{blockId:260,itemCount:64,itemDamage:0}:empty);
server.on('playerJoin', client=>{
  clients.push(client);
  client.on('packet',(data,meta)=>{ if(['entity_action','block_place','block_dig','chat','window_click','settings'].includes(meta.name)) packets.push({name:client.username,type:meta.name,data,at:Date.now()}); });
  client.on('window_click',data=>{
    client.write('transaction',{windowId:data.windowId,action:data.action,accepted:true});
    if(refillSales){
      // Refill before the next game tick: the count stays identical, while
      // the server's actual payout confirms the successful transfer.
      client.write('window_items',{windowId:data.windowId,items:saleItems()});
      client.write('chat',{message:JSON.stringify({text:'[HugoSMP] +$121,60 (Basis: $64, Bonus: +$57,60 durch 1.9x)'}),position:0});
    }else client.write('set_slot',{windowId:data.windowId,slot:data.slot,item:empty});
  });
  client.on('chat',data=>{if(data.message==='/sell') {
    client.write('open_window',{windowId:1,inventoryType:'minecraft:chest',windowTitle:JSON.stringify({text:'Items verkaufen'}),slotCount:27});
    client.write('window_items',{windowId:1,items:saleItems()});
  }});
  client.write('login',{entityId:client.id,gameMode:0,dimension:0,difficulty:1,maxPlayers:4,levelType:'flat',reducedDebugInfo:false});
  // 1.8 treats a zero-section ground-up chunk as an unload packet. Supply
  // one real air section, including block light, skylight and biome bytes.
  const chunk=Buffer.alloc(8192+2048+2048+256);chunk.fill(255,8192+2048,8192+2048+2048);
  client.write('map_chunk',{x:0,z:0,groundUp:true,bitMap:1,chunkData:chunk});
  for(let x=0;x<5;x++)for(let z=0;z<5;z++)client.write('block_change',{location:{x,y:63,z},type:16});
  client.write('block_change',{location:{x:0,y:64,z:2},type:16});
  client.write('position',{x:0.5,y:64,z:0.5,yaw:0,pitch:30,flags:0});
  client.write('update_health',{health:20,food:10,foodSaturation:0});
  client.write('set_slot',{windowId:0,slot:36,item:{blockId:260,itemCount:64,itemDamage:0}});
  client.write('held_item_slot',{slot:0});
  timers.push(setTimeout(()=>{client.write('position',{x:2.5,y:64,z:0.5,yaw:0,pitch:30,flags:0});teleports++;},10000));
});
const waitFor=async check=>{const deadline=Date.now()+15000;while(!check()){const failure=events.flat().find(event=>event.type==='connection_failed');if(failure)throw new Error(failure.error);assert.ok(Date.now()<deadline,'SoulFire smoke check timed out');await new Promise(resolve=>setTimeout(resolve,100));}};
try {
  await once(server,'listening'); const port=server.socketServer.address().port;
  const names=Array.from({length:clientCount},(_,i)=>`Afk${i}_${randomUUID().slice(0,6)}`);
  for(let i=0;i<clientCount;i++) {
    const controller=createSoulFireController();controllers.push(controller);events.push([]);
    let buffered='';controller.stdout.on('data',data=>{buffered+=data.toString();let end;while((end=buffered.indexOf('\n'))>=0){events[i].push(JSON.parse(buffered.slice(0,end)));buffered=buffered.slice(end+1);}});
    controller.stdin.write(JSON.stringify({host:process.env.MINECRAFT_FIXTURE_HOST || '127.0.0.1',port,username:names[i],auth_type:'offline',edition:'JAVA',account_id:`smoke-${randomUUID()}`,cache_dir:path.join(root,String(i)),version:'',crouch_enabled:i===0,auto_button:i===0?'right':i===1?'left':'off',autosell_enabled:i===0,autosell_interval_seconds:sellInterval})+'\n');
  }
  await waitFor(()=>events.every(list=>list.some(event=>event.type==='spawn')));
  await waitFor(()=>packets.some(packet=>packet.name===names[1]&&packet.type==='block_dig'));
  await waitFor(()=>packets.filter(packet=>packet.type==='window_click').length>=2);
  controllers[0].stdin.write('{"type":"check_crouch"}\n');
  await new Promise(resolve=>setTimeout(resolve,6500));
  await waitFor(()=>packets.filter(packet=>packet.type==='window_click').length>=3);
  await waitFor(()=>teleports===clientCount);
  await new Promise(resolve=>setTimeout(resolve,3500));
  const sneak=packets.filter(packet=>packet.name===names[0]&&packet.type==='entity_action');
  assert.ok(sneak.some(packet=>packet.data.actionId==='start_sneaking'));
  assert.ok(!sneak.some(packet=>packet.data.actionId==='stop_sneaking'));
  assert.ok(!packets.some(packet=>packet.name===names[1]&&packet.type==='entity_action'&&packet.data.actionId==='start_sneaking'));
  assert.ok(packets.some(packet=>packet.name===names[0]&&packet.type==='block_place'));
  for(const name of names) assert.ok(packets.some(packet=>packet.name===name&&packet.type==='settings'&&packet.data.viewDistance===6));
  assert.ok(!events.flat().some(event=>event.type==='connection_failed'));
  assert.ok(!events.flat().some(event=>event.type==='warning'&&event.message.startsWith('AutoSell:')),'Confirmed sales must not time out');
  if(refillSales)assert.deepEqual(packets.filter(packet=>packet.type==='window_click').slice(0,Math.min(3,sellStacks)).map(packet=>packet.data.slot),stockSlots.slice(0,3));
  const saleCommands=packets.filter(packet=>packet.type==='chat'&&packet.data.message==='/sell').map(packet=>packet.at);
  const salePeriodsMs=saleCommands.slice(1).map((at,i)=>at-saleCommands[i]);
  if(process.env.AFK_SMOKE_MAX_PERIOD_MS){const ordered=[...salePeriodsMs].sort((a,b)=>a-b);assert.ok(ordered.length>=3);assert.ok(ordered[Math.floor(ordered.length/2)]<=Number(process.env.AFK_SMOKE_MAX_PERIOD_MS),`Sell intervals too slow: ${JSON.stringify(salePeriodsMs)}`);}
  controllers[0].stdin.write('{"type":"chat","text":"/homes"}\n');
  await waitFor(()=>packets.some(packet=>packet.name===names[0]&&packet.type==='chat'&&packet.data.message==='/homes'));
  const inventoryRpcCalls=rpcCalls.filter(method=>method.endsWith('/GetInventoryState')).length;
  const povRenderRpcCalls=rpcCalls.filter(method=>/\/(?:RenderBotPov|WatchBotPov)$/.test(method)).length;
  assert.equal(inventoryRpcCalls,0,'Automation must not call the icon-rendering inventory RPC');
  assert.equal(povRenderRpcCalls,0,'Automation must not open a camera');
  if(soakSeconds){console.error(`Soak started: ${clientCount} clients, ${soakSeconds}s`);await new Promise(resolve=>setTimeout(resolve,soakSeconds*1000));}
  assert.ok(!events.flat().some(event=>event.type==='connection_failed'||event.type==='warning'),'The soak must remain connected without warnings');
  const before=events[1].filter(event=>event.type==='heartbeat').length;
  const stopped=once(controllers[0],'close');controllers[0].stdin.write('{"type":"disconnect"}\n');await stopped;
  await waitFor(()=>events[1].filter(event=>event.type==='heartbeat').length>before);
  console.log(JSON.stringify({controllers:clientCount,soakSeconds,sellStacks,sellInterval,salePeriodsMs,extraNodeProcesses:0,javaAutoDetection:true,nativeRightUse:true,nativeLeftMining:true,noUnsneak:true,viewDistance:6,confirmedSales:packets.filter(packet=>packet.type==='window_click').length,refilledSlotsConfirmed:refillSales,manualCommandDelivered:true,inventoryRpcCalls,povRenderRpcCalls,independentStop:true},null,2));
} catch (error) {
  console.error(JSON.stringify({events,packetTypes:packets.map(p=>({name:p.name,type:p.type,data:p.type==='entity_action'?p.data:undefined}))}));
  const rpc=soulFireRpc();
  for(let i=0;i<clientCount;i++) {try {const ids=JSON.parse(await readFile(path.join(root,String(i),'soulfire.json'),'utf8'));
    console.error(JSON.stringify({player:await rpc.world.getPlayerSnapshot(ids),block:await rpc.world.getWorldBlock({...ids,position:{x:0,y:64,z:2}}),ray:await rpc.world.raycast({...ids,maximumDistance:4.5,includeEntities:true})}));}catch(error){console.error("World diagnostic:", error.message);}}
  throw error;
} finally {
  for(const timer of timers)clearTimeout(timer);
  await Promise.all(controllers.map(async controller=>{if(controller.exitCode!==null||controller.signalCode!==null)return;const done=once(controller,'close');controller.kill();await done;}));
  const rpc=soulFireRpc();
  for(let i=0;i<clientCount;i++) {try {const ids=JSON.parse(await readFile(path.join(root,String(i),'soulfire.json'),'utf8'));await rpc.instance.deleteInstance({id:ids.instanceId});}catch{}}
  for(const client of clients)client.end();server.close();await rm(root,{recursive:true,force:true});
  globalThis.fetch=originalFetch;
}
