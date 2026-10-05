# Performance-Prüfung und Command-Korrekturen – V1.6.1

Stand: 06.10.2026. Vergleichsbasis: Commit `dc04bc9`.

Geprüft wurden Produktions-Build, Seitenladen, Live-Konsole, längere Log-Historie,
Command-Versand, SQLite-Abfragen, Log-Aufbewahrung, Polling, WebSocket-Verteilung
und die Auswirkungen auf beide Bot-Engines.

## Messungen

Die Messungen liefen lokal auf dem Entwicklungs-Mac mit Node 24 und Chrome
154.0.8037.98. Browser-API und WebSockets waren mit Testdaten simuliert. Der
Datenbanktest verwendete ausschließlich eine separate `performance.db` mit
20.000 Log-Zeilen und 100.000 Verkäufen. Es wurden keine Minecraft-Accounts
verbunden und keine Produktionsdaten verändert.

| Vorgang | Vorher | Nachher | Ergebnis |
| --- | ---: | ---: | --- |
| Verdienstabfrage, Median aus 8 Aufrufen | 230,72 ms | 24,15 ms | ca. 90 % weniger Zeit |
| Log schreiben bei 20.000 Zeilen, Median aus 50 Aufrufen | 3,13 ms | 2,37 ms | ca. 24 % weniger Zeit |
| 2.000 Logs aus SQLite laden, Median aus 20 Aufrufen | 5,10 ms | 5,44 ms | keine Verbesserung; kleine Schwankung |
| Neue Zeile bei 2.000 angezeigten Logs, Median aus 5 Updates | 47,0 ms | 1,6 ms | ca. 97 % weniger Zeit |
| Neue Zeile bei 20.000 angezeigten Logs, Median aus 5 Updates | 486,3 ms | 97,0 ms | ca. 80 % weniger Zeit |
| Erste Darstellung von 2.000 Logs, Einzelmessung | 497,9 ms | 54,6 ms | deutlich schneller |
| Erste Darstellung von 20.000 Logs, Einzelmessung | 2.034,2 ms | 1.170,9 ms | weiterhin ein schwerer Sonderfall |
| JavaScript-Einstiegspaket, gzip | 98,17 kB | 76,73 kB | ca. 22 % kleiner |

Die Paketgröße betrifft das Einstiegspaket. Die zusätzlich benötigte Seite wird
anschließend separat geladen; die Summe aller Seiten wird dadurch nicht kleiner.
Die Browserzeiten messen die DOM-Aktualisierung, nicht die gesamte Netzwerkzeit
oder den abschließenden Bildaufbau. Die Rohdaten stehen in
[performance/](performance/). Kleine Stichproben und lokale Messungen erlauben
keine Aussage über maximale Account-Zahlen oder den Arbeitsspeicherverbrauch auf
einem Raspberry Pi. Live-Server, Cloudflare/CDN und Containerbetrieb wurden hier
nicht gemessen.

## Umgesetzte Änderungen

- **Konsole:** Zeilen werden einzeln mit `React.memo` gespeichert. Unveränderte
  Zeilen und ihre Zeitstempel werden bei neuen Nachrichten nicht neu berechnet.
  Der Zeitformatierer wird wiederverwendet. Die 20.000 gespeicherten Zeilen,
  Umbrüche und das Nachladen in Seiten zu 2.000 Zeilen bleiben erhalten.
- **Verdienst:** SQLite summiert die drei Zeitfenster direkt in Cent. Der
  Backend-Prozess lädt dafür keine Liste sämtlicher Verkäufe mehr. Abgelaufene
  Einträge werden beim Start und stündlich entfernt, unabhängig von geöffneten
  Account-Seiten. Die Abfrage selbst schreibt nichts. Bestehende Zähler werden
  durch dieses Update nicht erneut zurückgesetzt.
- **Log-Aufbewahrung:** Ein SQL-Löschvorgang ersetzt Zählen, Auslesen und Löschen.
  Ein Index über Account, Zeit und ID unterstützt die eindeutige Sortierung.
  Die Migration ändert ausschließlich einen Index; sie löscht keine Accounts
  oder Log-Historie.
- **Seitenladen:** Seiten werden bei Bedarf geladen. Caddy erlaubt langes Caching
  für Dateien mit Inhaltshash; HTML wird erneut validiert. Die Caddy-Konfiguration
  wurde geprüft, aber hier nicht in einem laufenden Container ausgeführt.
- **Leeres Inventar:** Java meldet keinen fehlgeschlagenen Verkaufsversuch, wenn
  sowohl beim Start als auch beim Timeout keine Items bekannt sind. Java und
  Bedrock begrenzen Kontrollversuche bei bekannt leerem Inventar auf mindestens
  30 Sekunden Abstand. Neue Items werden wieder im eingestellten Verkaufstakt
  verarbeitet. Bedrock protokolliert nicht mehr jeden automatischen `/sell`.
- **Manuelle Commands:** Versand erfolgt über den vorhandenen HTTP-Endpunkt mit
  Berechtigungsprüfung und Fehlerantwort. Der Browser leert das Feld erst nach
  erfolgreicher Übergabe. Eine geschlossene WebSocket-Verbindung verhindert den
  Versand nicht mehr. Beide Bot-Engines geben manuellen Commands Vorrang und
  behalten ihre Reihenfolge bei. Hintergrundabfragen bleiben separat eingeordnet.
  Die HTTP-Bestätigung bestätigt die Übergabe an den Bot-Prozess; ob der
  Minecraft-Server einen Command akzeptiert, zeigt weiterhin dessen Antwort.

## Weitere Einsparungsmöglichkeiten

- **Sehr lange Konsole:** Bei vollständig geladenen 20.000 Zeilen bleiben viele
  DOM-Elemente bestehen. Virtualisierung könnte weiter sparen, müsste jedoch
  variable Zeilenhöhen, Umbrüche, Scrollposition und ältere Seiten zuverlässig
  behandeln. Das aktuelle Update behält diese Funktionen und begrenzt den
  ersten Abruf weiterhin auf 2.000 Zeilen.
- **Status speichern:** `ClientManager` schreibt den Status auch bei gleichbleibendem
  Status erneut, beispielsweise bei Gesundheitsmeldungen. Eine deduplizierte,
  geordnete Speicherung könnte Schreiblast senken. Sie wurde wegen möglicher
  Auswirkungen auf Neustart- und Wiederverbindungszustände nicht verändert.
- **Inventarprüfung im Java-Bot:** Die Signatur wird auf jedem Tick geprüft und
  nur bei Änderungen als Snapshot ausgegeben. Weniger Prüfungen könnten CPU
  sparen, würden aber die Anzeige verzögern. Die Tickfrequenz bleibt unverändert.
- **WebSockets:** Berechtigungsprüfungen für Live-Dashboard-Ereignisse verursachen
  zusätzliche Abfragen bei normalen Nutzern. Ein Cache müsste entzogene Rechte
  zuverlässig berücksichtigen; dafür wurde keine Abfrage eingespart.
- **Polling:** Die Verdienstanzeige fragt alle 15 Sekunden ab. Das Admin-Inventar
  wird nur im geöffneten Inventar-Tab alle 2,5 Sekunden abgefragt. Die Intervalle
  bleiben erhalten. Ein Hintergrund-Tab könnte später seltener abfragen, ohne
  Bot-Ticks zu ändern.

Sneaken, Wiederverbindung, Weltwechsel-Erkennung, Watchdog und geplante
Spawner-Aufgaben erhalten ihre bisherigen Zeitabläufe. Die Einsparungen im
Browser und bei Datenbankabfragen verändern diese Abläufe nicht.

## Verifikation und Wiederholung

Erfolgreich geprüft: 139 Backend-Tests, 18 Rust-Tests, beide TypeScript-Builds,
Vite-Produktions-Build und Frontend-Lint. Der Linter meldet vier bestehende
Warnungen in unveränderten Dateien. Die Rust-Prüfung lief lokal mit
`RUSTC_BOOTSTRAP=1 cargo +stable test --locked --bins`; der Linux-Containerbuild
mit dem im Dockerfile gepinnten Nightly wurde hier nicht ausgeführt.

Regressionstests prüfen unter anderem manuelle Commands während eines blockierten
Sell-Menüs, FIFO-Reihenfolge, leere und neu gefüllte Inventare, fehlgeschlagene
Bot-Pipes, Pipe-Backpressure, langsame Menüantworten, Teleports, Lobby/Weltrückkehr,
Sneak-Wiederherstellung, Cent-Summen und Log-Aufbewahrung. Der Browsertest prüft
`/tpahere Steve` und `/home` bei geschlossener WebSocket-Verbindung, sichtbare
Fehler und erhaltene Eingaben bei HTTP-Fehlern, `V1.6.1` sowie die Leseposition
bei neuen umgebrochenen Zeilen und beim Nachladen älterer Logs.

Datenbank-Benchmark, aus `backend/`:

```sh
DATABASE_URL='file:../data/performance.db' NODE_ENV=test npx prisma migrate deploy
DATABASE_URL='file:../data/performance.db' NODE_ENV=test node --import tsx scripts/benchmark-performance.ts
```

Browser-Prüfung benötigt separat installiertes Playwright und Google Chrome.
Playwright wurde für diese Prüfung außerhalb des Repositorys installiert.
Zunächst den Produktions-Build erstellen und über Vite Preview auf Port 4173
bereitstellen; dann aus dem Projektverzeichnis:

```sh
PLAYWRIGHT_MODULE=/pfad/zu/node_modules/playwright PERF_VERIFY=1 node scripts/performance/browser-check.mjs
```

Der Datenbank-Benchmark verweigert eine nicht als Test konfigurierte Datenbank.
Er entfernt seine eigenen Testdaten abschließend. Die Browser-Prüfung simuliert
alle API-Aufrufe und verbindet keine Minecraft-Accounts.

## Update auf dem Host

Backend und Website gemeinsam neu bauen, damit das neue interne Command-Protokoll
in Node und Bot-Binary übereinstimmt. Die Datenbankmigration wird durch den
bestehenden Containerstart angewendet. Laufende Accounts werden beim Backend-Neustart
kurz getrennt und über die bereits vorhandene Auto-Start-Logik wieder aufgenommen.

```sh
git pull --ff-only
docker compose up -d --build --force-recreate backend web
```
