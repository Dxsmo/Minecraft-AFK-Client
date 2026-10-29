import { afterEach, expect, it, vi } from "vitest";
import { once } from "node:events";
const sessions: Array<{ config: any; emit: (event: any) => void; abort: AbortController; queue: any[]; resolve: () => void; reject: (error: Error) => void }> = [];
vi.mock("../../src/soulfire/session.js", () => ({ runSoulFire: vi.fn((config, emit, abort, queue) => new Promise<void>((resolve, reject) => {
  sessions.push({ config, emit, abort, queue, resolve, reject });
  abort.signal.addEventListener("abort", resolve, { once: true });
})) }));
const { createSoulFireController } = await import("../../src/soulfire/controller.js");
afterEach(() => { for (const session of sessions) session.resolve(); sessions.length = 0; });
it("isolates account commands/events and cancellation while sharing the Node runtime", async () => {
  const one=createSoulFireController(), two=createSoulFireController(), outputOne: string[]=[],outputTwo: string[]=[];
  one.stdout.on("data", data=>outputOne.push(data.toString())); two.stdout.on("data", data=>outputTwo.push(data.toString()));
  one.stdin.write('{"account_id":"one"}\n'); two.stdin.write('{"account_id":"two"}\n');
  one.stdin.write('{"type":"chat","text":"/home private"}\n');
  expect(sessions[0].queue).toEqual([{ type:"chat",text:"/home private" }]); expect(sessions[1].queue).toEqual([]);
  sessions[1].emit({type:"spawn"}); expect(outputOne).toEqual([]); expect(outputTwo).toEqual(['{"type":"spawn"}\n']);
  const closed=once(one,"close"); one.stdin.write('{"type":"disconnect"}\n'); await closed;
  expect(sessions[0].abort.signal.aborted).toBe(true); expect(sessions[1].abort.signal.aborted).toBe(false);
  expect(two.exitCode).toBeNull(); const closedTwo=once(two,"close"); two.kill(); await closedTwo;
});
it("reports one account's startup error and leaves other sessions alive", async () => {
  const one=createSoulFireController(),two=createSoulFireController(),lines:string[]=[];
  one.stdout.on("data", data=>lines.push(data.toString())); one.stdin.write('{"account_id":"one"}\n'); two.stdin.write('{"account_id":"two"}\n');
  const closed=once(one,"close"); sessions[0].reject(new Error("SoulFire unavailable")); await closed;
  expect(one.exitCode).toBe(1); expect(JSON.parse(lines[0])).toMatchObject({type:"connection_failed",error:"SoulFire unavailable"});
  expect(sessions[1].abort.signal.aborted).toBe(false); const closedTwo=once(two,"close");two.kill();await closedTwo;
});
it("preserves NDJSON framing across partial or combined writes", async () => {
  const controller=createSoulFireController();controller.stdin.write('{"account_');controller.stdin.write('id":"one"}\n{"type":"check_crouch"}\n');
  expect(sessions[0].config.account_id).toBe("one");expect(sessions[0].queue).toEqual([{type:"check_crouch"}]);
  const closed=once(controller,"close");controller.kill();await closed;
});
