# Verbindungsstabilität und AutoSell bei großen Item-Haufen

SoulFire bleibt auf 2.10.6 gepinnt. Die native Erweiterung ist jetzt 1.5.0.
Accountdaten und Anmeldungen benötigen keine Migration. Die Kennung der
Website-Ankündigung bleibt unverändert.

## Ereignisstream und Minecraft-Verbindung

Ein abgebrochener `WatchBotEvents`-Stream hat bisher die gesamte Session
beendet und den noch verbundenen Minecraft-Bot gestoppt. Jetzt wird bei einem
vorübergehenden Transportfehler nur der Ereignisstream erneut abonniert:
500 ms Wartezeit, bei weiteren Fehlversuchen schrittweise bis fünf Sekunden.
Der Inventarcache wird verworfen; ein frischer Snapshot stellt ihn wieder her.
Die letzte bekannte Position bleibt zur Erkennung verpasster Weltwechsel erhalten.
Die native Verkaufsfreigabe und die unabhängige Statusabfrage laufen weiter.

Echte Minecraft-Disconnects und fehlgeschlagene Bot-Zustände beenden weiterhin
die Session mit dem Servergrund und verwenden die konfigurierte Reconnect-Regel.
Berechtigungs-, Konfigurations- und Authentifizierungsfehler werden nicht als
vorübergehende Streamfehler wiederholt. Stop bricht auch einen wartenden
Stream-Wiederholungsversuch sofort ab.

Fehlermeldungen enthalten jetzt auch verschachtelte Netzwerkursachen wie
`ECONNRESET` oder `EAI_AGAIN`, soweit der Transport sie bereitstellt. Request-
Objekte und deren Zugangsdaten werden dafür nicht serialisiert. Eine
Streamwarnung wird höchstens alle 30 Sekunden ausgegeben.

Der ursprüngliche Logauszug beweist keinen bestimmten Netzwerkfehler oder
JVM-Neustart. Die Korrektur beseitigt den nachgestellten, unnötigen Game-Logout
nach einem Telemetriefehler; der neue Fehlertext verbessert die weitere Diagnose.

## Kollisionssuche bei Boden-Items

Der belastete native Spielthread wurde in
`EntitySection.getEntities → EntityGetter.getEntityCollisions → ItemEntity.tick`
angetroffen. Jedes bewegte Item durchsucht dort die übrigen Entities im selben
Bereich, obwohl Boden-Items nicht miteinander kollidieren. Bei einem dichten
Haufen wächst dieser Aufwand quadratisch.

Die Erweiterung hält für Item-Kollisionsabfragen pro Client-Welt eine Liste der
anderen Entity-Typen vor. Die Liste wird bei jedem Entity-Tick und bei Spawn/
Entfernen ungültig. Bounding-Boxen und Kollisionsprädikate werden bei jeder
Abfrage aktuell ausgewertet, einschließlich der übrigen kollidierbaren Entities.
Die Änderung gilt ausschließlich für die verwalteten SoulFire-Clients und für
Item-Kollisionsabfragen. Blockkollisionen, Item-Physik, Inventory-Pakete und
serverseitige Pickups werden weiter regulär verarbeitet.

AutoSell verwendet weiterhin normale Shift-Klicks auf das Spielerinventar im
bekannten Verkaufsmenü. Der Spielserver bestimmt Annahme und Erlös.

## Prüfung

Isolierte Java-1.8.8-Protokoll-Fixture, zwei temporäre Offline-Accounts,
SoulFire unter Linux ARM64/Docker mit zwei CPU-Kernen und 3 GiB Speicher.
Jeweils 36 belegte, sofort nachgefüllte Verkaufsstacks und 0,5 Sekunden
Verkaufsintervall. Die Fixture teleportiert nach zehn Sekunden absichtlich;
die kurze Stabilisierungsphase ist Teil des Ablaufs.

| Last pro Account | Verkaufsabstände |
| --- | --- |
| 5.000 Boden-Items, bisheriger nativer Stand | 1.540–1.831 ms |
| 5.000 Boden-Items, Korrektur | 500–565 ms |
| 10.000 Boden-Items, laufende Pickups, einmaliger Streamabbruch | 503–649 ms |

Der letzte Test führte 1.791 Pickup-/Nachfüllvorgänge und 2.484 bestätigte
Shift-Klicks aus, einschließlich einer zusätzlichen Haltephase von 30 Sekunden.
Der Stream wurde nach einem injizierten `ECONNRESET` wieder geöffnet. Beide
Minecraft-Verbindungen blieben bestehen; es gab keine erneute Anmeldung.
Manuelle Befehle und der unabhängige Stop eines Accounts funktionierten weiter.
Hintergrundautomation verwendete keine Kamera- oder Inventory-Rendering-RPCs.

Zusätzlich erfolgreich: 477 Backend-Tests in 50 Dateien, Backend-/Frontend-Builds,
Frontend-Lint, Kompilierung gegen das checksum-gepinnte SoulFire-Release und
Laden der Erweiterung in der isolierten JVM. Native Funktionsprüfungen decken
Sneak, Spawner, neun Multiplikatoren, geteilte Live Cam und Kamera-Wiederaufnahme
nach Weltwechsel ab. Chrome-Prüfungen decken die reine Liveansicht auf Desktop/
Mobilgeräten sowie die Website-Ankündigung und deren Lesestatus ab.

[Messdaten und Browserergebnisse](performance/stability-2026-11-03/).
Das sind lokale Fixture-Ergebnisse; der Produktions-Pi und ein echter
Bedrock-Login wurden nicht vermessen.

Für eine Wiederholung nach dem Backend-Build `backend/scripts/smoke-soulfire.mjs`
mit `SOULFIRE_URL`, `SOULFIRE_SECRET_KEY_FILE` und einer ausdrücklich isolierten
SoulFire-Instanz ausführen. `MINECRAFT_PROTOCOL_MODULE` kann auf eine separate
Installation von `minecraft-protocol` zeigen. Für die belastete Variante:

```bash
AFK_SMOKE_VERSION=1.8.8 \
AFK_SMOKE_DROPPED_ITEMS=10000 \
AFK_SMOKE_REFILL_SALES=1 \
AFK_SMOKE_SELL_STACKS=36 \
AFK_SMOKE_INTERVAL_SECONDS=0.5 \
AFK_SMOKE_MAX_PERIOD_MS=900 \
AFK_SMOKE_BREAK_EVENT_STREAM=1 \
AFK_SMOKE_ITEM_PICKUPS=1 \
AFK_SMOKE_SOAK_SECONDS=30 \
node backend/scripts/smoke-soulfire.mjs
```

Für Docker Desktop zusätzlich `MINECRAFT_FIXTURE_HOST=host.docker.internal` setzen.

## Einspielen

Backend, Web und SoulFire gemeinsam neu bauen, damit die native Erweiterung
ebenfalls aktualisiert wird:

```bash
bash scripts/update.sh --recreate
```

Es werden die bestehenden Datenvolumes weiterverwendet.
