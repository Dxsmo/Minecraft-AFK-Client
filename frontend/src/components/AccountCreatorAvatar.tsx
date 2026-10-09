import { useState } from "react";
import type { MinecraftAccount } from "../lib/types";

export function AccountCreatorAvatar({ account, blurred }: { account: MinecraftAccount; blurred: boolean }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const creator = account.createdBy;
  const username = creator?.minecraftUsername;
  const url = username ? `/api/minecraft/accounts/${account.id}/creator-avatar?v=${encodeURIComponent(username)}` : null;
  const label = blurred ? "Account-Ersteller" : creator
    ? `Erstellt von ${creator.username}${username ? ` · ${username}` : " · Kein Minecraft-Name zugewiesen"}`
    : "Account-Ersteller unbekannt";

  return (
    <span className="account-creator-avatar flex shrink-0 items-center justify-center overflow-hidden rounded"
      title={label} role="img" aria-label={label}
      style={{ width: 24, height: 24, background: "var(--bg-elev)", color: "var(--text-subtle)",
        filter: blurred ? "blur(4px)" : undefined, transition: "filter 150ms ease" }}>
      {url && url !== failedUrl ? (
        <img src={url} alt="" width={24} height={24} loading="lazy" referrerPolicy="no-referrer"
          style={{ imageRendering: "pixelated" }} onError={() => setFailedUrl(url)} />
      ) : (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          <rect x="4" y="4" width="16" height="16" rx="2" /><path d="M8 10h2m4 0h2m-7 5h6" />
        </svg>
      )}
    </span>
  );
}
