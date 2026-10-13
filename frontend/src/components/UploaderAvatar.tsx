import { useState } from "react";

export function UploaderAvatar({ userId, username, minecraftUsername }: {
  userId: string; username: string; minecraftUsername: string | null;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const url = minecraftUsername ? `/api/users/${encodeURIComponent(userId)}/avatar?v=${encodeURIComponent(minecraftUsername)}` : null;
  return <span className="uploader-avatar" role="img" aria-label={`Skin von ${username}`}
    title={minecraftUsername ?? "Kein Minecraft-Name hinterlegt"}>
    {url && url !== failedUrl ? <img src={url} alt="" width="20" height="20" loading="lazy"
      referrerPolicy="no-referrer" onError={() => setFailedUrl(url)} /> :
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        <rect x="4" y="4" width="16" height="16" rx="2" /><path d="M8 10h2m4 0h2m-7 5h6" />
      </svg>}
  </span>;
}
