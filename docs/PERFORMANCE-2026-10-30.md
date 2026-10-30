# Funktions- und Performanceprüfung vom 30.10.2026

Website, Backend und SoulFire-Anbindung wurden in getrennten Testumgebungen geprüft. Die gefundenen Fehler wurden behoben. Die Abschlussprüfungen sind erfolgreich; eine Garantie für sämtliche Serverzustände oder die Kapazität des produktiven Raspberry Pi ergibt sich daraus nicht.

Basis vor dieser Prüfung: `1ca040bf8a3cf1486775519cf565125123b1d08a`. Alle Rohdaten stehen unter [performance/audit-2026-10-30/](performance/audit-2026-10-30/). Es wurden ausschließlich synthetische Daten verändert. Bestehende Microsoft-Anmeldungen, Accountdaten und die lokale Vorschau wurden nicht für Schreibtests verwendet; gestoppte echte Accounts wurden nicht gestartet.

## Behobene Probleme

- **Lange Konsolen blockierten den Browser.** Die Konsole rendert nun die sichtbaren Zeilen mit Reserve. Bis zu 20.000 Zeilen bleiben im Speicher verfügbar, einschließlich Umbrüchen, Leseposition und automatischem Nachscrollen. Live-Nachrichten werden in 50-ms-Batches übernommen. In ausgeblendeten Browser-Tabs und im Einstellungs-/Kamera-Tab werden sie begrenzt gepuffert, ohne Konsolen-Updates auszulösen.
- **Später eintreffender Verlauf konnte Live-Zeilen überschreiben.** HTTP-/WebSocket-Verlauf und Live-Ereignisse werden chronologisch zusammengeführt und mit Berücksichtigung gleicher Nachrichten innerhalb einer Millisekunde dedupliziert. Persistierte und live versendete Ereignisse verwenden denselben Zeitstempel.
- **CleanSpawner konnte den nativen Aufruf nicht korrekt ausführen.** SoulFire benötigt eine Blockseite. Diese wird jetzt durch einen Raycast auf den erreichbaren Spawner bestimmt. Eine durch ein Serverplugin geöffnete GUI gilt auch dann als Bestätigung, wenn die Vanilla-Interaktion `PASS` meldet.
- **CleanSpawner behielt nur einen Stack über mehrere Itemtypen hinweg.** Jetzt bleibt ein Stack pro ausgewähltem Itemtyp bestehen. Fremde Items bleiben erhalten. Klicks warten auf eine bestätigte Änderung; ein fehlgeschlagener Transfer führt nicht mehr zu wiederholten Klicks und einer falschen Erfolgsmeldung. Verkaufsmeldungen können nach sofortigem Nachfüllen des Slots die Änderung bestätigen.
- **Layoutmessungen konnten unerwünschte Zwischenanimationen auslösen.** Die Erstberechnung und Größenkorrekturen erfolgen unmittelbar; die vom Nutzer ausgelöste Graph-Animation bleibt erhalten. Nach Größenänderungen folgt eine am Ende stehende Konsole weiter den neuesten Zeilen.
- **Abgelaufene Website-Sitzungen konnten weitere Verbindungsversuche verursachen.** Authentifizierungsfehler führen zurück zur Anmeldung. Fehlende Accountrechte beenden die betroffenen Socket-Wiederholungen. Eine verspätete Antwort aus einer älteren Anmeldung darf die neue Sitzung nicht abmelden. Ein falsch eingegebenes aktuelles Passwort wird weiterhin als Formularfehler angezeigt.
- **Fehlgeschlagener Logout war nicht sichtbar.** Die Website zeigt jetzt eine Fehlermeldung und erlaubt einen erneuten Versuch; parallele Klicks sind während des Requests gesperrt.
- **Ein defekter Kamera-Zuschauer konnte andere Zuschauer beeinträchtigen.** Fehler in dessen Versand- oder Fehlerbehandlung werden isoliert. Der gemeinsame Upstream wird beendet, sobald kein Zuschauer übrig ist.
- **Unbegrenzte oder ungültige Eingaben konnten unnötige Arbeit auslösen.** Zuweisungs-/Sortierlisten und Notizfreigaben sind begrenzt. Der Audit-Log-Endpunkt akzeptiert nur 1–1.000 Einträge pro Abruf und beantwortet ungültige Limits mit HTTP 400.
- **Abhängigkeiten und Prüfwerkzeuge:** Fastify, Zod, Vite und Vitest einschließlich betroffener transitiver Pakete wurden aktualisiert. `npm audit` meldet in beiden Projekten einschließlich Entwicklungsabhängigkeiten keine bekannten Schwachstellen. Die Linux-Installation mit `npm ci` wurde im Docker-Build geprüft. Veraltete Browserfixtures verwenden jetzt den SoulFire-Versionskatalog. Der Host-Sampler erkennt die gemeinsame SoulFire-JVM gesondert.

Die Zod-Aktualisierung berücksichtigt unter anderem [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5); die Typanpassung folgt dem [Zod-4-Migrationsleitfaden](https://zod.dev/v4/changelog). Die Konsole verwendet die [dynamische Virtualisierung von TanStack](https://tanstack.com/virtual/latest/docs/framework/react/examples/dynamic).

## Umfang und Ergebnisse

| Bereich | Prüfung und Ergebnis | Umgebung |
| --- | --- | --- |
| Automatisierte Tests | 442 Tests in 48 Dateien erfolgreich; unter anderem Accounts, Rechte, Authentifizierung, Commands, Verkauf, Neustarts, Notizen und SoulFire | Separate Testdatenbank; enthält auch Tests der vorhandenen Legacy-Module |
| Host-Sampler | 9 Tests erfolgreich; SoulFire als gemeinsame JVM statt als einzelner Account erkannt | Synthetisches Linux-`/proc` |
| Build und Codeprüfung | Backend-/Frontend-Build erfolgreich; Frontend-Lint ohne Fehler oder Warnungen; Backend-/Web-Docker-Build erfolgreich | macOS und Linux ARM64 |
| Vollständiger HTTP-Weg | 138 Requests über Caddy, darunter erwartete 400/401/403/404/409-Antworten; keine unerwarteten Fehler | Isolierter Docker-Stack mit 100 Offline-Accountdatensätzen, 20.000 Logs, 100.000 Verkäufen |
| Account-Einstellungen | Auto button LEFT/RIGHT/OFF, Sneak, Verkaufs-/Spawner-Einstellungen, Speicherung, Offline-Commandfehler | Echte API; Browser durchläuft alle Einstellungskategorien |
| Rechte und Verwaltung | Accountisolation, CSRF, letzter Admin, Benutzersperre/Sitzungsentzug, IP-Sperren, Audit-Logs | Echte API mit Admin und eingeschränktem Nutzer |
| Notizen | Erstellen/Lesen/Ändern/Löschen, Revisionkonflikte, Freigaben, Schreibrechte und private Notizen | Echte API; Editor/Lazy Loading zusätzlich im Browserfixture |
| Accountanlage | Java und Bedrock einzeln erstellen/löschen; keine automatische Anlage der anderen Edition | Echte API; ohne Microsoft-Autorisierung |
| Verlauf und Verdienst | Getrennte Logseiten mit Cursor; Summen und Graphbereiche 1h/6h/24h; Versionskatalog vom echten SoulFire-Dienst | Echte API |
| Dashboard und Bilder | 100 Karten, Suche/Übernahme eines Itembilds, persistierte Auto-button-Einstellung, Breiten 320/390/768/1280 ohne horizontalen Überlauf | Echter Browser, Backend und Caddy |
| Itemauswahl | 1.489 Items, normalisierte Suche und Auswahl auf Desktop/Mobil | Browserfixture |
| Private Ansichten | Kategorien, Reihenfolge, Unschärfe, Migration, getrennte Nutzer/Geräte, Schreibfehler und Wiederholung | Browserfixture, Breiten 320/390/768/1280 |
| Anmeldung und Navigation | Loginformular ohne blockierende Auth-Abfrage; Timeout hängender Logout-Bereinigung; Seiten, Dialoge und Graphen | Browserfixtures; erfolgreicher Login/Logout und Sitzungsausfall zusätzlich gegen echten Stack |
| Konsole | 2.000/20.000 Zeilen, Leseposition, Umbrüche, HTTP-Fallback, Reconnect-Verlauf, Commands, Entwurf nach Fehler, je 1.000 Nachrichten im verborgenen Tab und Einstellungstab | Browserfixtures |
| Native Steuerung und Verkauf | Vier Java-Testclients; Rechtsklick, Linksklick, Sneak ohne Loslassen, Teleports, manuelle Commands, nachgefüllte Verkaufsslots, unabhängiges Stoppen | Echter SoulFire-Dienst und isolierter Minecraft-Protokollserver |
| Native Spawner-/Multiplikatoraktionen | Neun ausgelesene Multiplikatoren, Drop/Sell, ein Reststack pro Typ, fremde Items erhalten, FIFO-Commands, Sneak bleibt gehalten | Echter SoulFire-Dienst und isolierter Minecraft-Protokollserver |
| Kamera | Echte Java-PNG-Frames 640×360; zwei Zuschauer, ein Upstream; Stop nach letztem Zuschauer | Echter SoulFire-Dienst und isolierter Minecraft-Protokollserver |
| Kamera-Oberfläche | Lazy Loading, Java-/Bedrock-Ansicht getrennt, Pause bei verborgenem Tab, Stop beim Tab-/Accountwechsel, offline kein Renderstream, mobil kein Überlauf | **Simulierte Frames und Accountzustände**; kein Live-Bedrock-Nachweis |

## Browsermessungen

Entwicklungs-Mac: Apple M3 Pro, 36 GiB RAM, 12 logische CPUs; Chrome 156.0.8078.74. Produktionsbuild über lokale Vite-Vorschau, APIs/Sockets für diese Vergleichsmessung simuliert. Die Zeiten beginnen mit der Zustellung der Testhistorie bzw. des Live-Ereignisses und enden bei der beobachteten DOM-Aktualisierung. Sie enthalten keine echte Server-/Internetlatenz und messen nicht den abschließenden Bildaufbau.

| Messung | Vorher | Nachher |
| --- | ---: | ---: |
| 2.000 historische Zeilen, erste Darstellung | 71,8 ms | 44,4 ms |
| 20.000 historische Zeilen, erste Darstellung | 1.274,3 ms | 81,0 ms |
| Live-Update bei 20.000 Zeilen, fünf Stichproben | 63,3–180,9 ms | 54,2–56,0 ms einschließlich 50-ms-Batch |
| Gerenderte Zeilen bei 20.000 gespeicherten Zeilen | 20.000 | 23 im gemessenen Fenster |
| Verschiebung der Leseposition nach neuer umbrochener Zeile | — | 0 px |
| Verlorene Nachrichten in den geprüften Hintergrund-Bursts | — | 0 |

Das Batching fügt auch bei kleinen Konsolen bewusst bis ungefähr 50 ms Wartezeit hinzu; dafür müssen Nachrichtenspitzen nicht für jedes Ereignis einen Renderdurchlauf auslösen. Bei 2.000 Zeilen war ein einzelnes Update vorher teilweise schneller. Dies ist keine behauptete Verbesserung jeder einzelnen Latenz.

Zusätzliche kurze Leerlaufmessung der 20.000-Zeilen-Konsole: 2,00 s, ungefähr 2,05 % eines CPU-Kerns für Browser-Tasks, 20,52 MiB belegter JS-Heap und keine Layoutdurchläufe im Messintervall. Das ist eine Momentaufnahme, kein Speicherleck-Dauertest. Der 100-Account-Ladetest zeigte das Loginformular nach 125 ms und das Dashboard nach 947 ms bei künstlich verzögerten APIs. Auch die Prüfung mit aktivierter Betriebssystemoption für reduzierte Bewegung war erfolgreich.

## Backend und Caddy

Ein separater Backend-Prozess wurde pro Phase 15 s gemessen, mit Node 24.13.0. Bei 100 Offline-Accountdatensätzen: im Mittel 235,9 MiB RSS und 0,18 % eines CPU-Kerns. Offline-Datensätze sind **keine verbundenen Minecraft-Clients**.

Unter ungefähr 20 HTTP-Requests/s und 20 zusätzlich persistierten Logzeilen/s wurden 296 Requests erfolgreich abgeschlossen: p95 **13,14 ms**, Maximum 19,44 ms, keine übersprungenen Lastbatches. Der Backend-Prozess benötigte im Mittel 13,26 % eines CPU-Kerns; RSS im Mittel 300,2 MiB, maximal 342,8 MiB. Die Eventloop-p95 von 21,56 ms wurde mit 20-ms-Messauflösung erhoben und darf nicht als gemessener 21-ms-Blocker interpretiert werden.

Im getrennten Test über den echten Caddy-Proxy wurden 80 Lastrequests mit Parallelität acht durchgeführt: p95 **28,84 ms**, Maximum **31,15 ms**, keine unerwarteten Fehler. Diese Messung enthält HTTP und Datenbank, aber keine Internet-/Cloudflare-Strecke und keinen Microsoft-Login.

## Native SoulFire-Messung

Vier Offline-Java-Clients liefen im isolierten Linux-ARM64-SoulFire-Dienst für eine zusätzliche Haltephase von 60 s. Insgesamt wurden 93 Transfers im Fixture bestätigt. Keine Warnungen oder Verbindungsfehler; vorhandenes Sneak wurde nicht gelöst. Hintergrundautomatisierung verwendete **null** Aufrufe des bildrendernden Inventory-RPCs und **null** POV-Aufrufe.

Während dieser Haltephase wurden 20 cgroup-Stichproben über ungefähr 20 s erfasst: im Mittel **2.086,2 MiB**, maximal **2.092,0 MiB** cgroup-Speicher, mittlere CPU **35,49 % eines Kerns**, keine OOM-Kills. cgroup-Speicher umfasst mehr als den Java-Heap. Diese Werte enthalten die gemeinsame Minecraft-/SoulFire-Basis und dürfen nicht durch vier geteilt als Verbrauch pro Account verkauft werden.

Das Fixture verwendet eine sehr kleine Welt mit einfachem Protokollverkehr. Echte Chunks, Entities, Serverplugins, Bedrock-Übersetzung, gleichzeitig geöffnete Kameras und laufende Serverneustarts können wesentlich teurer sein. Daraus folgt keine verlässliche maximale Accountzahl und keine Hetzner-Empfehlung.

## Wiederholen

Die Testwerkzeuge enthalten keine echten Zugangsdaten. Die folgenden festen Passwörter gehören ausschließlich zum lokal gebundenen, wegwerfbaren Audit-Stack. `docker-compose.audit.yml` verwendet eigene Volumes und schaltet bei den synthetischen Accounts `autoStart` aus. Die Seed-Datei verweigert andere Datenbankpfade und bereits gefüllte Accounttabellen.

```bash
docker compose -f docker-compose.audit.yml up -d --build --wait --wait-timeout 1200
docker compose -f docker-compose.audit.yml exec -T backend node scripts/seed-audit-fixture.mjs
docker compose -f docker-compose.audit.yml restart backend
node scripts/performance/full-stack-check.mjs
```

Nach dem Backend-Neustart dessen Healthcheck abwarten. Für Browsertests muss Playwright samt Chrome vorhanden sein; `PLAYWRIGHT_MODULE` kann auf eine externe Playwright-Installation zeigen:

```bash
AUDIT_URL=http://localhost:8082 node scripts/performance/full-stack-browser-check.mjs
```

Die simulierten UI-/Performanceprüfungen laufen gegen einen gebauten Frontend-Previewserver. Beispiele:

```bash
PERF_URL=http://127.0.0.1:4173 PERF_VERIFY=1 node scripts/performance/browser-check.mjs
UI_URL=http://127.0.0.1:4173 node scripts/ui/uploader-categories-check.mjs
UI_URL=http://127.0.0.1:4173 UI_FIXTURE=1 node scripts/ui/live-cam-check.mjs
```

`backend/scripts/audit-soulfire-actions.mjs` und `backend/scripts/smoke-soulfire.mjs` benötigen zusätzlich `minecraft-protocol`, eine vom SoulFire-Dienst erreichbare Fixture-Adresse und dessen RPC-Key. Sie legen eigene Offline-Testinstanzen an und löschen sie im Abschlussblock. Für den erweiterten Smoke-Test stehen `AFK_SMOKE_CLIENTS=4` und `AFK_SMOKE_SOAK_SECONDS=60` bereit. Diese Skripte nur an den isolierten Audit-Dienst anschließen.

Nach Abschluss lassen sich ausschließlich die Audit-Testdaten entfernen:

```bash
docker compose -f docker-compose.audit.yml down --volumes
```

## Grenzen und nächster belastbarer Produktionsnachweis

Nicht neu live geprüft wurden die Microsoft-Gerätecode-Autorisierung, eine echte Bedrock-Verbindung mit gültigen Microsoft-Tokens, HugoSMP-spezifische Neustartabläufe, die öffentliche Cloudflare-/TLS-Strecke und ein stunden-/tagelanger Betrieb auf deinem Pi. Reconnect-, Tokenfehler-, Neustart-, Sneak- und Rechtefälle werden automatisiert geprüft; das ersetzt diese Live-Prüfungen nicht. Das vorgeschlagene Update erhält Accountdaten und Login-Caches. Ein vom Anbieter widerrufener oder abgelaufener Token kann dennoch eine erneute Anmeldung erfordern.

Für belastbare Pi-Werte kann der vorhandene Host-Sampler zehn Minuten lang ausschließlich lesend laufen. Gleichzeitig die tatsächliche Zahl online verbundener Java-/Bedrock-Accounts und aktive Kameras notieren:

```bash
cd /opt/afk-service && sudo python3 scripts/performance/measure-host.py --duration 600 --label soulfire-live --output "/tmp/afk-soulfire-$(date +%Y%m%d-%H%M%S).json"
```

Der Sampler ändert keine Accounts, exportiert keine Kommandozeilen/Tokens und startet oder stoppt keine Clients. Für SoulFire `--backend-pid` weglassen, weil die gemeinsame JVM in einem eigenen Container läuft. Erst Messungen auf dem Zielgerät unter tatsächlicher Last erlauben eine sinnvolle Kapazitätsschätzung.
