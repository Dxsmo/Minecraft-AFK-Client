# Ressourcenmessung für Backend, Java und Bedrock

Aktuelle lokale SoulFire-/Website-Messung: [Funktions- und Performanceprüfung vom 30.10.2026](PERFORMANCE-2026-10-30.md). Sie enthält echte isolierte SoulFire-Tests, jedoch keine Kapazitätsmessung des produktiven Pi.

Die folgenden Angaben dokumentieren den früheren Stand vom 28.10.2026 und die damalige Azalea-/Bedrock-Architektur. Die maximal tragbare Accountzahl auf dem Pi oder einem Hetzner-Server ist weiterhin nicht gemessen. Ein SSH-Ziel zum produktiven Host ist nicht eingerichtet bzw. nicht bekannt.

## Erste Prozesswerte vom produktiven Pi

Der Nutzer bedient den Pi über RealVNC und hat die Ausgaben von `free -h`,
`docker stats --no-stream` und `docker top` bereitgestellt. Das ist eine
Momentaufnahme ohne verifizierte Online-Accountzahlen oder Automatisierungen.

| Beobachtete Prozesse | Anzahl | RSS insgesamt | RSS je Prozess im Mittel |
| --- | ---: | ---: | ---: |
| Java/Azalea | 13 | 777,2 MiB | 59,8 MiB |
| Weitere Node-Prozesse, vermutlich Bedrock | 3 | 743,7 MiB | 247,9 MiB |
| Backend | 1 | 339,2 MiB | 339,2 MiB |

Die 13 Java-Prozesse liegen zwischen 14,8 und 118,0 MiB RSS; Median 58,6 MiB.
Die zusätzlichen Node-Kinder passen zur Bedrock-Architektur des Projekts,
ihre Zuordnung muss aber noch anhand des Skriptpfads bzw. Dashboards bestätigt
werden. Alle Prozess-RSS zusammen einschließlich Shell ergeben rund 1,82 GiB;
gemeinsam genutzte Seiten sind dabei mehrfach gezählt, ausgelagerte Seiten
fehlen.

Der Host meldet gerundet 7,9 GiB RAM, 4,4 GiB benutzt und 3,4 GiB verfügbar.
1,1 GiB Swap sind belegt. Ob aktuell ausgelagert wird und welcher Anteil auf
die Bots entfällt, ist daraus nicht ersichtlich. Der frühere Docker-Snapshot
meldet 111,14 % CPU für das Backend, also etwa 1,11 Kerne; auf einem Vierkern-Pi
wären das 27,8 % der gesamten CPU-Kapazität. Die CPU-Spalte von `docker top`
enthält hingegen Lebenszeit-Durchschnitte der einzelnen Prozesse. Diese Zahlen
werden nicht als gemeinsame aktuelle CPU-Messung zusammengerechnet.

Docker meldet `0B / 0B` für RAM, deshalb sind seine Speicherwerte hier nicht
auswertbar. Die PIDS-Spalte enthält auch Threads, keine Online-Accountzahl.
Aus diesem Snapshot wird keine Pi-/Hetzner-Kapazität hochgerechnet.

Anschließend hat der Nutzer `vmstat 2 16` ausgeführt. Nach Ausschluss der ersten
Zeile (CPU-/I/O-Werte seit Systemstart) ergeben 15 Intervalle über 30 Sekunden:
CPU-Rechenlast im Mittel 29,0 % (21,1 % User, 7,9 % Kernel), Spitzenwert pro
Zwei-Sekunden-Intervall 42,0 %, im Mittel 69,1 % Idle und 1,8 % I/O-Wartezeit.
Die kleinen Differenzen zu 100 % entstehen durch gerundete Ausgabewerte.
`si` und `so` sind in allen aktuellen Intervallen null, Swap bleibt konstant
bei 1.191.664 KiB (rund 1,14 GiB). In diesem Fenster wurde also weder ein- noch
ausgelagert. Das spricht gegen akuten Swap-Druck in genau diesem Zeitraum,
beweist aber keine allgemeine Lastgrenze. Die CPU-Werte betreffen den gesamten
Pi einschließlich Desktop/VNC und sonstiger Dienste, nicht nur die Bots.

[Übertragene Werte und Berechnung](performance/resources-pi-snapshot-2026-10-28.json).

## 30-Sekunden-Messung je Bot-Prozess auf dem Pi

Der Nutzer hat den folgenden Messlauf aus dem produktiven Backend-Container
als Screenshot übermittelt. Das Skript liest den Prozess-CPU-Zähler zu Beginn
und nach 30 Sekunden und ordnet die Edition anhand des ausgeführten Skript-
bzw. Programmpfads zu. Es erfasst am Ende RSS, PSS und Swap-PSS. Die Messung
startet oder stoppt keine Accounts. PIDs und Kommandozeilen sind dabei im
Container-Namespace; die PIDs unterscheiden sich deshalb von `docker top`.

| Gruppe | Prozesse | CPU insgesamt, ein Kern = 100 % | PSS insgesamt | PSS je Prozess |
| --- | ---: | ---: | ---: | ---: |
| Java mit messbarer CPU-Aktivität | 12 | 96,0 % | 497,4 MiB | 41,5 MiB |
| Weiterer Java-Prozess ohne gemessene CPU-Aktivität | 1 | 0,0 % | 4,2 MiB | 4,2 MiB |
| Bedrock | 4 | 31,4 % | 726,8 MiB | 181,7 MiB |
| Backend | 1 | 2,5 % | 296,6 MiB | 296,6 MiB |
| Shell | 1 | 0,0 % | 0,3 MiB | 0,3 MiB |

Vorher und nachher wurden jeweils 19 Prozesse beobachtet. Kein ausgewiesener
Prozess hat einen unbekannten CPU-Wert. Der zusätzliche Java-Prozess ist nicht
als fehlerhaft oder offline nachgewiesen; sein geringer Speicher und die fehlende
CPU-Aktivität sind lediglich nicht repräsentativ für die übrigen Java-Bots.

Die 12 Java-Prozesse mit CPU-Aktivität benötigen im Mittel 8,0 % eines Kerns,
mit 7,3–10,6 % pro Prozess. Ihr PSS liegt überwiegend zwischen 30,6 und 46,9 MiB;
ein Prozess liegt bei 95,8 MiB. Der Mittelwert beträgt 41,45 MiB. Bedrock benötigt
im Mittel 7,85 % eines Kerns (4,6–13,5 %) und 181,7 MiB PSS (161,9–204,5 MiB).
Die Online-Zustände und Automatisierungen sind weiterhin nicht separat bestätigt.

Alle gemessenen Prozesse zusammen ergeben ungefähr 129,9 % eines Kerns und
1.525,3 MiB PSS (rund 1,49 GiB). Auf einem Vierkern-Pi entspricht diese CPU-Zeit
32,5 % der gesamten CPU-Kapazität; andere Hostprozesse kommen hinzu. Die früher
gemessenen 29 % Hostlast stammen aus einem anderen Messfenster und einer
anderen Prozessbelegung. Die RSS-Summe beträgt dagegen 2.011,7 MiB; sie enthält
mehrfach gezählte gemeinsame Seiten und ist nicht gleich physisch exklusiv
belegtem Speicher.

Jeder Prozess zeigt gerundet 0,0 MiB Swap-PSS. Bei diesen Bot-/Backend-Prozessen
ist in dieser Aufnahme also kein nennenswerter ausgelagerter Speicher sichtbar.
Die früheren 1,14 GiB belegten Host-Swaps dürfen ihnen nicht pauschal zugerechnet
werden. Ein zeitgleicher Wert für den verfügbaren Host-RAM fehlt in diesem Lauf.

### Vorläufige Kapazitätsrechnung

Unter der beobachteten Java-Last sind 8 % eines Kerns pro Prozess ungefähr
0,08 Kerne CPU-Zeit. 80 gleich belastete Java-Prozesse würden rechnerisch
6,4 Kerne dieser CPU-Leistung benötigen, mehr als ein Vierkern-Pi bereitstellt.
35 solche Prozesse benötigen bereits 2,8 Kerne, also 70 % eines Vierkern-Pi,
ohne Backend, Desktop/VNC und weitere Hostdienste. **Etwa 30–35 gleich belastete
Java-Prozesse sind damit ein vorläufiger Planungsbereich mit CPU-Reserve, keine
gemessene stabile Obergrenze.** Andere Szenen oder deaktivierte Automatisierungen
können andere Werte ergeben. Bei Bedrock ist zusätzlich der deutlich größere
RAM-Bedarf entscheidend; ohne zeitgleichen Host-Grundverbrauch wird dafür keine
feste Accountgrenze angegeben.

Die Messung dauert nur 30 Sekunden und weist keine langfristige Stabilität oder
Maximalbelegung nach. Für die Serverwahl werden längere Messfenster mit
repräsentativer Last und eine Bestätigung auf der Zielhardware benötigt;
Pi-CPU-Zeit ist nicht eins zu eins auf Hetzner-vCPUs übertragbar.

[Abgelesene Prozesswerte und Berechnung](performance/resources-pi-processes-2026-10-28.json).

## Lokaler Backend-Test

Hardware: Apple M3 Pro, 12 logische CPUs, 36 GiB RAM, macOS/arm64, Node 24.13.0.
Jede Phase dauerte 30 Sekunden. Gemessen wurde der eigene CPU-Verbrauch des
Backend-Prozesses und dessen RSS, mit einer RAM-Stichprobe pro Sekunde. Die
HTTP-Last erzeugte ein separater Prozess.

| Phase | RSS Mittel | RSS Maximum | CPU Mittel, ein Kern = 100 % |
| --- | ---: | ---: | ---: |
| Leeres Backend, Leerlauf | 222,4 MiB | 222,4 MiB | 0,36 % |
| 100 gespeicherte Offline-Accounts, Leerlauf | 229,6 MiB | 229,6 MiB | 0,35 % |
| 100 Offline-Accounts, API- und Loglast | 308,8 MiB | 346,9 MiB | 24,70 % |

Die Lastphase bestand aus 592 echten HTTP-Anfragen und 592 synthetischen
Logeinträgen in 30 Sekunden, also jeweils etwa 20/s. Alle Anfragen lieferten
HTTP 200, keine Lastbatches wurden übersprungen. Antwortzeit: Mittel 10,4 ms,
P95 26,4 ms, Maximum 33,1 ms. Angefragt wurden Dashboard-Accounts, 2.000
Konsolenzeilen, Verdienst und Systemstatus. Die isolierte Datenbank enthielt
100 Offline-Accounts und zunächst 20.000 Logeinträge.

Die Testdaten wurden **in einem separaten Prozess** angelegt. Ein erster
Vorversuch mit Massenerstellung im gemessenen Prozess behielt deren Speicher
im Allocator und zeigte deshalb höhere RAM-Werte. Dieser Vorversuch wird nicht
als Backend-Grundverbrauch verwendet.

[Rohdaten des maßgeblichen Laufs](performance/resources-local-2026-10-28.json).

### Grenzen dieser Ergebnisse

- Kein Minecraft-Account war verbunden. 100 gespeicherte Offline-Accounts sind
  kein Test mit 100 laufenden Bots.
- Die Messung umfasst Fastify, Prisma und die Accountverwaltung, aber keinen
  Caddy, Cloudflare-Tunnel, Browser oder authentifizierten WebSocket-Verkehr.
- Der Harness startet die echte App und lädt die Offline-Clients, führt aber
  nicht sämtliche Wartungs-/Startschritte aus `server.ts` aus.
- Kurze Phasen zeigen keine mehrtägige Speicherentwicklung und keine
  Verbindungs-/Teleportspitzen. Die Phasen liefen nacheinander; JIT-, Allocator-
  und Cachezustand bleiben dabei erhalten.
- Mac-RSS und CPU-Verbrauch sind nicht direkt auf Pi/Linux oder geteilte
  Hetzner-vCPUs übertragbar. Aus den obigen Zahlen folgt keine Accountgrenze.
- Der P95 der Event-Loop-Verzögerung in den Rohdaten enthält die nominelle
  Abtastauflösung von 20 ms; er ist keine zusätzliche HTTP-Latenz.

### Wiederholung

Im Verzeichnis `backend/` nach `npm run build`:

```bash
node scripts/benchmark-resources.mjs
```

`RESOURCE_BENCH_SECONDS=60` verlängert jede Phase. Mit
`RESOURCE_BENCH_OUTPUT=/tmp/mein-resource-report.json` lässt sich der Ausgabeort
wählen. Das Skript legt eine neue Datenbank in einem temporären Verzeichnis an,
deaktiviert das Laden lokaler `.env`-Dateien und verwendet keine bestehenden
Accounts oder Anmeldedaten. Die temporären Fixtures bleiben zum Prüfen erhalten;
der genaue Pfad wird am Ende ausgegeben.

## Live-Messung auf dem Pi/Linux-Host

Das vorbereitete Skript
[`scripts/performance/measure-host.py`](../scripts/performance/measure-host.py)
liest nur Prozess- und Systemmetriken. Es startet/stoppt keine Bots, verändert
keine Einstellungen und benötigt keine Website-Anmeldedaten. Python 3 mit
Standardbibliothek reicht aus. Das Skript muss auf dem **Host** laufen, damit
auch Prozesse verschiedener Docker-Container sichtbar sind.

Aus dem ausgecheckten Repository auf dem Pi, während die Accounts laufen:

```bash
sudo python3 scripts/performance/measure-host.py \
  --duration 600 \
  --interval 2 \
  --label normale-farm \
  --output /tmp/afk-farm-resources.json
```

Bei mehreren Backend-Installationen kann der Prozessbaum eingeschränkt werden.
Für unseren Compose-Container:

```bash
sudo python3 scripts/performance/measure-host.py \
  --backend-pid "$(docker inspect --format '{{.State.Pid}}' afk-backend)" \
  --duration 600 \
  --label normale-farm \
  --output /tmp/afk-farm-resources.json
```

Die Datei darf noch nicht existieren. Sie wird mit Modus 0600 erstellt.
Bei Strg+C wird die bis dahin gesammelte Messung gespeichert.

### Erfasste Metriken

- Java/Azalea, Bedrock, Backend/Hilfsprozesse, Caddy und Cloudflare-Tunnel als
  getrennte Gruppen; außerdem Einzelwerte pro PID/Prozesslebensdauer.
- CPU aus den Differenzen der Prozesszähler, nicht aus lebenslangen `ps`-
  Durchschnittswerten. 100 % entsprechen einem logischen Kern; Gruppen können
  daher über 100 % erreichen. CPU-Mittel werden nach Intervalllänge gewichtet.
- RSS sowie, falls lesbar, PSS. PSS verteilt gemeinsam genutzte Seiten anteilig
  und eignet sich besser für die RAM-Planung mehrerer ähnlicher Prozesse.
  Fehlendes PSS wird als `null` ausgewiesen, nicht durch RSS ersetzt.
- Host-RAM anhand `MemAvailable`, Swap, CPU-Auslastung, I/O-Wartezeit,
  CPU-Steal, Load und Netzwerkzähler pro Interface. Virtuelle Interfaces dürfen
  nicht einfach addiert werden, da sonst Traffic mehrfach gezählt werden kann.
- CPU-/Boardmodell und Temperaturen am Messende, soweit verfügbar.

Die JSON-Datei enthält keine Kommandozeilen, Accountnamen, Tokens oder
Passwörter. **Prozesszahl ist nicht gleich Online-Accountzahl**: Ein Bot kann
gerade verbinden, auf Authentifizierung warten oder neu starten. Während der
Messung deshalb im Dashboard die Zahl tatsächlich verbundener Java- und
Bedrock-Accounts und aktive Automatisierungen notieren. Kurzlebige Prozesse
oder Spitzen zwischen zwei Stichproben können unvollständig erfasst werden.
Bei mehreren Webinstallationen prüfen, ob automatisch erkannte Caddy-/Tunnel-
Prozesse tatsächlich zu diesem Projekt gehören.

## Von Messwerten zur Serverwahl

Zuerst je 10–15 Minuten an der tatsächlichen Farm messen, möglichst mit beiden
Editionen. Ruhigen Betrieb, Auto-Sell und eine stärker belastete Phase getrennt
beschriften. Eine längere Messung erfasst anschließend Weltwechsel, Reconnects
und Speicherentwicklung. Für eine genaue Grundlastmessung ohne Bots ist ein
eigenes Messfenster nötig; das Skript trennt laufende Accounts nicht dafür.

Für einen Mix aus Java und Bedrock die gemessenen Ressourcen beider Gruppen
und die zusätzliche Backend-/Hostlast berücksichtigen. Als erste RAM-Rechnung
auf derselben Maschine und unter vergleichbaren Bedingungen lässt sich mit
30 % Reserve planen:

```text
Bot-RAM-Budget = 0,70 × Gesamt-RAM − Grundlast ohne Bots
Accountzahl aus RAM ≈ Bot-RAM-Budget / gemessenes PSS pro Account
```

Die CPU muss die Zielzahl ebenfalls tragen. Dafür Gesamtlast, Wartezeiten,
CPU-Steal und Reaktionsfähigkeit prüfen. Mehr Accounts können andere Cache-,
I/O- und Lastmuster erzeugen; die Rechnung durch stufenweise Messungen
bestätigen. Geteilte Cloud-vCPUs und unterschiedliche CPU-Generationen erfordern
einen Vergleich auf dem Zielserver. Die RAM-Rechnung allein bestätigt keine
stabile Kapazität und beseitigt keine serverseitigen Account-/IP-Limits.

## Verifikation

- Backend-Produktionsbuild erfolgreich.
- Lokaler vollständiger Backend-Messlauf erfolgreich, alle 592 HTTP-Anfragen
  erfolgreich; produktive Daten und Minecraft-Verbindungen unverändert.
- Neun Python-Tests erfolgreich: Linux-Statfelder, PID-Wiederverwendung,
  CPU-Intervallrechnung und Gewichtung, PSS-Header/fehlende Werte,
  Prozessbaumbegrenzung und vollständiger Export mit simuliertem Linux-`/proc`.
- Der Linux-Sampler ist noch nicht auf dem echten Pi ausgeführt worden.

```bash
python3 -m unittest discover -s scripts/performance -p 'test_measure_host.py' -v
```
