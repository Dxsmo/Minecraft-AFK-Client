import { useEffect, useRef, useState } from "react";
import { glfwKey, modifiers, type RemoteEvent } from "../lib/remoteInput";

export function RemoteControlPanel({ accountId, onExit }: { accountId: string; onExit: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const exit = useRef(onExit); exit.current = onExit;
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [screenOpen, setScreenOpen] = useState(false);
  const capture = useRef<() => void>(() => {});
  const stop = useRef<() => void>(onExit);
  useEffect(() => {
    if (!window.isSecureContext || !("VideoDecoder" in window)) {
      setError("Fernsteuerung benötigt HTTPS oder localhost und einen aktuellen Browser mit Videodecoder."); return;
    }
    let disposed = false, failed = false, socket: WebSocket;
    let decoder: VideoDecoder | undefined, codec = "", waitForKey = true;
    let decoderFailures = 0;
    let startup: ReturnType<typeof setTimeout> | undefined;
    let events: RemoteEvent[] = [], open = false, intentionalUnlock = false;
    const buttons = new Set<number>();
    function release() {
      if (disposed) return;
      disposed = true;
      clearTimeout(startup);
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "stop" }));
      socket?.close(); if (decoder?.state !== "closed") decoder?.close();
      if (document.pointerLockElement) document.exitPointerLock();
      exit.current();
    }
    stop.current = release;
    function send(requestKeyFrame = false) {
      if (disposed || socket?.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({ type: "input", captured: true, events: events.splice(0, 128), requestKeyFrame }));
    }
    function queue(event: RemoteEvent) {
      if (disposed || failed) return;
      if (events.length >= 128) send();
      events.push(event);
    }
    function lock() {
      if (disposed || open || document.pointerLockElement) return;
      try { void document.documentElement.requestPointerLock()?.catch(() => undefined); } catch { /* A second click can grant capture. */ }
    }
    capture.current = lock;
    socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/accounts/${accountId}/control`);
    socket.onopen = () => {
      const match = document.cookie.match(/(?:^|; )afk_csrf=([^;]*)/);
      socket.send(JSON.stringify({ type: "start", csrfToken: match ? decodeURIComponent(match[1]) : "" }));
    };
    socket.onmessage = event => {
      if (disposed) return;
      try {
        const frame = JSON.parse(event.data);
        if (frame.type === "error") { failed = true; clearTimeout(startup); setError(frame.message || "Fernsteuerung nicht verfügbar."); return; }
        if (frame.type !== "video" || typeof frame.data !== "string" || frame.data.length > 4 * 1024 * 1024) return;
        if (open !== frame.screenOpen) {
          open = !!frame.screenOpen; setScreenOpen(open);
          if (open && document.pointerLockElement) { intentionalUnlock = true; document.exitPointerLock(); }
        }
        if (codec !== frame.codec || !decoder || decoder.state === "closed") {
          if (decoder?.state !== "closed") decoder?.close();
          codec = frame.codec; waitForKey = true;
          decoder = new VideoDecoder({
            output: video => {
              try { if (!disposed && canvas.current) { clearTimeout(startup); decoderFailures = 0; canvas.current.getContext("2d")?.drawImage(video, 0, 0, 640, 360); setReady(true); } }
              finally { video.close(); }
            },
            error: () => {
              if (++decoderFailures >= 3) {
                failed = true; clearTimeout(startup);
                setError("Dein Browser kann das Steuerungsbild nicht dekodieren. Bitte einen aktuellen Chrome oder Edge versuchen.");
                if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "stop" }));
                socket.close(); return;
              }
              waitForKey = true; codec = ""; send(true);
            },
          });
          decoder.configure({ codec, optimizeForLatency: true });
        }
        if (decoder.decodeQueueSize > 4) { waitForKey = true; send(true); return; }
        if (waitForKey && !frame.keyFrame) return;
        if (frame.keyFrame) waitForKey = false;
        const data = Uint8Array.from(atob(frame.data), char => char.charCodeAt(0));
        decoder.decode(new EncodedVideoChunk({ type: frame.keyFrame ? "key" : "delta", timestamp: frame.timestamp, data }));
      } catch { failed = true; setError("Das Videobild konnte nicht verarbeitet werden. Bitte Steuerung beenden und erneut öffnen."); }
    };
    socket.onclose = event => {
      if (disposed) return;
      failed = true; clearTimeout(startup);
      const reason = event.code === 4401 || event.code === 4403 ? "Deine Sitzung oder der Zugriff auf den Account ist abgelaufen. Bitte erneut anmelden."
        : event.code === 4409 ? "Der Account ist nicht mehr online."
        : event.code === 4429 ? "Die Eingabeverbindung kommt nicht hinterher. Bitte erneut versuchen."
        : "Die Fernsteuerung wurde beendet. Du kannst zur Live Cam zurückkehren.";
      setError(previous => previous || reason);
      if (document.pointerLockElement) { intentionalUnlock = true; document.exitPointerLock(); }
    };
    function key(event: KeyboardEvent) {
      if (event.code === "Escape" || event.key === "Escape") { event.preventDefault(); event.stopPropagation(); release(); return; }
      if (disposed || failed) return;
      event.preventDefault(); event.stopPropagation();
      const code = glfwKey(event.code);
      if (code !== undefined) {
        const down = event.type === "keydown";
        queue({ kind: 0, code, action: down ? event.repeat ? 2 : 1 : 0, modifiers: modifiers(event), key: event.key });
      }
      if (event.type === "keydown" && event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
        queue({ kind: 1, code: event.key.codePointAt(0), modifiers: modifiers(event) });
      }
    }
    function mouse(event: MouseEvent) {
      if (disposed || failed) return;
      const buttonCode = event.button === 1 ? 2 : event.button === 2 ? 1 : 0;
      // Dragging out of the picture must still release the original button.
      if (event.type === "mouseup" && buttons.delete(event.button)) {
        event.preventDefault(); queue({ kind: 2, code: buttonCode, action: 0, modifiers: modifiers(event) }); return;
      }
      const element = canvas.current;
      if (open) {
        if (!element || event.target !== element) return;
        const box = element.getBoundingClientRect();
        queue({ kind: 3, x: Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)), y: Math.max(0, Math.min(1, (event.clientY - box.top) / box.height)), relative: false });
      } else if (document.pointerLockElement) {
        if (event.type === "mousemove") queue({ kind: 3, x: event.movementX, y: event.movementY, relative: true });
      } else return;
      if (event.type !== "mousemove") {
        event.preventDefault();
        if (event.type === "mousedown") buttons.add(event.button);
        queue({ kind: 2, code: buttonCode, action: event.type === "mousedown" ? 1 : 0, modifiers: modifiers(event) });
      }
    }
    function wheel(event: WheelEvent) {
      if (disposed || failed || (!document.pointerLockElement && event.target !== canvas.current)) return;
      event.preventDefault(); queue({ kind: 4, x: -Math.sign(event.deltaX), y: -Math.sign(event.deltaY) });
    }
    const lockChanged = () => {
      if (document.pointerLockElement) return;
      if (intentionalUnlock) { intentionalUnlock = false; return; }
      if (!open && !disposed) release();
    };
    const hidden = () => { if (document.hidden) release(); };
    const contextMenu = (event: Event) => { if (document.pointerLockElement || event.target === canvas.current) event.preventDefault(); };
    window.addEventListener("keydown", key, true); window.addEventListener("keyup", key, true);
    for (const type of ["mousemove", "mousedown", "mouseup"] as const) window.addEventListener(type, mouse, true);
    window.addEventListener("wheel", wheel, { capture: true, passive: false });
    window.addEventListener("blur", release);
    document.addEventListener("pointerlockchange", lockChanged); document.addEventListener("visibilitychange", hidden);
    document.addEventListener("contextmenu", contextMenu);
    const inputTimer = setInterval(() => { if (events.length) send(); }, 25);
    const heartbeat = setInterval(() => send(), 500);
    startup = setTimeout(() => {
      if (disposed || failed) return;
      failed = true;
      setError("Es kommt kein Steuerungsbild an. Bitte die Verbindung und SoulFire-Auslastung prüfen und erneut versuchen.");
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "stop" }));
      socket.close();
    }, 30_000);
    lock();
    return () => {
      disposed = true; clearInterval(inputTimer); clearInterval(heartbeat); clearTimeout(startup);
      window.removeEventListener("keydown", key, true); window.removeEventListener("keyup", key, true);
      for (const type of ["mousemove", "mousedown", "mouseup"] as const) window.removeEventListener(type, mouse, true);
      window.removeEventListener("wheel", wheel, true); window.removeEventListener("blur", release);
      document.removeEventListener("pointerlockchange", lockChanged); document.removeEventListener("visibilitychange", hidden);
      document.removeEventListener("contextmenu", contextMenu);
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "stop" }));
      socket.close(); if (decoder?.state !== "closed") decoder?.close();
      if (document.pointerLockElement) document.exitPointerLock();
    };
  }, [accountId]);

  return <section className="card overflow-hidden" aria-label="Fernsteuerung">
    <div className="flex items-center justify-between gap-3 border-b px-4 py-3" style={{ borderColor: "var(--border)" }}>
      <h2 className="text-sm font-semibold">Live Cam · Fernsteuerung</h2>
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => stop.current()}>Steuerung beenden · Esc</button>
    </div>
    <div className="relative aspect-video bg-black">
      <canvas ref={canvas} width={640} height={360} aria-label="Minecraft fernsteuern" tabIndex={0}
        onClick={() => capture.current()} className="h-full w-full object-contain" style={{ cursor: screenOpen ? "default" : "crosshair" }} />
      {(!ready || error) && <div className="pointer-events-none absolute inset-0 grid place-items-center px-6 text-center text-sm text-zinc-300">
        {error || "Fernsteuerung wird verbunden…"}
      </div>}
    </div>
    <p className="px-4 py-3 text-xs" style={{ color: "var(--text-muted)" }}>
      WASD · Maus zum Umsehen · E für Inventar · Minecraft-Tastenbelegung · Esc beendet nur die Fernsteuerung.
      Automatischer Verkauf und Auto button pausieren während der Steuerung.
    </p>
  </section>;
}
