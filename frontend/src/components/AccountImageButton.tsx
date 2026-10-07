import { useRef, useState } from "react";
import { api, ApiError } from "../lib/api";

/** Normalize photos locally; the server only stores a small, validated PNG. */
async function prepareImage(file: File): Promise<string> {
  if (!/^image\/(png|jpeg|webp|gif|avif)$/.test(file.type)) {
    throw new Error("Choose a PNG, JPEG, WebP, GIF or AVIF image.");
  }
  if (file.size > 10 * 1024 * 1024) throw new Error("The image must be smaller than 10 MB.");
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 256;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not prepare the image.");
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    context.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, 256, 256);
    return canvas.toDataURL("image/png").split(",")[1];
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function AccountImageButton({ accountId, imageUrl, blurred, onUpdated, onError }: {
  accountId: string;
  imageUrl: string | null;
  blurred: boolean;
  onUpdated: (update: { id: string; imageUrl: string }) => void;
  onError: (message: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  async function upload(file: File) {
    setUploading(true);
    try {
      const image = await prepareImage(file);
      onUpdated(await api.put<{ id: string; imageUrl: string }>(`/minecraft/accounts/${accountId}/image`, { image }));
      setFailedUrl(null);
    } catch (err) {
      onError(err instanceof ApiError || err instanceof Error ? err.message : "Could not upload the image.");
    } finally {
      setUploading(false);
    }
  }

  const label = imageUrl ? "Replace account image" : "Upload account image";
  return (
    <div className="account-image-control relative z-20">
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif" hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void upload(file);
        }} />
      <button type="button" className="account-image-button" title={label} aria-label={label}
        aria-busy={uploading} disabled={uploading} onClick={() => input.current?.click()}>
        {imageUrl && failedUrl !== imageUrl ? (
          <img src={imageUrl} alt="" className="h-full w-full object-cover" draggable={false}
            style={{ filter: blurred ? "blur(8px)" : undefined }} onError={() => setFailedUrl(imageUrl)} />
        ) : (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
        )}
        {uploading && <span className="absolute inset-0 grid place-items-center bg-black/45" aria-hidden="true">
          <span className="h-5 w-5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
        </span>}
      </button>
    </div>
  );
}
