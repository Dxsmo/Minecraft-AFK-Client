import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { buildApp } from "../../src/app.js";
import { prisma } from "../../src/database/prisma.js";
import { createSession, destroySession, destroyAllUserSessions } from "../../src/auth/session.js";
import { hashPassword } from "../../src/auth/password.js";
import { config } from "../../src/config/config.js";
import { clientManager } from "../../src/minecraft/ClientManager.js";
import { recordAuditLog } from "../../src/logging/auditLog.js";
import { PNG } from "pngjs";

let app: Awaited<ReturnType<typeof buildApp>>, url: string, passwordHash: string;
let users: {id:string;username:string}[] = [], accounts: {id:string;name:string}[] = [];
let sessions: {sessionId:string;csrfToken:string}[] = [];
const sockets: WebSocket[] = [];
const statusListeners = new Set<(status:any) => void>(), consoleListeners = new Set<(event:any) => void>();
const sellListeners = new Set<(event: { id: string; lastSellAt: string }) => void>();
const cameraViewers = new Map<string, Set<{ frame: (frame: any) => void; error: (error: unknown) => void }>>();
const cameraSubscribe = vi.fn((id: string, viewer: { frame: (frame: any) => void; error: (error: unknown) => void }) => {
  if (!cameraViewers.has(id)) cameraViewers.set(id, new Set());
  cameraViewers.get(id)!.add(viewer);
  return () => { cameraViewers.get(id)?.delete(viewer); };
});
vi.mock("../../src/soulfire/liveCam.js", () => ({ LiveCamStreams: class {
  subscribe(id: string, viewer: any) { return cameraSubscribe(id, viewer); }
  async close() {}
} }));
vi.mock("../../src/soulfire/versions.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/soulfire/versions.js")>();
  return { ...actual, protocolOptions: vi.fn(async () => [
    { id: "RELEASE|777", displayName: "26.3", keywords: ["26.3", "777"] },
    { id: "SPECIAL|2193", displayName: "Bedrock 1.26.51", keywords: ["Bedrock 1.26.51", "2193"] },
  ]) };
});
const remoteCalls: Array<{ id: string; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; input: ReturnType<typeof vi.fn> }> = [];
let remotePreparation: Promise<void> | undefined;
vi.mock("../../src/soulfire/remoteControl.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/soulfire/remoteControl.js")>();
  return { ...actual, RemoteControlSession: class {
    start = vi.fn(async () => { await remotePreparation; }); stop = vi.fn(async () => {}); input = vi.fn();
    constructor(id: string) { remoteCalls.push({ id, start: this.start, stop: this.stop, input: this.input }); }
  } };
});
const sendCommand = vi.fn(() => true);
const headers = (index = 0, csrf = true) => ({ cookie: `${config.session.cookieName}=${sessions[index].sessionId}`, ...(csrf ? {"x-csrf-token": sessions[index].csrfToken} : {}) });
const snapshot = (account: {id:string;name:string}) => ({ id:account.id, name:account.name, status:"ONLINE", serverHost:"minecraft.example", serverPort:25565,
  msaSignIn:{userCode:account.id === accounts[1]?.id ? "FOREIGN-SECRET-CODE" : "OWN-CODE",verificationUri:"https://microsoft.com/link"} });
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
  vi.spyOn(clientManager,"onSellEvent").mockImplementation(cb=>{sellListeners.add(cb);return()=>{sellListeners.delete(cb);};});
  app = await buildApp();
  await app.listen({host:"127.0.0.1",port:0});
  url = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
beforeEach(async()=>{
  for(const ws of sockets.splice(0)) ws.terminate();
  await prisma.minecraftAccount.deleteMany({where:{id:{in:accounts.map(a=>a.id)}}});
  await prisma.user.deleteMany({where:{id:{in:users.map(u=>u.id)}}});
  users=[];accounts=[];sessions=[];sendCommand.mockClear();cameraSubscribe.mockClear();cameraViewers.clear();remoteCalls.length=0;
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

it("bounds audit-log reads and rejects malformed limits before running the database query", async () => {
  for (const limit of ["-1", "0", "1.5", "nope", "1000000"]) {
    const response = await app.inject({ method: "GET", url: `/api/audit-logs?limit=${limit}`, headers: headers(2) });
    expect(response.statusCode).toBe(400);
  }
  expect((await app.inject({ method: "GET", url: "/api/audit-logs?limit=10", headers: headers(2) })).statusCode).toBe(200);
});

it("rejects anonymous requests and ordinary users accessing administration",async()=>{
  const paths=["/api/users",`/api/users/${users[2].id}`,"/api/audit-logs","/api/security/ip-bans"];
  for(const path of [...paths,"/api/minecraft/accounts","/api/notes","/api/system/status"]) {
    expect((await app.inject({url:path})).statusCode).toBe(401);
  }
  for(const path of paths) expect((await app.inject({url:path,headers:headers()})).statusCode).toBe(403);
  const escalation=await app.inject({method:"PATCH",url:`/api/users/${users[0].id}`,headers:headers(),payload:{role:"ADMIN"}});
  expect(escalation.statusCode).toBe(403);
  expect((await prisma.user.findUniqueOrThrow({where:{id:users[0].id}})).role).toBe("USER");
});

it("provides authenticated users with the installed Bedrock version catalogue", async () => {
  expect((await app.inject({ url: "/api/minecraft/versions" })).statusCode).toBe(401);
  const response = await app.inject({ url: "/api/minecraft/versions", headers: headers() });
  expect(response.statusCode).toBe(200);
  const { bedrock } = response.json();
  expect(bedrock.defaultVersion).toBe("1.26.51");
  expect(bedrock.versions[0]).toBe("1.26.51");
  expect(bedrock.versions).toEqual(["1.26.51"]);
  expect(response.json().java.versions).toEqual(["26.3"]);
  expect(bedrock.versions).not.toContain("26.2");
  expect(bedrock.versions).not.toContain("1.26.60");
  expect(new Set(bedrock.versions).size).toBe(bedrock.versions.length);
});

it("serves user-category skin heads only to admins, including users with no uploads", async () => {
  const path = `/api/users/${users[1].id}/avatar`;
  expect((await app.inject({ url: path })).statusCode).toBe(401);
  expect((await app.inject({ url: path, headers: headers() })).statusCode).toBe(403);
  expect((await app.inject({ url: path, headers: headers(2) })).statusCode).toBe(404);
  await prisma.user.update({ where: { id: users[1].id }, data: { minecraftUsername: "CategorySkin" } });
  await prisma.minecraftAccount.delete({ where: { id: accounts[1].id } });
  const request = vi.fn().mockResolvedValue(new Response(new Uint8Array(PNG.sync.write(new PNG({ width: 32, height: 32 }))), { headers: { "content-type": "image/png" } }));
  vi.stubGlobal("fetch", request);
  try {
    const response = await app.inject({ url: path, headers: headers(2) });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("image/png");
    expect(PNG.sync.read(response.rawPayload).width).toBe(32);
    expect(request).toHaveBeenCalledExactlyOnceWith("https://mc-heads.net/avatar/CategorySkin/32", expect.anything());
    expect((await app.inject({ url: `/api/users/missing/avatar`, headers: headers(2) })).statusCode).toBe(404);
  } finally { vi.unstubAllGlobals(); }
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
  for(const listener of statusListeners) listener({...snapshot(accounts[0]),name:"Updated-owned-account"});
  await waitFor(()=>connection.messages.some(m=>m.status?.name==="Updated-owned-account"));
  expect(JSON.stringify(connection.messages)).not.toContain("FOREIGN-SECRET-CODE");
  expect(JSON.stringify(connection.messages)).not.toContain(accounts[1].id);
  const admin=await socket("/ws/dashboard",2);
  await waitFor(()=>admin.messages.some(m=>m.type==="statuses"));
  expect(admin.messages[0].statuses).toHaveLength(2);
});

it("allows restart-all only for authenticated admins with CSRF protection", async () => {
  const restart = vi.spyOn(clientManager, "restartAllOnline").mockReturnValue({ restarted: accounts.map(a => a.id), failed: [] });
  try {
    expect((await app.inject({ method: "POST", url: "/api/admin/restart-all" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/admin/restart-all", headers: headers(0) })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/admin/restart-all", headers: headers(2, false) })).statusCode).toBe(403);
    expect(restart).not.toHaveBeenCalled();
    const response = await app.inject({ method: "POST", url: "/api/admin/restart-all", headers: headers(2) });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ restartedCount: 2, failedCount: 0, cooldownSeconds: 5 });
    expect(restart).toHaveBeenCalledOnce();
    expect(await prisma.auditLog.findFirst({ where: { userId: users[2].id, action: "ACCOUNTS_RESTART_ALL" } })).not.toBeNull();
  } finally { restart.mockRestore(); }
});

it("rejects plain chat and multiline messages through HTTP and account WebSockets", async () => {
  const connection = await socket(`/ws/accounts/${accounts[0].id}`);
  await waitFor(() => connection.messages.some(m => m.type === "history"));
  for (const command of ["hello world", "/", "/say hi\nplain chat", " /home"]) {
    const response = await app.inject({ method: "POST", url: `/api/minecraft/accounts/${accounts[0].id}/command`, headers: headers(0), payload: { command } });
    expect(response.statusCode).toBe(400);
    const errorsBefore = connection.messages.filter(m => m.type === "error").length;
    connection.ws.send(JSON.stringify({ type: "command", command, csrfToken: sessions[0].csrfToken }));
    await waitFor(() => connection.messages.filter(m => m.type === "error").length > errorsBefore);
    expect(connection.messages.at(-1)).toMatchObject({ type: "error", reason: "INVALID_MESSAGE" });
  }
  expect(sendCommand).not.toHaveBeenCalled();
});

it("exposes last-sale times only to authorized viewers and rechecks dashboard access for every sale",async()=>{
  const lastSellAt = new Date(Date.now() - 8_000).toISOString();
  await prisma.minecraftAccount.update({where:{id:accounts[0].id},data:{lastSellAt:new Date(lastSellAt)}});
  const listed = await app.inject({url:"/api/minecraft/accounts",headers:headers()});
  expect(listed.json()).toHaveLength(1);
  expect(listed.json()[0].lastSellAt).toBe(lastSellAt);
  const foreign = await app.inject({url:`/api/minecraft/accounts/${accounts[0].id}`,headers:headers(1)});
  expect(foreign.statusCode).toBe(404);
  const connection = await socket("/ws/dashboard"), admin = await socket("/ws/dashboard",2);
  await waitFor(()=>connection.messages.some(m=>m.type==="statuses") && admin.messages.some(m=>m.type==="statuses"));
  for (const listener of sellListeners) {
    listener({id:accounts[1].id,lastSellAt});
    listener({id:accounts[0].id,lastSellAt});
  }
  await waitFor(()=>connection.messages.some(m=>m.type==="account_sale") && admin.messages.filter(m=>m.type==="account_sale").length===2);
  expect(connection.messages.filter(m=>m.type==="account_sale")).toEqual([{type:"account_sale",id:accounts[0].id,lastSellAt}]);
  await prisma.userMinecraftAccount.deleteMany({where:{minecraftAccountId:accounts[0].id}});
  for (const listener of sellListeners) listener({id:accounts[0].id,lastSellAt:"2026-10-09T23:45:00.000Z"});
  // The admin's matching event confirms that the queued broadcasts were processed.
  await waitFor(()=>admin.messages.some(m=>m.lastSellAt==="2026-10-09T23:45:00.000Z"));
  expect(connection.messages.filter(m=>m.type==="account_sale")).toHaveLength(1);
});

it("rejects missing, null and foreign origins for cookie-authenticated sockets",async()=>{
  for(const path of ["/ws/dashboard","/ws/%64ashboard",`/ws/%61ccounts/${accounts[0].id}`,`/ws/accounts/${accounts[0].id}/camera`,`/ws/accounts/${accounts[0].id}/control`])
  for(const origin of [undefined,"null","https://evil.example",config.publicOrigin+".evil.example"]) {
    const ws=new WebSocket(url+path,{headers:{...headers(),...(origin?{origin}:{})}});sockets.push(ws);
    const error=await once(ws,"error");expect(String(error[0])).toContain("403");
  }
});

it("rejects unauthenticated, foreign account sockets",async()=>{
  const anonymous=new WebSocket(url+"/ws/dashboard",{headers:{origin:config.publicOrigin}});sockets.push(anonymous);
  expect((await once(anonymous,"close"))[0]).toBe(4401);
  for(const path of [`/ws/accounts/${accounts[1].id}`, `/ws/accounts/${accounts[1].id}/camera`,`/ws/accounts/${accounts[1].id}/control`]) {
    const connection=await socket(path);expect((await connection.closed)[0]).toBe(4401);expect(connection.messages).toEqual([]);
  }
});

it("checks camera access before rendering and aborts on revoked permissions, logout and account disconnect", async () => {
  const foreign=await socket(`/ws/accounts/${accounts[1].id}/camera`);
  expect((await foreign.closed)[0]).toBe(4401); expect(cameraSubscribe).not.toHaveBeenCalled();
  const own=await socket(`/ws/accounts/${accounts[0].id}/camera`);
  await waitFor(()=>cameraSubscribe.mock.calls.length===1);
  for(const viewer of cameraViewers.get(accounts[0].id)!) viewer.frame({type:"frame",image:"own-frame"});
  await waitFor(()=>own.messages.some(m=>m.image==="own-frame"));
  await prisma.userMinecraftAccount.deleteMany({where:{minecraftAccountId:accounts[0].id}});
  for(const viewer of cameraViewers.get(accounts[0].id)!) viewer.frame({type:"frame",image:"revoked-secret"});
  expect((await own.closed)[0]).toBe(4401); expect(JSON.stringify(own.messages)).not.toContain("revoked-secret");
  await waitFor(()=>cameraViewers.get(accounts[0].id)!.size===0);
  const admin=await socket(`/ws/accounts/${accounts[1].id}/camera`,2);
  await waitFor(()=>cameraViewers.get(accounts[1].id)?.size===1);
  await destroySession(sessions[2].sessionId); expect((await admin.closed)[0]).toBe(4401);
  await waitFor(()=>cameraViewers.get(accounts[1].id)!.size===0);
  const other=await socket(`/ws/accounts/${accounts[1].id}/camera`,1);
  await waitFor(()=>cameraViewers.get(accounts[1].id)?.size===1);
  for(const listener of statusListeners) listener({...snapshot(accounts[1]),status:"OFFLINE"});
  expect((await other.closed)[0]).toBe(1000);await waitFor(()=>cameraViewers.get(accounts[1].id)!.size===0);
});

it("never starts a camera for anonymous visitors or offline accounts", async () => {
  const anonymous=new WebSocket(url+`/ws/accounts/${accounts[0].id}/camera`,{headers:{origin:config.publicOrigin}});sockets.push(anonymous);
  expect((await once(anonymous,"close"))[0]).toBe(4401);expect(cameraSubscribe).not.toHaveBeenCalled();
  vi.mocked(clientManager.get).mockImplementationOnce(()=>({getStatus:()=>({...snapshot(accounts[0]),status:"OFFLINE"})}) as any);
  const offline=await socket(`/ws/accounts/${accounts[0].id}/camera`);
  expect((await offline.closed)[0]).toBe(1000);expect(cameraSubscribe).not.toHaveBeenCalled();
  expect(offline.messages).toContainEqual({type:"offline"});
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
  const admin=await socket("/ws/dashboard",2);
  await destroyAllUserSessions(users[2].id);expect((await admin.closed)[0]).toBe(4401);
});

it("rechecks expiration and account access after role downgrades",async()=>{
  const account=await socket(`/ws/accounts/${accounts[0].id}`);
  await waitFor(()=>account.messages.some(m=>m.type==="history"));
  await prisma.session.update({where:{id:sessions[0].sessionId},data:{expiresAt:new Date(Date.now()-1000)}});
  for(const listener of consoleListeners) listener({minecraftAccountId:accounts[0].id,message:"EXPIRED-SECRET"});
  expect((await account.closed)[0]).toBe(4401);expect(JSON.stringify(account.messages)).not.toContain("EXPIRED-SECRET");
  const admin=await socket("/ws/dashboard",2);
  await waitFor(()=>admin.messages.some(m=>m.type==="statuses"));
  await prisma.user.update({where:{id:users[2].id},data:{role:"USER"}});
  await prisma.userMinecraftAccount.create({data:{userId:users[2].id,minecraftAccountId:accounts[1].id}});
  for(const listener of statusListeners) listener({...snapshot(accounts[0]),name:"FOREIGN-AFTER-DEMOTION"});
  for(const listener of statusListeners) listener({...snapshot(accounts[1]),name:"OWN-AFTER-DEMOTION"});
  await waitFor(()=>admin.messages.some(m=>m.status?.name==="OWN-AFTER-DEMOTION"));
  expect(JSON.stringify(admin.messages)).not.toContain("FOREIGN-AFTER-DEMOTION");
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

});


it("returns 404 for retired HTTP and WebSocket endpoints even for admins", async () => {
  for (const url of ["/api/item-worth", "/api/item-worth/runs", "/api/namesniper/accounts",
    "/api/minigames/admin/dashboard", "/api/minigames/content", "/ws/namesniper-dashboard",
    "/ws/namesniper/old-account", "/ws/minigames"]) {
    expect((await app.inject({ url, headers: headers(2) })).statusCode).toBe(404);
  }
  for (const url of ["/api/item-worth/start", "/api/namesniper/accounts", "/api/minigames/auth/challenge"]) {
    expect((await app.inject({ method: "POST", url, headers: headers(2), payload: {} })).statusCode).toBe(404);
  }
});

it("requires CSRF before remote control and releases control after account permission revocation", async () => {
  const bad = await socket(`/ws/accounts/${accounts[0].id}/control`);
  bad.ws.send(JSON.stringify({ type: "start", csrfToken: "incorrect" }));
  expect((await bad.closed)[0]).toBe(4403); expect(remoteCalls).toHaveLength(0);
  const own = await socket(`/ws/accounts/${accounts[0].id}/control`);
  own.ws.send(JSON.stringify({ type: "start", csrfToken: sessions[0].csrfToken }));
  await waitFor(() => remoteCalls.length === 1);
  await waitFor(() => remoteCalls[0].start.mock.calls.length === 1);
  own.ws.send(JSON.stringify({ type: "input", captured: true, events: [{ kind: 0, code: 87, action: 1 }] }));
  await waitFor(() => remoteCalls[0].input.mock.calls.length === 1);
  await prisma.userMinecraftAccount.deleteMany({where:{minecraftAccountId:accounts[0].id}});
  own.ws.send(JSON.stringify({ type: "input", captured: true, events: [] }));
  expect((await own.closed)[0]).toBe(4401);
  await waitFor(() => remoteCalls[0].stop.mock.calls.length === 1);
});

it("keeps input heartbeats and Stop responsive while native remote preparation is pending", async () => {
  let finish!: () => void;
  remotePreparation = new Promise<void>(resolve => { finish = resolve; });
  try {
    const own = await socket(`/ws/accounts/${accounts[0].id}/control`);
    own.ws.send(JSON.stringify({ type: "start", csrfToken: sessions[0].csrfToken }));
    await waitFor(() => remoteCalls.length === 1 && remoteCalls[0].start.mock.calls.length === 1);
    for (let count = 1; count <= 5; count++) {
      own.ws.send(JSON.stringify({ type: "input", captured: true, events: [] }));
      await waitFor(() => remoteCalls[0].input.mock.calls.length === count);
    }
    own.ws.send(JSON.stringify({ type: "stop" }));
    expect((await own.closed)[0]).toBe(1000);
    expect(remoteCalls[0].stop).toHaveBeenCalled();
  } finally { finish(); remotePreparation = undefined; }
});
