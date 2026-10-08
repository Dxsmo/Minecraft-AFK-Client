import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { buildApp } from "../../src/app.js";
import { prisma } from "../../src/database/prisma.js";
import { createSession, destroySession, destroyAllUserSessions } from "../../src/auth/session.js";
import { hashPassword } from "../../src/auth/password.js";
import { config } from "../../src/config/config.js";
import { clientManager } from "../../src/minecraft/ClientManager.js";
import { sniperManager } from "../../src/namesniper/SniperManager.js";
import { recordAuditLog } from "../../src/logging/auditLog.js";

let app: Awaited<ReturnType<typeof buildApp>>, url: string, passwordHash: string;
let users: {id:string;username:string}[] = [], accounts: {id:string;name:string}[] = [];
let sessions: {sessionId:string;csrfToken:string}[] = [];
const sockets: WebSocket[] = [];
const statusListeners = new Set<(status:any) => void>(), consoleListeners = new Set<(event:any) => void>(), sniperListeners = new Set<(status:any) => void>();
const sendCommand = vi.fn(() => true);
const headers = (index = 0, csrf = true) => ({ cookie: `${config.session.cookieName}=${sessions[index].sessionId}`, ...(csrf ? {"x-csrf-token": sessions[index].csrfToken} : {}) });
const snapshot = (account: {id:string;name:string}) => ({ id:account.id, name:account.name, status:"ONLINE", serverHost:"minecraft.example", serverPort:25565,
  reconnectAttempt:0, msaSignIn:{userCode:account.id === accounts[1]?.id ? "FOREIGN-SECRET-CODE" : "OWN-CODE",verificationUri:"https://microsoft.com/link"} });
const waitFor = async (check:()=>boolean|Promise<boolean>) => {
  const deadline = Date.now()+2500;
  while (!await check()) { if(Date.now()>deadline) throw Error("Security assertion timed out"); await new Promise(r=>setTimeout(r,10)); }
};
async function socket(path:string,index=0) {
  const ws = new WebSocket(url+path, {headers:{...headers(index),origin:config.publicOrigin}});
  sockets.push(ws);
  const messages:any[] = [];
  ws.on("message", raw=>messages.push(JSON.parse(raw.toString())));
  ws.on("error",()=>{});
  const closed = once(ws,"close");
  await once(ws,"open");
  return {ws,messages,closed};
}
beforeAll(async()=>{
  passwordHash = await hashPassword("security-test-password");
  vi.spyOn(clientManager,"getAllStatuses").mockImplementation(()=>accounts.map(snapshot) as any);
  vi.spyOn(clientManager,"get").mockImplementation(id=>({getStatus:()=>snapshot(accounts.find(a=>a.id===id)!),sendCommand}) as any);
  vi.spyOn(clientManager,"onStatusEvent").mockImplementation(cb=>{statusListeners.add(cb);return()=>{statusListeners.delete(cb);};});
  vi.spyOn(clientManager,"onConsoleEvent").mockImplementation(cb=>{consoleListeners.add(cb);return()=>{consoleListeners.delete(cb);};});
  vi.spyOn(sniperManager,"getAllStatuses").mockReturnValue([{id:"sniper-secret",msaSignIn:{userCode:"SNIPER-SECRET"}}] as any);
  vi.spyOn(sniperManager,"onStatusEvent").mockImplementation(cb=>{sniperListeners.add(cb);return()=>{sniperListeners.delete(cb);};});
  app = await buildApp();
  await app.listen({host:"127.0.0.1",port:0});
  url = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
beforeEach(async()=>{
  for(const ws of sockets.splice(0)) ws.terminate();
  await prisma.minecraftAccount.deleteMany({where:{id:{in:accounts.map(a=>a.id)}}});
  await prisma.user.deleteMany({where:{id:{in:users.map(u=>u.id)}}});
  users=[];accounts=[];sessions=[];sendCommand.mockClear();
  for(const role of ["USER","USER","ADMIN"] as const) {
    const user=await prisma.user.create({data:{username:"security-"+randomUUID().slice(0,8),passwordHash,role}});
    users.push(user);sessions.push(await createSession(user.id,{}));
  }
  for(const index of [0,1]) {
    const account=await prisma.minecraftAccount.create({data:{name:"Sec_"+randomUUID().slice(0,8),serverHost:"minecraft.example",createdById:users[index].id,
      credentialsSecret:"private-email@example.com",credentialsPassword:"private-minecraft-password"}});
    accounts.push(account);
    await prisma.userMinecraftAccount.create({data:{userId:users[index].id,minecraftAccountId:account.id}});
  }
});
afterAll(async()=>{
  for(const ws of sockets) ws.terminate();
  await app?.close();
  await prisma.minecraftAccount.deleteMany({where:{id:{in:accounts.map(a=>a.id)}}});
  await prisma.user.deleteMany({where:{id:{in:users.map(u=>u.id)}}});
  vi.restoreAllMocks();
});

it("rejects anonymous requests and ordinary users accessing administration",async()=>{
  const paths=["/api/users",`/api/users/${users[2].id}`,"/api/audit-logs","/api/security/ip-bans","/api/namesniper/accounts","/api/minigames/admin/dashboard"];
  for(const path of [...paths,"/api/minecraft/accounts","/api/notes","/api/system/status"]) {
    expect((await app.inject({url:path})).statusCode).toBe(401);
  }
  for(const path of paths) expect((await app.inject({url:path,headers:headers()})).statusCode).toBe(403);
  const escalation=await app.inject({method:"PATCH",url:`/api/users/${users[0].id}`,headers:headers(),payload:{role:"ADMIN"}});
  expect(escalation.statusCode).toBe(403);
  expect((await prisma.user.findUniqueOrThrow({where:{id:users[0].id}})).role).toBe("USER");
});

it("hides foreign Minecraft accounts and credentials through every operation",async()=>{
  const base=`/api/minecraft/accounts/${accounts[1].id}`;
  for(const tail of ["","/logs","/image","/earnings","/assignable-users"]) {
    expect((await app.inject({url:base+tail,headers:headers()})).statusCode).toBe(404);
  }
  for(const [method,tail,payload] of [
    ["PATCH","",{notes:"tampered"}],["DELETE","",undefined],["PUT","/assignments",{userIds:[users[0].id]}],
    ["PUT","/image",{image:"fake"}],["POST","/start",undefined],["POST","/stop",undefined],["POST","/restart",undefined],
    ["POST","/clean-spawner",undefined],["POST","/command",{command:"/home"}],
    ["POST","/assignments/lookup",{username:users[0].username}],
  ] as const) {
    const response=await app.inject({method,url:base+tail,headers:headers(),payload});
    expect([403,404]).toContain(response.statusCode);
  }
  const response=await app.inject({url:"/api/minecraft/accounts",headers:headers()});
  expect(response.json().map((a:any)=>a.id)).toEqual([accounts[0].id]);
  for(const secret of [accounts[1].id,"FOREIGN-SECRET-CODE","private-email@example.com","private-minecraft-password","passwordHash"])
    expect(response.body).not.toContain(secret);
  const me=await app.inject({url:"/api/auth/me",headers:headers()});
  expect(me.json().user).not.toHaveProperty("passwordHash");
  expect(response.headers["cache-control"]).toBe("private, no-store");
  const encodedMe=await app.inject({url:"/%61pi/auth/me",headers:headers()});
  expect(encodedMe.statusCode).toBe(200);
  expect(encodedMe.headers["cache-control"]).toBe("private, no-store");
  expect(sendCommand).not.toHaveBeenCalled();
});

it("prevents a creator with revoked access from granting themselves access again",async()=>{
  await prisma.userMinecraftAccount.deleteMany({where:{minecraftAccountId:accounts[0].id}});
  const base=`/api/minecraft/accounts/${accounts[0].id}`;
  expect((await app.inject({url:base+"/assignable-users",headers:headers()})).statusCode).toBe(404);
  expect((await app.inject({method:"POST",url:base+"/assignments/lookup",headers:headers(),payload:{username:users[1].username}})).statusCode).toBe(404);
  expect((await app.inject({method:"PUT",url:base+"/assignments",headers:headers(),payload:{userIds:[users[0].id]}})).statusCode).toBe(404);
  expect(await prisma.userMinecraftAccount.count({where:{minecraftAccountId:accounts[0].id}})).toBe(0);
});

it("looks up a single username for account sharing without listing registered users",async()=>{
  const base=`/api/minecraft/accounts/${accounts[0].id}`;
  for(const index of [0,2]) {
    expect((await app.inject({url:base+"/assignable-users",headers:headers(index)})).statusCode).toBe(404);
    const found=await app.inject({method:"POST",url:base+"/assignments/lookup",headers:headers(index),payload:{username:` ${users[1].username.toUpperCase()} `}});
    expect(found.statusCode).toBe(200);expect(found.json()).toEqual({id:users[1].id,username:users[1].username});
  }
  expect(await prisma.userMinecraftAccount.count({where:{minecraftAccountId:accounts[0].id}})).toBe(1);
  const lookup=(username:string,index=0)=>app.inject({method:"POST",url:base+"/assignments/lookup",headers:headers(index),payload:{username}});
  expect((await lookup(users[1].username.slice(0,-1))).json()).toEqual({error:"Nicht registrierter Benutzername"});
  expect((await lookup("unregistered-user")).statusCode).toBe(404);
  expect((await lookup("")).statusCode).toBe(400);
  await prisma.userMinecraftAccount.create({data:{userId:users[1].id,minecraftAccountId:accounts[0].id}});
  expect((await lookup(users[0].username,1)).statusCode).toBe(404);
  expect((await app.inject({method:"POST",url:base+"/assignments/lookup",headers:headers(0,false),payload:{username:users[1].username}})).statusCode).toBe(403);
  expect((await app.inject({method:"POST",url:base+"/assignments/lookup",payload:{username:users[1].username}})).statusCode).toBe(401);
  expect((await app.inject({method:"POST",url:"/api/minecraft/accounts/missing/assignments/lookup",headers:headers(2),payload:{username:users[1].username}})).statusCode).toBe(404);
});

it("ignores username case during login while keeping password case significant",async()=>{
  const renamed="MiXeD-"+randomUUID().slice(0,8);
  await prisma.user.update({where:{id:users[0].id},data:{username:renamed}});
  const signIn=(username:string,password:string,index:number)=>app.inject({method:"POST",url:"/api/auth/login",remoteAddress:`198.51.100.${60+index}`,payload:{username,password}});
  for(const [index,username] of [renamed.toLowerCase(),renamed.toUpperCase(),` ${renamed} `].entries()) {
    const response=await signIn(username,"security-test-password",index);
    expect(response.statusCode).toBe(200);expect(response.json()).toMatchObject({id:users[0].id,username:renamed});
  }
  expect((await signIn(renamed,"SECURITY-TEST-PASSWORD",4)).statusCode).toBe(401);
  expect((await signIn("' OR 1=1 --","security-test-password",5)).statusCode).toBe(401);
  await prisma.user.update({where:{id:users[0].id},data:{status:"DISABLED"}});
  expect((await signIn(renamed.toLowerCase(),"security-test-password",6)).statusCode).toBe(401);
});

it("rejects ambiguous legacy usernames instead of selecting another user's account",async()=>{
  const duplicate=await prisma.user.create({data:{username:users[0].username.toUpperCase(),passwordHash}});
  try {
    const response=await app.inject({method:"POST",url:"/api/auth/login",remoteAddress:"198.51.100.70",payload:{username:users[0].username,password:"security-test-password"}});
    expect(response.statusCode).toBe(401);expect(response.json()).toEqual({error:"Invalid username or password"});
    expect(response.headers["set-cookie"]).toBeUndefined();
  } finally {await prisma.user.delete({where:{id:duplicate.id}});}
});

it("requires CSRF for state changes and rejects requests from untrusted origins",async()=>{
  for(const [path,payload] of [["/api/auth/logout",undefined],["/api/notes",{}],["/api/auth/change-password",{currentPassword:"security-test-password",newPassword:"another-password"}]] as const) {
    expect((await app.inject({method:"POST",url:path,headers:headers(0,false),payload})).statusCode).toBe(403);
  }
  for(const origin of ["https://evil.example","null",config.publicOrigin+".evil.example"])
    expect((await app.inject({method:"POST",url:"/api/notes",headers:{...headers(),origin},payload:{}})).statusCode).toBe(403);
  expect((await app.inject({url:"/api/auth/me",headers:headers()})).statusCode).toBe(200);
});

it("uses generic login failures and creates an opaque HttpOnly session cookie",async()=>{
  for(const username of [users[0].username,"unknown-security-user"]) {
    const response=await app.inject({method:"POST",url:"/api/auth/login",remoteAddress:"198.51.100.30",payload:{username,password:"wrong-password"}});
    expect(response.statusCode).toBe(401);expect(response.json()).toEqual({error:"Invalid username or password"});
    expect(response.headers["set-cookie"]).toBeUndefined();
  }
  const response=await app.inject({method:"POST",url:"/api/auth/login",remoteAddress:"198.51.100.31",payload:{username:users[0].username,password:"security-test-password"}});
  expect(response.statusCode).toBe(200);expect(response.body).not.toContain(passwordHash);
  const cookies=response.headers["set-cookie"] as string[];
  const sessionCookie=cookies.find(cookie=>cookie.startsWith(config.session.cookieName+"="))!;
  expect(sessionCookie).toContain("HttpOnly");expect(sessionCookie).toContain("SameSite=Lax");
  expect(sessionCookie.includes("Secure")).toBe(config.session.cookieSecure);
  expect(response.headers["cache-control"]).toBe("private, no-store");
});

it("cannot bypass the login rate limit with forged forwarding headers from a public client",async()=>{
  const responses=[];
  for(let index=0;index<=config.loginRateLimit.max;index++) responses.push(await app.inject({method:"POST",url:"/api/auth/login",remoteAddress:"198.51.100.32",
    headers:{"x-forwarded-for":`203.0.113.${index+1}`,"x-real-ip":`203.0.113.${index+1}`},payload:{username:users[0].username,password:"wrong-password"}}));
  expect(responses.slice(0,-1).map(r=>r.statusCode)).toEqual(Array(config.loginRateLimit.max).fill(401));
  expect(responses.at(-1)!.statusCode).toBe(429);
});

it("filters the initial dashboard snapshot and live events, including Microsoft sign-in codes",async()=>{
  const connection=await socket("/ws/dashboard");
  await waitFor(()=>connection.messages.some(m=>m.type==="statuses"));
  expect(connection.messages[0].statuses.map((s:any)=>s.id)).toEqual([accounts[0].id]);
  for(const listener of statusListeners) listener(snapshot(accounts[1]));
  for(const listener of statusListeners) listener({...snapshot(accounts[0]),health:13});
  await waitFor(()=>connection.messages.some(m=>m.status?.health===13));
  expect(JSON.stringify(connection.messages)).not.toContain("FOREIGN-SECRET-CODE");
  expect(JSON.stringify(connection.messages)).not.toContain(accounts[1].id);
  const admin=await socket("/ws/dashboard",2);
  await waitFor(()=>admin.messages.some(m=>m.type==="statuses"));
  expect(admin.messages[0].statuses).toHaveLength(2);
});

it("rejects missing, null and foreign origins for cookie-authenticated sockets",async()=>{
  for(const path of ["/ws/dashboard","/ws/%64ashboard",`/ws/%61ccounts/${accounts[0].id}`,"/ws/%6eamesniper-dashboard"])
  for(const origin of [undefined,"null","https://evil.example",config.publicOrigin+".evil.example"]) {
    const ws=new WebSocket(url+path,{headers:{...headers(),...(origin?{origin}:{})}});sockets.push(ws);
    const error=await once(ws,"error");expect(String(error[0])).toContain("403");
  }
});

it("rejects unauthenticated, foreign account and non-admin sniper sockets",async()=>{
  const anonymous=new WebSocket(url+"/ws/dashboard",{headers:{origin:config.publicOrigin}});sockets.push(anonymous);
  expect((await once(anonymous,"close"))[0]).toBe(4401);
  for(const path of [`/ws/accounts/${accounts[1].id}`,"/ws/namesniper-dashboard","/ws/namesniper/secret-account"]) {
    const connection=await socket(path);expect((await connection.closed)[0]).toBe(4401);expect(connection.messages).toEqual([]);
  }
});

it("validates WebSocket commands, CSRF and current account access before sending them",async()=>{
  const connection=await socket(`/ws/accounts/${accounts[0].id}`);
  await waitFor(()=>connection.messages.some(m=>m.type==="history"));
  connection.ws.send(JSON.stringify({type:"command",command:"/home"}));
  await waitFor(()=>connection.messages.some(m=>m.reason==="INVALID_CSRF"));expect(sendCommand).not.toHaveBeenCalled();
  connection.ws.send(JSON.stringify({type:"command",command:"x".repeat(257),csrfToken:sessions[0].csrfToken}));
  await waitFor(()=>connection.messages.some(m=>m.reason==="INVALID_MESSAGE"));expect(sendCommand).not.toHaveBeenCalled();
  connection.ws.send(JSON.stringify({type:"command",command:"/home",csrfToken:sessions[0].csrfToken}));
  await waitFor(()=>sendCommand.mock.calls.length===1);expect(sendCommand).toHaveBeenCalledWith("/home");
  await prisma.userMinecraftAccount.deleteMany({where:{minecraftAccountId:accounts[0].id}});
  connection.ws.send(JSON.stringify({type:"command",command:"/sell",csrfToken:sessions[0].csrfToken}));
  expect((await connection.closed)[0]).toBe(4401);expect(sendCommand).toHaveBeenCalledTimes(1);
});

it("stops console data after permissions are revoked",async()=>{
  const connection=await socket(`/ws/accounts/${accounts[0].id}`);
  await waitFor(()=>connection.messages.some(m=>m.type==="history"));
  await prisma.userMinecraftAccount.deleteMany({where:{minecraftAccountId:accounts[0].id}});
  for(const listener of consoleListeners) listener({minecraftAccountId:accounts[0].id,message:"REVOKED-SECRET",timestamp:new Date().toISOString(),type:"SYSTEM"});
  expect((await connection.closed)[0]).toBe(4401);
  expect(JSON.stringify(connection.messages)).not.toContain("REVOKED-SECRET");
});

it("closes idle connections immediately on logout and password/session reset",async()=>{
  const account=await socket(`/ws/accounts/${accounts[0].id}`),dashboard=await socket("/ws/dashboard");
  await destroySession(sessions[0].sessionId);
  expect((await account.closed)[0]).toBe(4401);expect((await dashboard.closed)[0]).toBe(4401);
  const admin=await socket("/ws/namesniper-dashboard",2);
  await destroyAllUserSessions(users[2].id);expect((await admin.closed)[0]).toBe(4401);
});

it("rechecks expiration and role downgrades before sending subsequent data",async()=>{
  const account=await socket(`/ws/accounts/${accounts[0].id}`);
  await waitFor(()=>account.messages.some(m=>m.type==="history"));
  await prisma.session.update({where:{id:sessions[0].sessionId},data:{expiresAt:new Date(Date.now()-1000)}});
  for(const listener of consoleListeners) listener({minecraftAccountId:accounts[0].id,message:"EXPIRED-SECRET"});
  expect((await account.closed)[0]).toBe(4401);expect(JSON.stringify(account.messages)).not.toContain("EXPIRED-SECRET");
  const admin=await socket("/ws/namesniper-dashboard",2);
  await waitFor(()=>admin.messages.some(m=>m.type==="statuses"));
  await prisma.user.update({where:{id:users[2].id},data:{role:"USER"}});
  for(const listener of sniperListeners) listener({id:"sniper-secret",message:"AFTER-DEMOTION"});
  expect((await admin.closed)[0]).toBe(4401);expect(JSON.stringify(admin.messages)).not.toContain("AFTER-DEMOTION");
});

it("bounds incoming WebSocket payloads without dispatching a command",async()=>{
  const connection=await socket(`/ws/accounts/${accounts[0].id}`);
  await waitFor(()=>connection.messages.some(m=>m.type==="history"));
  connection.ws.send("x".repeat(256*1024+1));
  expect((await connection.closed)[0]).toBe(1009);expect(sendCommand).not.toHaveBeenCalled();
  expect((await app.inject({url:"/api/health"})).statusCode).toBe(200);
});

it("redacts proxy credentials and nested passwords/tokens from stored audit logs",async()=>{
  await recordAuditLog({userId:users[2].id,action:"SECURITY_REDACTION_TEST",details:{proxies:"socks5://user:proxy-secret@host:1080",safe:"kept",nested:{newPassword:"website-secret",access_token:"oauth-secret"}}});
  const entry=await prisma.auditLog.findFirstOrThrow({where:{userId:users[2].id,action:"SECURITY_REDACTION_TEST"}});
  for(const secret of ["proxy-secret","website-secret","oauth-secret"]) expect(entry.details).not.toContain(secret);
  expect(JSON.parse(entry.details!).safe).toBe("kept");
  const legacy=await prisma.auditLog.create({data:{userId:users[2].id,action:"SNIPER_ACCOUNT_UPDATE",details:JSON.stringify({proxies:"legacy-secret",desiredName:"keep-name"})}});
  const migration=await readFile(new URL("../../prisma/migrations/20261008180000_redact_proxy_audit_secrets/migration.sql",import.meta.url),"utf8");
  await prisma.$executeRawUnsafe(migration);
  const redacted=await prisma.auditLog.findUniqueOrThrow({where:{id:legacy.id}});
  expect(JSON.parse(redacted.details!)).toEqual({proxies:"[REDACTED]",desiredName:"keep-name"});
});
