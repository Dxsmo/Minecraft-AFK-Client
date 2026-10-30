import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createClient } from "@connectrpc/connect";
import { createGrpcWebTransport } from "@connectrpc/connect-web";
import { InstanceService } from "@soulfiremc/sdk/generated/soulfire/instance_pb";
import { BotService } from "@soulfiremc/sdk/generated/soulfire/bot_pb";
import { BotLiveService } from "@soulfiremc/sdk/generated/soulfire/bot_live_pb";
import { MCAuthService } from "@soulfiremc/sdk/generated/soulfire/mc-auth_pb";
import { SdkService } from "@soulfiremc/sdk/generated/soulfire/sdk_pb";
import { PovService } from "@soulfiremc/sdk/generated/soulfire/pov_pb";
import { WorldService } from "@soulfiremc/sdk/generated/soulfire/world_pb";

export const SOULFIRE_VERSION = "2.10.6";

/** Same root-token format as the official SDK's dedicated-server installer.
 * The key is mounted read-only from the private SoulFire data volume. */
export function rootToken(secret: Buffer): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({ aud: ["api"], sub: "00000000-0000-0000-0000-000000000000", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
  const unsigned = `${header}.${claims}`;
  return `${unsigned}.${createHmac("sha256", secret).update(unsigned).digest("base64url")}`;
}

export function soulFireRpc() {
  const baseUrl = process.env.SOULFIRE_URL || "http://soulfire:38765";
  const transport = createGrpcWebTransport({ baseUrl, defaultTimeoutMs: 30_000, interceptors: [next => async req => {
    const token = process.env.SOULFIRE_TOKEN || rootToken(await readFile(process.env.SOULFIRE_SECRET_KEY_FILE || "/soulfire-data/secret-key.bin"));
    req.header.set("Authorization", `Bearer ${token}`);
    return next(req);
  }] });
  return {
    instance: createClient(InstanceService, transport), bot: createClient(BotService, transport),
    live: createClient(BotLiveService, transport), auth: createClient(MCAuthService, transport),
    sdk: createClient(SdkService, transport),
    world: createClient(WorldService, transport), pov: createClient(PovService, transport),
  };
}
export type SoulFireRpc = ReturnType<typeof soulFireRpc>;
