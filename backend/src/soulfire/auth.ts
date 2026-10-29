import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { create, fromJson, type JsonObject } from "@bufbuild/protobuf";
import { MinecraftAccountProtoSchema, MinecraftAccountProto_AccountTypeProto as AuthType, AccountTypeDeviceCode, type MinecraftAccountProto } from "@soulfiremc/sdk/generated/soulfire/common_pb";
import type { SoulFireRpc } from "./rpc.js";

export type Edition = "JAVA" | "BEDROCK";
export type RemoteAccount = { instanceId: string; botId: string };
export type SignInCode = { verification_uri: string; user_code: string; expires_in: number };

export async function writePrivateJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, file);
}

export async function readRemoteAccount(cacheDir: string): Promise<RemoteAccount | null> {
  try {
    const value = JSON.parse(await readFile(path.join(cacheDir, "soulfire.json"), "utf8"));
    if (typeof value.instanceId === "string" && typeof value.botId === "string") return value;
  } catch { /* A legacy account has not been mapped yet. */ }
  return null;
}

function ecKeyPair(curve: string): JsonObject {
  const keys = generateKeyPairSync("ec", { namedCurve: curve });
  return { algorithm: "EC", publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKey: keys.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64") };
}

/** Preserve the issuing OAuth application. Refresh tokens are not passwords
 * and cannot safely be reassigned to another client ID. */
export function accountFromMsa(edition: Edition, msa: { refreshToken: string; accessToken?: string; expiresAt?: number; clientId: string; scope: string }): MinecraftAccountProto {
  const chain: JsonObject = {
    _saveVersion: 1, msaApplicationConfig: { _saveVersion: 1, clientId: msa.clientId, scope: msa.scope, environment: "LIVE" },
    deviceType: "Nintendo", deviceId: randomUUID(), deviceKeyPair: ecKeyPair("prime256v1"),
    msaToken: { _saveVersion: 1, accessToken: msa.accessToken || "", refreshToken: msa.refreshToken, expireTimeMs: msa.expiresAt || 0 },
  };
  if (edition === "BEDROCK") chain.sessionKeyPair = ecKeyPair("secp384r1");
  return create(MinecraftAccountProtoSchema, {
    type: edition === "JAVA" ? AuthType.MICROSOFT_JAVA_DEVICE_CODE : AuthType.MICROSOFT_BEDROCK_DEVICE_CODE,
    profileId: randomUUID(), lastKnownName: "Migrating",
    accountData: edition === "JAVA" ? { case: "onlineChainJavaData", value: { authChain: chain } } : { case: "bedrockData", value: { authChain: chain } },
  });
}

export async function legacyLogin(cacheDir: string, edition: Edition, email: string | null): Promise<MinecraftAccountProto | null> {
  try {
    const entries = JSON.parse(await readFile(path.join(cacheDir, "azalea-auth.json"), "utf8"));
    const entry = Array.isArray(entries) ? entries.find(e => !email || (e.cache_key ?? e.email)?.toLowerCase() === email.toLowerCase()) : null;
    if (entry?.msa?.data?.refresh_token) return accountFromMsa(edition, {
      refreshToken: entry.msa.data.refresh_token, accessToken: entry.msa.data.access_token,
      expiresAt: entry.msa.expires_at * 1000, clientId: "00000000441cc96b", scope: "service::user.auth.xboxlive.com::MBI_SSL",
    });
  } catch { /* Try the original Bedrock cache next. Never overwrite it. */ }
  let files: string[] = [];
  try { files = await readdir(cacheDir); } catch { return null; }
  for (const file of files.filter(name => /(?:live|msal|msa).*\.json$/i.test(name))) {
    try {
      const cached = JSON.parse(await readFile(path.join(cacheDir, file), "utf8"));
      if (cached.token?.refresh_token) return accountFromMsa(edition, { refreshToken: cached.token.refresh_token,
        accessToken: cached.token.access_token, clientId: "00000000441cc96b", scope: "service::user.auth.xboxlive.com::MBI_SSL" });
      const token = Object.values(cached.RefreshToken ?? {}).find((entry: any) => entry.secret && entry.client_id) as any;
      if (token) return accountFromMsa(edition, { refreshToken: token.secret, clientId: token.client_id, scope: "XboxLive.signin offline_access" });
    } catch { /* A damaged or unrelated cache is not an authorization source. */ }
  }
  return null;
}

export async function authenticate(rpc: SoulFireRpc, options: { instanceId: string; edition: Edition; cacheDir: string; email: string | null; offlineName?: string; signal: AbortSignal;
  onCode: (code: SignInCode) => void; onMigrationFailure: () => void }): Promise<MinecraftAccountProto> {
  try {
    const imported = JSON.parse(await readFile(path.join(options.cacheDir, "imported-account.json"), "utf8"));
    if (imported.edition === options.edition) {
      const account = fromJson(MinecraftAccountProtoSchema, imported.account);
      const result = await rpc.auth.refresh({ instanceId: options.instanceId, account }, { signal: options.signal, timeoutMs: 120_000 });
      if (result.account) return result.account;
    }
  } catch { if (options.signal.aborted) throw options.signal.reason; }
  const candidate = await legacyLogin(options.cacheDir, options.edition, options.email);
  if (candidate) {
    try {
      const result = await rpc.auth.refresh({ instanceId: options.instanceId, account: candidate }, { signal: options.signal, timeoutMs: 120_000 });
      if (result.account) return result.account;
    } catch { if (options.signal.aborted) throw options.signal.reason; options.onMigrationFailure(); }
  }
  for await (const response of rpc.auth.loginDeviceCode({ instanceId: options.instanceId,
    service: options.edition === "JAVA" ? AccountTypeDeviceCode.MICROSOFT_JAVA_DEVICE_CODE : AccountTypeDeviceCode.MICROSOFT_BEDROCK_DEVICE_CODE,
  }, { signal: options.signal, timeoutMs: 15 * 60_000 })) {
    if (response.data.case === "deviceCode") options.onCode({ verification_uri: response.data.value.verificationUri, user_code: response.data.value.userCode, expires_in: 900 });
    if (response.data.case === "account") return response.data.value;
  }
  throw new Error("Microsoft-Anmeldung wurde ohne Account beendet");
}
