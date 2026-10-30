# AutoSell direkt im Client und flüssigere Live Cam

Die anschließende Korrektur für überlaufende Steuerungseingaben beim Remote-Start ist im [Bericht zum Eingaberückstau](REMOTE-INPUT-BACKPRESSURE-2026-10-30.md) dokumentiert.

Nachtrag zu [AutoSell/Remote-Fix 1.2.0](AUTOSELL-REMOTE-FIX-2026-10-30.md). SoulFire bleibt auf **2.10.6**, die Controls-Erweiterung ist **1.3.0**. Die Texte der vier Feature-Ankündigungen wurden wie gewünscht angepasst. Die Ankündigungskennung und bereits gelesene Updates bleiben erhalten.

## Warum der bisherige Fix nicht ausreichte

Der Verkaufsablauf brauchte trotz Sammeltransfer noch Website-Ereignisse zum Erkennen des geöffneten Menüs und zum Schließen nach einem Transfer. Unter hoher Ereignislast können genau diese kurzen Menüzustände im Stream verloren gehen. Dann wartete das Backend zehn Sekunden auf ein Menü, das im tatsächlichen Minecraft-Client bereits offen war. Ein späterer Menü-Snapshot konnte den Verkauf wieder fortsetzen. Das erklärt eine mögliche Ursache der langen Lücken zwischen erfolgreichen Verkäufen; der konkrete Produktionsserver wurde hier nicht vermessen.

Die Screenshot-Ausgabe der gepinnten Engine rendert außerdem in einer Schleife, bis alle sichtbaren Weltabschnitte fertig sind, mit einem Fehlerlimit von 30 Sekunden. Jeder weitere Live-Screenshot kann erneut in diese Schleife laufen. Rendering und Spielaktionen beanspruchen denselben Client-Thread. Deshalb wurde diesmal auch die Kombination aus laufender Kamera, vielen Items und AutoSell geprüft.

## Änderung

- AutoSell öffnet, befüllt und schließt das bekannte Verkaufsmenü jetzt direkt auf dem nativen Client-Thread. Die Website übermittelt Konfiguration und erneuert alle fünf Sekunden eine 15 Sekunden gültige Freigabe. Fehlende Inventar-Snapshots und verzögerte Status-RPCs bestimmen den Verkaufstakt nicht mehr.
- Es werden normale Shift-Klicks auf Slots des Spielerinventars verwendet. Fremde Menüs bleiben unangetastet. Kein Wegwerfen von Items; Erlöse stammen weiterhin ausschließlich aus Servermeldungen. Das Schließen wird nach dem Senden der regulären Klicks in derselben geordneten Paketfolge gesendet. Der Spielserver entscheidet über Annahme, Preise und gegebenenfalls Rückkorrekturen.
- Das Intervall beginnt beim Absenden des Verkaufsbefehls. Es werden keine parallelen Verkaufsabläufe aufgestaut. Ohne Menüantwort erfolgt nach drei Sekunden ein erneuter Versuch; echte fehlende Antworten werden höchstens alle 30 Sekunden im SoulFire-Log gemeldet. Die alte Website-Warnung läuft für diesen nativen Ablauf nicht mehr.
- Deaktivieren, Neustart-Verkaufspause, Teleports/Weltwechsel, manuelle Befehle und Fernsteuerung werden berücksichtigt. Eine abgelaufene Website-Freigabe stoppt AutoSell. Manuelle Chatbefehle bleiben auch bei fehlender Inventar-Telemetrie möglich; Menüaktionen brauchen weiterhin einen gültigen Snapshot.
- Live-Bilder verwenden den vorhandenen Einzelbild-Ausgang des interaktiven Renderers samt dessen Aufräumpfad. Fertige Weltabschnitte erscheinen schrittweise im nächsten Bild. Debug-Aufnahmen behalten das ursprüngliche Verhalten. Der Eingriff prüft die genaue Struktur der gepinnten Engine beim Start und bricht bei einer unerwarteten Struktur ab.
- Live Cam und Remote nutzen **480 × 270 Pixel**. Live-Bilder werden nach 150 ms plus Renderzeit erneut angefragt; Remote hat maximal 15 FPS. Sichtweite zwei Chunks, schnelle Grafik, keine Wolken/Entity-Schatten und minimale Partikel. Für die Kamera werden höchstens 128 sichtbare Boden-Items mit jeweils einem Modell dargestellt. Alle echten Item-Entities bleiben im Spiel vorhanden und aufhebbar.
- Weiterhin ein geteilter Live-Stream pro betrachtetem Account; ohne Zuschauer kein Kamera-Rendering. Beim Wechsel zur Fernsteuerung stoppt die normale Live Cam.

## Gemessen und geprüft

Isolierte Java-1.8.8-Protokollserver mit temporären Offline-Accounts, Linux ARM64/SoulFire in Docker Desktop auf einem Mac M3 Pro; Software-Rendering mit llvmpipe. Die Server-Fixtures bestätigen die übertragenen Inventaraktionen und erzeugen Test-Verkaufsmeldungen. Das ist kein Durchsatztest des echten HugoSMP-Verkaufsplugins.

| Test | Ergebnis |
| --- | --- |
| Zwei Clients, je 1.500 Boden-Items, 36 belegte Verkaufsslots, Intervall 2 s | 2.001–2.054 ms zwischen Befehlen; 70 Stream-Resyncs |
| Gleiche Last, 0,5 s; alle Inventar-Events an die Website absichtlich unterdrückt | 508–548 ms; 31 verworfene Inventar-Events; 80 Resyncs |
| Erste Menüantwort absichtlich verloren, weiterhin keine Inventar-Events | Neuer Versuch nach 3.030 ms; danach 2.001–2.006 ms |
| Fehlende erste Menüantwort bei 60-s-Intervall | Wiederholung nach 3.042 ms, ohne eine Minute zu warten |
| Echter Browser → Website-WebSocket → Live Cam, 1.500 Items, gleichzeitig AutoSell | 4,77 FPS; Verkaufsabstände 2.031 / 2.022 ms |
| Gleicher Browser → native H.264-Fernsteuerung | Rund 15 FPS, zwei Starts; 144 Video-Frames |
| Remote-Start mit absichtlich 4 s verzögerter Vorbereitung | Erster Start 4.629 ms; erneuter Start 130 ms |

Zusätzlich nativ geprüft: AutoSell deaktivieren/reaktivieren, Neustartpause, abgelaufene Freigabe, `/afk`-Sperre auch als AutoSell-Befehl, Verkaufspause während Remote und Wiederaufnahme danach, WASD, Inventar öffnen/schließen, Mausblick, Escape und erneuter Start, Kamera nach Weltwechsel, geteilte Kamera für zwei Zuschauer und Stop nach letztem Zuschauer, durchgehendes Sneak, Dauer-Maustasten, Spawner-Aufräumen und Multiplikatoren.

**477 Backend-Tests in 50 Dateien**, Backend-/Frontend-Builds, Frontend-Lint und alle drei Docker-Images erfolgreich. Die Rohdaten liegen unter [performance/native-sell-camera-2026-10-30/](performance/native-sell-camera-2026-10-30/).

Die Bildrate und tatsächliche Verkaufsgeschwindigkeit hängen weiterhin von CPU, Welt, Netzwerk und Spielserver ab. Es gab keinen Test auf dem Produktions-Pi und keinen echten Bedrock-Login. Beide Editionen verwenden denselben nativen Minecraft-Verkaufsablauf, Bedrock zusätzlich die ViaBedrock-Übersetzung.

## Einspielen

Alle drei Dienste neu bauen, damit Backend und native Erweiterung zusammenpassen:

```bash
cd /opt/afk-service && git pull --ff-only && bash scripts/update.sh --recreate
```

Keine Datenbankmigration. Account-Anmeldungen, Einstellungen, Bilder und Lesestatus bleiben in den bestehenden Volumes.

Die reproduzierbaren Fixtures sind `backend/scripts/smoke-soulfire.mjs`, `backend/scripts/audit-soulfire-actions.mjs` und `backend/scripts/audit-remote-website.mjs`. Eine ausdrücklich gewählte isolierte SoulFire-Instanz ist Voraussetzung. `AFK_SMOKE_DROP_INVENTORY=1`, `AFK_SMOKE_DROP_FIRST_MENU=1` und `AFK_SMOKE_NATIVE_CHECKS=1` aktivieren die Fehlerprüfungen. `AFK_REMOTE_DROPPED_ITEMS=1500` und `AFK_REMOTE_RPC_DELAY_MS=4000` aktivieren den belasteten Browsertest. Keine privaten Schlüssel oder Microsoft-Caches in Testberichte übernehmen.
