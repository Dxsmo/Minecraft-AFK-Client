import { useEffect, useRef, useState } from "react";

type CameraState = "loading" | "live" | "error";

export function LiveCamPanel({ accountId, online }: { accountId: string; online: boolean }) {
  const image = useRef<HTMLImageElement>(null);
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  const [state, setState] = useState<CameraState>("loading");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const changed = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);

  useEffect(() => {
    const img = image.current;
    if (!online || !visible) return;
    let disposed = false;
    let socket: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let firstFrame: ReturnType<typeof setTimeout> | undefined;
    function connect() {
      if (disposed) return;
      setState("loading"); setError("");
      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(`${protocol}://${window.location.host}/ws/accounts/${accountId}/camera`);
      const current = socket;
      firstFrame = setTimeout(() => { if (!disposed) current.close(); }, 30_000);
      current.onmessage = event => {
        if (disposed || socket !== current) return;
        try {
          const message = JSON.parse(event.data);
          if (message.type === "frame" && typeof message.image === "string" && message.image.length <= 2 * 1024 * 1024) {
            clearTimeout(firstFrame);
            if (img) img.src = `data:image/png;base64,${message.image}`;
          } else if (message.type === "error") {
            setError("Die Live Cam konnte nicht geladen werden. Die Verbindung wird erneut versucht."); setState("error");
          }
        } catch { current.close(); }
      };
      current.onerror = () => current.close();
      current.onclose = event => {
        clearTimeout(firstFrame);
        if (disposed) return;
        setState("error");
        if (event.code === 4401 || event.code === 4403) {
          setError("Der Zugriff auf diesen Account ist abgelaufen. Bitte erneut anmelden."); return;
        }
        setError("Die Live Cam ist vorübergehend nicht erreichbar. Die Verbindung wird erneut versucht.");
        retry = setTimeout(connect, 3000);
      };
    }
    connect();
    return () => {
      disposed = true;
      clearTimeout(retry); clearTimeout(firstFrame);
      socket?.close();
      img?.removeAttribute("src");
    };
  }, [accountId, online, visible, attempt]);

  const message = !online ? "Der Account ist offline. Die Live Cam startet, sobald er verbunden ist."
    : !visible ? "Die Übertragung pausiert, solange dieser Browser-Tab nicht sichtbar ist."
    : state === "error" ? error : "Live Cam wird geladen…";
  const live = online && visible && state === "live";

  return (
    <section className="card overflow-hidden" aria-label="Live Cam">
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3" style={{ borderColor: "var(--border)" }}>
        <h2 className="text-sm font-semibold" style={{ color: "var(--text)" }}>Live Cam</h2>
        <span className="flex items-center gap-2 text-xs" style={{ color: live ? "var(--accent)" : "var(--text-muted)" }}>
          <span className={`h-2 w-2 rounded-full ${live ? "bg-emerald-400" : "bg-zinc-500"}`} />
          {live ? "Live" : !online ? "Offline" : !visible ? "Pausiert" : "Verbinden…"}
        </span>
      </div>
      <div className="relative aspect-video w-full bg-black">
        <img ref={image} alt="Liveansicht des Minecraft-Accounts" className="h-full w-full object-contain" hidden={!live}
          onLoad={() => setState("live")} />
        {!live && <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-5 text-center">
          {online && visible && state === "loading" && <span className="spinner" />}
          <p role="status" className="max-w-md text-sm" style={{ color: "var(--text-muted)" }}>{message}</p>
          {online && visible && state === "error" && <button className="btn btn-secondary btn-sm" onClick={() => setAttempt(value => value + 1)}>Erneut versuchen</button>}
        </div>}
      </div>
    </section>
  );
}
