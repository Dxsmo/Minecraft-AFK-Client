import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { accountFromMsa, authenticate, legacyLogin, writePrivateJson } from "../../src/soulfire/auth.js";
import type { SoulFireRpc } from "../../src/soulfire/rpc.js";
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function directory() { const dir = await mkdtemp(path.join(os.tmpdir(), "afk-auth-test-")); directories.push(dir); return dir; }
const msa = { refreshToken: "synthetic-refresh", clientId: "00000000441cc96b", scope: "service::user.auth.xboxlive.com::MBI_SSL" };

it("imports the original Azalea issuing application and leaves its token file unchanged", async () => {
  const dir = await directory(); const file = path.join(dir, "azalea-auth.json");
  await writePrivateJson(file, [{ cache_key: "USER@example.com", msa: { expires_at: 1234, data: { refresh_token: msa.refreshToken, access_token: "synthetic-access" } } }]);
  const before = await readFile(file); const account = await legacyLogin(dir, "JAVA", "user@example.com");
  expect(account?.accountData.case).toBe("onlineChainJavaData");
  const chain: any = account?.accountData.value?.authChain;
  expect(chain.msaApplicationConfig).toMatchObject({ clientId: msa.clientId, scope: msa.scope });
  expect(chain.msaToken).toMatchObject({ refreshToken: msa.refreshToken, expireTimeMs: 1_234_000 });
  expect(await readFile(file)).toEqual(before);
  expect(await legacyLogin(dir, "JAVA", "different@example.com")).toBeNull();
});

it.each(["live", "msal"])("imports an existing Prismarine %s cache without device login", async type => {
  const dir = await directory();
  await writePrivateJson(path.join(dir, `account_${type}-cache.json`), type === "live"
    ? { token: { refresh_token: msa.refreshToken, access_token: "synthetic-access" } }
    : { RefreshToken: { id: { secret: msa.refreshToken, client_id: "original-msal-client" } } });
  const account = await legacyLogin(dir, "BEDROCK", null); const chain: any = account?.accountData.value?.authChain;
  expect(chain.msaToken.refreshToken).toBe(msa.refreshToken);
  expect(chain.msaApplicationConfig.clientId).toBe(type === "live" ? msa.clientId : "original-msal-client");
});

it("creates valid DER EC keys when importing a Bedrock session", () => {
  const bedrock = accountFromMsa("BEDROCK", msa);
  const other: any = bedrock.accountData.value?.authChain;
  for (const [keys, curve] of [[other.deviceKeyPair, "prime256v1"], [other.sessionKeyPair, "secp384r1"]]) {
    const publicKey = createPublicKey({ key: Buffer.from(keys.publicKey, "base64"), type: "spki", format: "der" });
    const privateKey = createPrivateKey({ key: Buffer.from(keys.privateKey, "base64"), type: "pkcs8", format: "der" });
    expect(publicKey.asymmetricKeyDetails?.namedCurve).toBe(curve);
    expect(createPublicKey(privateKey).export({ type: "spki", format: "der" })).toEqual(publicKey.export({ type: "spki", format: "der" }));
  }
});

it("uses a validated legacy refresh before requesting any Microsoft device code", async () => {
  const dir = await directory(); await writePrivateJson(path.join(dir, "azalea-auth.json"), [{ cache_key: "user", msa: { data: { refresh_token: msa.refreshToken } } }]);
  const account = accountFromMsa("JAVA", msa); const refresh = vi.fn(async () => ({ account })), loginDeviceCode = vi.fn();
  const rpc = { auth: { refresh, loginDeviceCode } } as unknown as SoulFireRpc;
  const onCode = vi.fn();
  expect(await authenticate(rpc, { instanceId: "instance", edition: "JAVA", cacheDir: dir, email: "user", signal: new AbortController().signal, onCode, onMigrationFailure: vi.fn() })).toBe(account);
  expect(refresh).toHaveBeenCalledOnce(); expect(loginDeviceCode).not.toHaveBeenCalled(); expect(onCode).not.toHaveBeenCalled();
});

it("falls back to one device-code login when Microsoft rejects a legacy refresh", async () => {
  const dir = await directory(); await writePrivateJson(path.join(dir, "user_live.json"), { token: { refresh_token: "revoked" } });
  const account = accountFromMsa("BEDROCK", msa);
  const rpc = { auth: { refresh: vi.fn(async () => { throw new Error("revoked"); }),
    loginDeviceCode: vi.fn(async function* () { yield { data: { case: "deviceCode", value: { verificationUri: "https://microsoft.com/link", userCode: "TEST" } } }; yield { data: { case: "account", value: account } }; }) } } as unknown as SoulFireRpc;
  const onCode = vi.fn(), onMigrationFailure = vi.fn();
  const result = await authenticate(rpc, { instanceId: "instance", edition: "BEDROCK", cacheDir: dir, email: null, signal: new AbortController().signal, onCode, onMigrationFailure });
  expect(result).toBe(account); expect(onCode).toHaveBeenCalledOnce(); expect(onMigrationFailure).toHaveBeenCalledOnce();
});
