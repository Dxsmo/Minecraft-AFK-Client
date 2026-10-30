# Fernsteuerung: Eingaberückstau beim Verbinden

Der anschließende Wechsel zu kleineren Live-Bildern, begrenztem Rendering und Qualitätsrückmeldungen ist im [Kamera-Latenzbericht für Controls 1.4.0](CAMERA-LATENCY-2026-10-30.md) beschrieben.

Die Meldung „Die Verbindung ist zu langsam. Steuerung wurde freigegeben.“ kam aus dem eigenen Backend, sobald mehr als 256 unbearbeitete Eingabeereignisse warteten. Das war keine Messung der Internetgeschwindigkeit. Schon vor dem ersten Bild wurden Mausbewegungen gesammelt, alle 25 ms gesendet und einzeln hinter einer noch startenden oder langsamen nativen Eingabeanfrage aufgestaut. Eine schnelle Maus konnte das Limit deshalb bereits während des Verbindungsaufbaus überschreiten.

## Änderung

- Steuerungseingaben werden erst nach dem ersten erfolgreich dekodierten Bild aktiv. Escape und Verbindungs-Heartbeats funktionieren bereits während des Starts.
- Direkt aufeinanderfolgende Mausbewegungen werden im Browser und im Backend zusammengefasst. Relative Bewegungen werden addiert, bei absoluten Positionen gilt die neueste Position. Klicks, Taste drücken/loslassen und Wechsel der Eingabeart behalten ihre Reihenfolge. Werte bleiben im erlaubten Koordinatenbereich.
- Der Browser sendet höchstens ein noch nicht bestätigtes Datenpaket. Eine `inputAck`-Antwort bestätigt die tatsächliche Verarbeitung durch SoulFire. Weitere Eingaben werden währenddessen begrenzt gesammelt; leere Heartbeats laufen getrennt weiter. Die Bestätigung enthält keine nativen Capability-Tokens.
- Eingaben werden höchstens alle 50 ms regulär gebündelt; nach einer Bestätigung wird ein vorhandener Rückstau sofort weitergereicht. Unnötige Tastenwiederholungen außerhalb von Minecraft-Menüs entfallen. Gedrückte Tasten bleiben über den normalen Minecraft-Tastenzustand aktiv.
- Wenn eine Bestätigung wegen einer vollen Video-Ausgabe nicht gesendet werden konnte, wird sie beim nächsten Heartbeat erneut angeboten. Tastendrücke werden dabei nicht wiederholt. Wiederholte/veraltete Paketkennungen werden abgewiesen.
- Echte Tastatur-/Klick-Fluten bleiben begrenzt. Verbindungsausfall, Fokusverlust, Decoderfehler und Escape geben die Steuerung frei. Native Zeitüberschreitungen und Verbindungsabbrüche erhalten unterschiedliche Meldungen; die konkrete native Ausnahme wird ohne Eingabe-Capabilities im Backend protokolliert.

Die bisherige native Fünf-Sekunden-Grenze für blockierte Eingaben und die Freigabe bei einem stummen Browser bleiben bestehen. Es werden keine veralteten Tastendrücke nach einem Verbindungsabbruch erneut abgespielt.

## Prüfung

**485 Backend-Tests in 50 Dateien**, Backend-/Frontend-Builds, Frontend-Lint sowie Backend-/Web-Docker-Images erfolgreich. SoulFire und Controls bleiben auf 2.10.6 / 1.3.0; diese Korrektur benötigt keine native Änderung.

Gezielt geprüft: 3.000 Mausereignisse bei vier Sekunden blockierter nativer Eingabe, 1.000 absolute Mauspositionen während der Vorbereitung samt folgendem Klick, Reihenfolge von Taste drücken/loslassen, verlorene Bestätigung durch Video-Rückstau, doppelte Paketkennung, echte Eingabeflut, native Ausfälle, lokale Escape-Taste und Aufräumen nach Abbruch.

Im UI-Test mit echten H.264-Testbildern wurden zusätzlich 8.000 Mausereignisse vor dem ersten Bild ignoriert und 8.000 aktive Mausereignisse zusammengefasst. Bei 500 ms Bestätigungsverzögerung blieb maximal ein Eingabepaket unterwegs. Decoder-Erholung, Maustaste außerhalb des Bildes loslassen, Inventartaste, Fokusverlust und Erhalt der ursprünglichen Fehlermeldung funktionierten.

Echter Browser → Website-WebSocket → SoulFire → isolierter Java-1.8.8-Protokollserver, temporärer Offline-Account, Linux ARM64 unter Docker Desktop auf M3 Pro:

| Belastung / Messung | Ergebnis |
| --- | --- |
| 1.500 Boden-Items, 4 s zusätzliche Startvorbereitung | Erster Remote-Start 4.887 ms, zweiter 237 ms |
| 6.000 Mausereignisse während des Starts, danach ungefähr 1.000/s | Kein Rückstau-Abbruch |
| Zusätzlich eine native Eingabeanfrage künstlich um 3 s verzögert | Verbindung blieb bestehen; maximal ein unbestätigtes Datenpaket |
| Fernsteuerung während der Mauslast | Rund 15 FPS |
| Normale Live Cam mit gleichzeitigem AutoSell | 4,46 FPS, Verkaufsabstände 2.059 / 2.021 ms |

WASD, Inventar öffnen/schließen, Escape, erneuter Remote-Start, AutoSell-Pause während Remote und Wiederaufnahme danach wurden ebenfalls geprüft. Weitere native Checks: Mausblick, `/afk`-Sperre, Kamera nach Weltwechsel, Sneak, Spawner und Multiplikatoren. Rohdaten: [Messungen](performance/remote-input-backpressure-2026-10-30/).

Es gab keinen Test auf dem Produktions-Pi oder mit einem echten Bedrock-Login. Ein dauerhaft überlasteter Minecraft-Client kann weiterhin wegen einer echten nativen Zeitüberschreitung freigegeben werden. Die Warteschlange wird nicht durch längere Timeouts oder unbeschränktes Puffern versteckt.

## Einspielen

```bash
cd /opt/afk-service && git pull --ff-only && bash scripts/update.sh --recreate
```

Danach die Website mit **Strg+F5** neu laden, damit Browser und Backend dasselbe Bestätigungsprotokoll verwenden. Bestehende Accounts, Anmeldungen und Einstellungen bleiben erhalten. Die Glocken-Ankündigung wurde nicht geändert.

Der native Browsertest lässt sich mit `AFK_REMOTE_MOUSE_PRESSURE=1 AFK_REMOTE_RPC_DELAY_MS=4000 AFK_REMOTE_INPUT_DELAY_MS=3000 AFK_REMOTE_DROPPED_ITEMS=1500` über `backend/scripts/audit-remote-website.mjs` an einer ausdrücklich isolierten SoulFire-Instanz wiederholen. Der UI-Test ist `scripts/ui/remote-control-check.mjs`; er benötigt lokale Frontend-Dateien und eine über `AFK_REMOTE_VIDEO_FILE` erzeugte H.264-Fixture. Private SoulFire-Schlüssel und Microsoft-Caches gehören nicht in die Testdaten.
