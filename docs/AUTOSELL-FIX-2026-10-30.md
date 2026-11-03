# AutoSell bei vielen Items

Dieser Bericht beschreibt Controls 1.2.0. Der anschließende Wechsel auf native Verkaufszyklen und die gemeinsame Kamera-/Verkaufsprüfung sind im [Nachtrag zu 1.3.0](NATIVE-AUTOSELL-CAMERA-2026-10-30.md) beschrieben.

SoulFire bleibt auf 2.10.6 gepinnt; die eigene Controls-Erweiterung ist jetzt **1.2.0**. Keine neue Update-Ankündigung: Die Kennung der Glocke bleibt unverändert.

## Ursache und Änderung

Bei einem Rückstau im Ereignisstream meldet SoulFire `resyncRequired` und sendet anschließend einen frischen Spielstand. Der bisherige Client hat dabei dieselbe zweisekündige Pause wie nach einem Teleport gestartet und den laufenden Verkauf verworfen. Viele Pickups und Verkaufsmeldungen konnten diese Pause ständig neu auslösen. Jetzt wird nur der Inventarcache bis zum frischen Snapshot gesperrt. Anschließend werden Menüidentität und vorhandene Aktionen mit dem aktuellen Inventar abgeglichen. Die letzte bekannte Position bleibt erhalten, damit ein tatsächlich verpasster Weltwechsel weiterhin erkannt wird.

Zusätzlich brauchte jeder Stack einen eigenen RPC samt nativer Control-Task. Ein reservierter Aufruf der Controls-Erweiterung führt die normalen Shift-Klicks für das Spielerinventar jetzt gemeinsam auf dem Spielthread aus. Die bestehende SoulFire-Authentifizierung, Kontroll-Lease und erwartete Menüidentität gelten weiterhin. Der native Code akzeptiert ausschließlich das Verkaufsmenü und Slots aus dem Spielerinventar. Es werden keine Items aus fremden Menüs übertragen oder Items weggeworfen. Nach einem echten Fortschrittssignal wird das Menü geschlossen; verbleibende oder neu aufgesammelte Items kommen beim nächsten Durchlauf dran. Verkaufserlöse werden weiterhin ausschließlich aus Servermeldungen erfasst.

## Messungen

Isolierter Java-Protokollserver 1.8.8, SoulFire 2.10.6 unter Linux ARM64/Docker auf einem Mac M3 Pro. Zwei temporäre Offline-Accounts, je 1.500 tatsächlich übertragene Item-Entities, 36 unmittelbar nachgefüllte Verkaufsstacks. Kein Microsoft-Login, keine Verbindung zu HugoSMP oder anderen vorhandenen Spielservern. Der Vorher-Vergleich verwendet den Backend-Stand `d6f57ea` mit denselben nativen Bibliotheken; reguläre Einzelklicks bleiben in der neuen Erweiterung unverändert.

| Einstellung / Test | Ergebnis |
| --- | --- |
| Alter Stand, 0,5 s, nur drei Stacks und **keine** Boden-Items | Etwa 1.106–1.109 ms vor dem absichtlichen Teleport |
| Korrigiert, gleiche drei Stacks ohne Boden-Items | Median etwa 503 ms; einzelne 403–609 ms |
| Alter Stand, 0,5 s | 2.483 / 2.513 / 2.548 ms vor dem absichtlichen Teleport |
| Korrigiert, 0,5 s | Meist 501–505 ms; einzelne 425 / 604 ms |
| Korrigiert, 2 s | 1.937 / 2.089 / 2.013 ms vor dem absichtlichen Teleport |

Der Test teleportiert beide Accounts nach zehn Sekunden absichtlich. Das erzeugt eine zusätzliche Stabilisierungsphase (2.810 bzw. 3.730 ms zwischen Verkäufen), die nicht als ungestörtes Intervall gewertet wird. Stream-Resyncs treten weiterhin auf, starten aber keine zusätzliche Teleport-Pause mehr. Die Rohdaten enthalten alle Abstände, die gezählten Resyncs und RPC-Laufzeiten: [Messdaten](performance/sell-fix-2026-10-30/).

Diese Messungen sind keine Timing-Garantie für einen ausgelasteten Raspberry Pi oder einen verzögerten Spielserver. Die gemeinsame Automation gilt für beide Editionen; ein echter Bedrock-Login wurde für diese Prüfung nicht verwendet.

## Prüfungen und Einspielen

- Backend-/Frontend-Builds, Frontend-Lint und alle drei Linux-ARM64-Docker-Images erfolgreich.

Für diese Änderung **auch SoulFire neu bauen**, da der schnelle Sammeltransfer die native Erweiterung 1.2.0 benötigt:

```bash
cd /opt/afk-service && git pull --ff-only && bash scripts/update.sh --recreate
```

Der Verkaufstest ist über `backend/scripts/smoke-soulfire.mjs` mit einer ausdrücklich gewählten, isolierten SoulFire-Instanz wiederholbar. `MINECRAFT_FIXTURE_HOST` und `AFK_SMOKE_VERSION=1.8.8` decken Docker Desktop ab. Private Schlüssel und Microsoft-Caches gehören nicht in Messergebnisse.
