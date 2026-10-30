# AutoSell bei vielen Items und Start der Fernsteuerung

SoulFire bleibt auf 2.10.6 gepinnt; die eigene Controls-Erweiterung ist jetzt **1.2.0**. Keine neue Update-Ankündigung: Die Kennung der Glocke bleibt unverändert.

## Ursache und Änderung

Bei einem Rückstau im Ereignisstream meldet SoulFire `resyncRequired` und sendet anschließend einen frischen Spielstand. Der bisherige Client hat dabei dieselbe zweisekündige Pause wie nach einem Teleport gestartet und den laufenden Verkauf verworfen. Viele Pickups und Verkaufsmeldungen konnten diese Pause ständig neu auslösen. Jetzt wird nur der Inventarcache bis zum frischen Snapshot gesperrt. Anschließend werden Menüidentität und vorhandene Aktionen mit dem aktuellen Inventar abgeglichen. Die letzte bekannte Position bleibt erhalten, damit ein tatsächlich verpasster Weltwechsel weiterhin erkannt wird.

Zusätzlich brauchte jeder Stack einen eigenen RPC samt nativer Control-Task. Ein reservierter Aufruf der Controls-Erweiterung führt die normalen Shift-Klicks für das Spielerinventar jetzt gemeinsam auf dem Spielthread aus. Die bestehende SoulFire-Authentifizierung, Kontroll-Lease und erwartete Menüidentität gelten weiterhin. Der native Code akzeptiert ausschließlich das Verkaufsmenü und Slots aus dem Spielerinventar. Es werden keine Items aus fremden Menüs übertragen oder Items weggeworfen. Nach einem echten Fortschrittssignal wird das Menü geschlossen; verbleibende oder neu aufgesammelte Items kommen beim nächsten Durchlauf dran. Verkaufserlöse werden weiterhin ausschließlich aus Servermeldungen erfasst.

Der Remote-Start hatte die serialisierte WebSocket-Berechtigungswarteschlange während seiner Vorbereitung blockiert. Heartbeats, Stop und weitere Eingaben konnten dahinter warten. Die Vorbereitung läuft jetzt außerhalb dieser Warteschlange; die einzelnen Eingaben werden weiterhin einzeln autorisiert. Die native Eingabeanfrage hat ein Zeitlimit von sechs Sekunden, passend zum nativen Spielthread-Limit von fünf Sekunden. Ein stummer Browser wird nach fünf Sekunden freigegeben; ein Start ohne Videobild endet nach 25 Sekunden mit einem konkreten Fehler. Die native Erweiterung gibt Auto button und Sneak beim Wechsel einmalig frei und lässt danach die Fernsteuerung übernehmen.

Die Oberfläche überschreibt eine konkrete Fehlermeldung nicht mehr beim anschließenden Schließen des Sockets. Dauerhafte Decoderfehler und ein Start ohne Bild bleiben ebenfalls nicht in einer endlosen Ladeanzeige hängen. Die Decoderwahl übernimmt der Browser.

## Messungen

Isolierter Java-Protokollserver 1.8.8, SoulFire 2.10.6 unter Linux ARM64/Docker auf einem Mac M3 Pro. Zwei temporäre Offline-Accounts, je 1.500 tatsächlich übertragene Item-Entities, 36 unmittelbar nachgefüllte Verkaufsstacks. Kein Microsoft-Login, keine Verbindung zu HugoSMP oder anderen vorhandenen Spielservern. Der Vorher-Vergleich verwendet den Backend-Stand `d6f57ea` mit denselben nativen Bibliotheken; reguläre Einzelklicks bleiben in der neuen Erweiterung unverändert.

| Einstellung / Test | Ergebnis |
| --- | --- |
| Alter Stand, 0,5 s, nur drei Stacks und **keine** Boden-Items | Etwa 1.106–1.109 ms vor dem absichtlichen Teleport |
| Korrigiert, gleiche drei Stacks ohne Boden-Items | Median etwa 503 ms; einzelne 403–609 ms |
| Alter Stand, 0,5 s | 2.483 / 2.513 / 2.548 ms vor dem absichtlichen Teleport |
| Korrigiert, 0,5 s | Meist 501–505 ms; einzelne 425 / 604 ms |
| Korrigiert, 2 s | 1.937 / 2.089 / 2.013 ms vor dem absichtlichen Teleport |
| Browser → echte Website-WebSocket-Verbindung → native Fernsteuerung | Start 911 / 152 ms; Bewegung, Inventar, Escape und erneuter Start erfolgreich |
| Gleicher Browsertest mit 1.500 Items und absichtlich 4 s zusätzlicher RPC-Vorbereitung | Start 4.625 / 217 ms; dieselben Funktionen erfolgreich |

Der Test teleportiert beide Accounts nach zehn Sekunden absichtlich. Das erzeugt eine zusätzliche Stabilisierungsphase (2.810 bzw. 3.730 ms zwischen Verkäufen), die nicht als ungestörtes Intervall gewertet wird. Stream-Resyncs treten weiterhin auf, starten aber keine zusätzliche Teleport-Pause mehr. Die Rohdaten enthalten alle Abstände, die gezählten Resyncs und RPC-Laufzeiten: [Messdaten](performance/sell-remote-fix-2026-10-30/).

Diese Messungen sind keine Timing-Garantie für einen ausgelasteten Raspberry Pi oder einen verzögerten Spielserver. Die gemeinsame Automation gilt für beide Editionen; ein echter Bedrock-Login wurde für diese Prüfung nicht verwendet.

## Prüfungen und Einspielen

- 476 Backend-Tests in 50 Dateien erfolgreich, einschließlich verzögerter Remote-Vorbereitung, Stop während des Starts, fehlendem Videobild und Resync während eines Verkaufs.
- Backend-/Frontend-Builds, Frontend-Lint und alle drei Linux-ARM64-Docker-Images erfolgreich.
- Echter H.264-Browsertest über die Website mit nativen Spielpaketen; zusätzlicher UI-Check für Decoder-Erholung, lokale Escape-Taste, Mouseup außerhalb des Bildes, Fokusverlust und Erhalt der ursprünglichen Fehlermeldung.

Für diese Änderung **auch SoulFire neu bauen**, da der schnelle Sammeltransfer die native Erweiterung 1.2.0 benötigt:

```bash
cd /opt/afk-service && git pull --ff-only && bash scripts/update.sh --recreate
```

Die Tests sind über `backend/scripts/smoke-soulfire.mjs` und `backend/scripts/audit-remote-website.mjs` mit einer ausdrücklich gewählten, isolierten SoulFire-Instanz wiederholbar. Die Testinstanz benötigt für den zweiten Test Zugriff auf den Host-Protokollserver; `MINECRAFT_FIXTURE_HOST` und `AFK_SMOKE_VERSION=1.8.8` decken Docker Desktop ab. Der Browsercheck nutzt eine temporäre Datenbank und räumt seine Accounts anschließend auf. Private SoulFire-Schlüssel gehören nicht ins Repository oder in Messergebnisse.
