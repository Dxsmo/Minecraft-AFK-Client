import { readFileSync } from "node:fs";
import path from "node:path";

/** Keep an imported Microsoft refresh token bound to its issuing OAuth app.
 * This optional file contains only a public client ID, never credentials. */
export function microsoftClientOptions(cacheDir: string, edition: "JAVA" | "BEDROCK"): {
  authTitle?: string; flow?: "live"; deviceType?: string;
} {
  try {
    const { clientId } = JSON.parse(readFileSync(path.join(cacheDir, "microsoft-client.json"), "utf8"));
    const deviceType = clientId === "00000000441cc96b" ? "Nintendo"
      : edition === "JAVA" && clientId === "00000000402b5328" ? "Win32"
      : edition === "BEDROCK" && clientId === "0000000048183522" ? "Android" : undefined;
    if (deviceType) return { authTitle: clientId, flow: "live", deviceType };
  } catch { /* Missing/invalid metadata uses the normal device-code flow. */ }
  return {};
}
