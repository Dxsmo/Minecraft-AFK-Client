# Ladezeiten und Performance – 11.10.2026

Prüfbasis: Commit `5e7360d`; die Vorher-Messungen stammen aus dem unveränderten
Arbeitsstand zu Beginn dieser Prüfung. Die Rohdaten
liegen unter [performance/](performance/) in den vier Dateien `loading-*-before.json`
und `loading-*-after.json`.

## Änderungen

- **Accounts:** Das Dashboard fordert mit `?view=dashboard` nur seine benötigten
  Felder an. Zuweisungslisten und Verhaltenseinstellungen werden erst für die
  Detailseite geladen. Der bisherige vollständige Listenabruf bleibt verfügbar.
  Die erste WebSocket-Statusmeldung löst keinen zweiten Listenabruf mehr aus;
  nach einer Wiederverbindung wird die Liste weiterhin aktualisiert.
- **Darstellung:** Einzelne Account-Karten werden memoisiert. Statusmeldungen,
  Hover und Verkäufe zeichnen unveränderte Karten nicht erneut. Account-Bilder
  außerhalb des sichtbaren Bereichs werden verzögert geladen. Ein verspäteter
  Detailabruf kann beim Wechsel zwischen Accounts nicht den neuen Account ersetzen.
- **Login:** Die Login-Seite wartet auch bei vorhandenem CSRF-Cookie nicht auf
  das Löschen der vorherigen Sitzung. Diese Bereinigung läuft im Hintergrund;
  eine Anmeldung wartet auf ihren Abschluss oder ihren Timeout von drei Sekunden,
  damit eine verspätete Logout-Antwort keine neue Sitzung überschreibt.
  React StrictMode startet diese Aktion nur einmal. Die Login-Seite ist im
  Einstiegspaket enthalten, und das Dashboard wird während der Anmeldung geladen.
  Argon2-Parameter, CSRF-Prüfungen und das Abmelden beim Neuladen bleiben erhalten.
- **Graphen:** Browser und Backend speichern ausschließlich abgeschlossene
  Fünf-Minuten-Intervalle, begrenzt auf jeweils 256 Einträge. Cache-Schlüssel
  unterscheiden Account und Zeitraum; die nächste Intervallgrenze erzwingt neue
  Daten. Bestätigte Verkäufe invalidieren den Backend-Cache, Änderungen und
  Sitzungswechsel den Browser-Cache. HTTP-Abrufe prüfen weiterhin die aktuellen
  Berechtigungen. Achsen, Linien und Zeitbeschriftungen werden beim Bewegen des
  Zeigers wiederverwendet; Datums- und Zahlenformatierer werden einmal angelegt.
- **Datenabfragen:** Gleichzeitige identische GETs teilen eine Netzwerkanfrage.
  Ein einzelner abgebrochener Leser unterbricht andere Leser nicht. Abrufe und
  Änderungen haben einen Timeout von 20 Sekunden (Logout: drei Sekunden).
  Reguläre Account-, Benutzer- und Einstellungsdaten
  werden nicht als fertige GET-Antworten gecacht.
- **Polling:** Verdienst, ausgeklappte Detailgraphen, Item-Werte und Minigame-Daten
  pausieren im Hintergrund und aktualisieren sich beim Zurückkehren. Der nächste
  Timer beginnt nach Abschluss des vorherigen Abrufs. Langsame Minigame-Antworten
  werden damit nicht mehr alle fünf Sekunden abgebrochen und neu gestartet.
- **Live-Dashboard:** Meldungen innerhalb von 25 ms werden pro Account gebündelt.
  Der Batch prüft Sitzung und aktuelle Zuweisungen einmal. Es gibt keinen Cache
  für Berechtigungen; entzogene Rechte wirken beim nächsten Batch. Ein Test mit
  200 Statusmeldungen prüft die neueste Meldung und den Ausschluss eines zuvor
  entzogenen Accounts bei einer Sitzungs- und einer Zuweisungsabfrage.
- **Schreiblast:** Lebens-/Hungerwertänderungen schreiben keinen unveränderten
  Lifecycle-Status in SQLite. Tatsächliche Statuswechsel werden in Reihenfolge
  gespeichert; ein fehlgeschlagener Schreibvorgang kann erneut versucht werden.
  Konsolen- und Sniper-Logs werden innerhalb von 25 ms gesammelt, in Paketen von
  maximal 200 Zeilen gespeichert und einmal pro betroffenem Account bereinigt.
  Pro Writer läuft nur eine Transaktion; zwischen Paketen erhalten interaktive
  Abfragen Gelegenheit, die Datenbank zu nutzen. Die Persistenz-Promise erfüllt
  sich erst nach dem Commit. Fehler einzelner gelöschter Accounts verlieren keine
  Zeilen anderer Accounts. Beim geordneten Shutdown werden Restpakete geschrieben.
- **SQLite:** Neue Indizes unterstützen Account-Sortierung, case-insensitive
  Benutzersuche, Sitzungs- und Verkaufsaufbewahrung und Sniper-Logs. Der Index für
  Verkaufsabfragen enthält den Betrag, sodass SQLite die Aggregation aus dem
  Index lesen kann. Kleine Berechtigungsprüfungen laden keine vollständigen
  Account-Beziehungen mehr. Öffentliche Texturen prüfen keine unnötige Sitzung.
  Außerdem verbrauchen die öffentlichen, unveränderlichen Icons nicht länger
  das gemeinsame API-Limit von 200 Requests/Minute: große Preislisten können
  Login, Accounts und Graphen damit nicht über ihre Bildabrufe ausbremsen.
- **Pakete:** Der Notiz-Editor wird erst beim Öffnen einer Notiz geladen.
  Account-Einstellungen und der Erstellungsdialog werden ebenfalls erst bei
  Bedarf geladen. Die Darstellung der jeweiligen Listen/Konsolen startet vorher.
  Beim Laden einer neuen Seite bleiben Navigation und Kopfzeile sichtbar.
- **Konsole:** Live-Zeilen werden über 25 ms gebündelt autorisiert; jede Zeile
  wird weiterhin einzeln und in Reihenfolge übertragen. Bei fehlendem initialem
  WebSocket-Verlauf startet nach 1,5 Sekunden ein HTTP-Ersatzabruf. Zwischenzeitlich
  eingetroffene Live-Zeilen bleiben erhalten und werden nicht doppelt angezeigt.
- **Start und Diagnose:** Veraltete Bot-Statuswerte werden mit je einer
  Sammelaktualisierung zurückgesetzt. HTTP-Antworten enthalten `Server-Timing`
  mit der Backend-Laufzeit; Anfragen über eine Sekunde werden als `Slow HTTP request`
  mit Route, Dauer und Status protokolliert. Der Netzwerktest misst Dokument,
  Einstiegsskript, CSS und öffentliche API-Antworten einschließlich DNS/TLS/TTFB.

## Nachprüfung bei Verzögerungen auf allen Seiten

Ein zusätzlicher Test stellt 2.000 Log-Schreibvorgänge und anschließend 20 echte,
authentifizierte Fastify-Account-Anfragen gleichzeitig an. Zehn Testaccounts haben
bereits je 20.000 Zeilen. Die bisherige Variante erzeugt eine Transaktion pro
Zeile; der neue Writer bündelt die gleiche Last. Der Test verwendet eine separate
`contention-performance.db`, verbindet keine Bots und schreibt keine Produktionsdaten.
Er reproduziert SQLite-Timeouts und mehrere Sekunden blockierte API-Abfragen in
der bisherigen Variante. Rohdaten: [loading-contention.json](performance/loading-contention.json).

| Bei 2.000 gleichzeitig eintreffenden Zeilen | Einzeltransaktionen | Gebündelt |
| --- | ---: | ---: |
| Account-Antwortzeit, Median | 5.474,86 ms | 7,67 ms |
| Account-Antwortzeit, p95 | 5.481,51 ms | 8,48 ms |
| Dauer bis Abschluss aller Schreibvorgänge | 5.554,75 ms | 461,83 ms |
| Erfolgreich gespeicherte neue Zeilen | 1.995 | 2.000 |
| Schreib-Timeouts | 5 | 0 |

Im Browser wird außerdem ein vorhandenes CSRF-Cookie gesetzt und die Logout-Antwort
entweder um 1,5 Sekunden verzögert oder vollständig blockiert. In beiden Fällen
erscheint das Login-Formular lokal nach etwa 90 ms. Die anschließende Anmeldung
wartet geordnet auf Bereinigung bzw. Timeout und funktioniert in beiden Fällen.
Rohdaten: [loading-auth-startup.json](performance/loading-auth-startup.json).
Der Konsolen-Ersatztest liefert keinen WebSocket-Verlauf, aber Live-Zeilen; er
prüft genau einen HTTP-Abruf, vollständigen Verlauf und keine doppelten Live-Zeilen.
Rohdaten: [loading-console-fallback.json](performance/loading-console-fallback.json).
Die erneut erfolgreichen Seiten- und Konsolenprüfungen stehen in
[loading-browser-recheck.json](performance/loading-browser-recheck.json) und
[loading-console-recheck.json](performance/loading-console-recheck.json).

Diese Tests belegen die lokalen Blockaden und ihre Behebung. Eine Aussage über
60 Sekunden auf dem Live-Host erfordert dessen URL und eine dortige Messung.

## Messungen

Die folgenden Einzelmessungen stammen aus der ersten Prüfrunde, vor Einführung
der gebündelten Log-Schreibvorgänge. Einzelne Log-Promises benötigen dadurch jetzt
zusätzlich etwa 25 ms Sammelzeit; die obige Lastmessung prüft die Auswirkung auf
interaktive Abfragen unter gleichzeitiger Last.

SQLite: separate `performance.db`, 100 zugewiesene Accounts, 100.000 Verkäufe,
20.000 Konsolenzeilen. Median aus 8 bis 50 Wiederholungen mit einem Aufwärmabruf.
Es wurden keine Minecraft-Accounts verbunden und keine Produktionsdaten geändert.

| Vorgang | Vorher | Nachher |
| --- | ---: | ---: |
| 100 Dashboard-Accounts aus SQLite | 3,05 ms | 1,13 ms |
| JSON für 100 Accounts, ohne Live-Snapshots und Kompression | 70.891 Bytes (vollständige Form) | 24.691 Bytes (Dashboard-Form) |
| Verdienstsummen bei 100.000 Verkäufen | 31,52 ms | 14,23 ms |
| 24h-Graph, ohne Cache-Treffer | 50,02 ms | 31,36 ms |
| 24h-Graph, wiederholter Service-Aufruf im selben Intervall | 50,02 ms | < 0,01 ms |
| Log schreiben bei 20.000 Zeilen | 2,89 ms | 2,11 ms |
| 2.000 Logs lesen | 6,96 ms | 7,18 ms |

Die Cache-Zeit betrifft den Service-Aufruf und enthält weder HTTP noch die
weiterhin erforderlichen Berechtigungsprüfungen. Die JSON-Größen vergleichen
beide Antwortformen mit denselben Nachher-Testdaten. Die Log-Lesezeit verbessert
sich nicht; kleine Unterschiede liegen innerhalb der lokalen Schwankungen.
Die gespeicherten [SQLite-Abfragepläne](performance/loading-query-plans.json)
bestätigen die Verwendung der neuen Indizes, einschließlich des Covering-Index
für Verkäufe und des NOCASE-Index für Benutzernamen.

Browser: Chrome, Produktions-Build, 100 simulierte Accounts, künstlich 100 ms
API-Verzögerung und 800 ms für den früheren Start-Logout. Prüfszenarien messen
Anmeldeformular, Login→Dashboard, Graphen und Interaktionen. Die Browserdaten
werden vollständig simuliert; sie messen keine echte Passwortprüfung.

- Accounts beim ersten Dashboard-Aufruf: **2 → 1 Netzwerkanfrage**.
- Wechsel `1h → 24h → 1h` und erneutes Öffnen: **3 → 1 Anfrage für den 1h-Graph**.
- Graph-Interaktion: vorher etwa **16 ms** pro DOM-Aktualisierung; nachher unter
  **1 ms**. Vorher wurden pro Interaktion 386 Datumstexte erneut formatiert.
- Ein verborgenes Tab löst im geprüften Zeitraum keine Verdienstabfragen aus;
  nach dem Sichtbarwerden werden diese erneuert.
- Eine künstlich blockierte Minigame-Antwort wird auch nach mehreren
  Polling-Intervallen nicht erneut gestartet.

Einzelmessungen der gesamten Seitenladezeit schwanken mit Build-Caches und
parallel laufenden Prüfungen. Die Rohdaten enthalten diese Zeiten ausdrücklich;
eine allgemeine Beschleunigung sämtlicher Seitenladezeiten lässt sich daraus
nicht ableiten. Live-Host, Raspberry Pi, Cloudflare und Netzwerk wurden nicht
vermessen. Bei verbleibenden Verzögerungen dort sind die Antwortzeiten und die
Serverlast die nächste Messstelle.

Produktionspakete, gzip: Dashboard **8,06 → 6,85 kB**, Account-Detailseite
**9,62 → 5,93 kB**, Notizliste **129,26 → 1,64 kB**. Der Editor bleibt mit etwa
128 kB ein separates Paket. Der Einstieg wächst durch die sofort verfügbare
Login-Seite von **77,53 auf 79,14 kB**. Die Gesamtmenge aller Funktionen wird durch
diese Aufteilung nicht entsprechend kleiner.

## Verifikation

406 Backend-Tests in 38 Dateien erfolgreich, beide TypeScript-Builds und
Frontend-Lint erfolgreich. Der Linter meldet zwei bestehende Warnungen
(`ErrorBoundary` und der Export von `useAuth`). Browser-Prüfungen kontrollieren
Graph-Wechsel, Hintergrund-Polling, langsame Antworten und die Seitenwechsel.
Die Konsolenprüfung kontrolliert außerdem erhaltene Scrollposition, ältere Logs,
manuelle Commands bei geschlossenem WebSocket und erhaltene Eingaben bei Fehlern.
Ein zusätzlicher Belastungstest lädt 225 Icons mit Sitzungscookie und prüft danach
einen erfolgreichen geschützten Account-Abruf, ohne Sitzungsabfragen für die Icons.

Reproduzieren aus `backend/`:

```sh
DATABASE_URL='file:../data/performance.db' NODE_ENV=test npx prisma migrate deploy
DATABASE_URL='file:../data/performance.db' NODE_ENV=test node --import tsx scripts/benchmark-performance.ts
npm test
npm run build
```

Aus `frontend/` zuerst `npm run build` und `npm run preview -- --port 4175` starten.
Danach aus dem Projektverzeichnis, mit separat installiertem Playwright/Chrome:

```sh
PLAYWRIGHT_MODULE=/pfad/zu/playwright PERF_URL=http://127.0.0.1:4175 PERF_VERIFY=1 node scripts/performance/loading-check.mjs
PLAYWRIGHT_MODULE=/pfad/zu/playwright PERF_URL=http://127.0.0.1:4175 PERF_VERIFY=1 node scripts/performance/browser-check.mjs
PLAYWRIGHT_MODULE=/pfad/zu/playwright PERF_URL=http://127.0.0.1:4175 node scripts/performance/auth-startup-check.mjs
PLAYWRIGHT_MODULE=/pfad/zu/playwright PERF_URL=http://127.0.0.1:4175 node scripts/performance/console-fallback-check.mjs
```

Lastmessung aus `backend/` mit Testkonfiguration:

```sh
DATABASE_URL='file:../data/contention-performance.db' NODE_ENV=test npx prisma migrate deploy
DATABASE_URL='file:../data/contention-performance.db' NODE_ENV=test node --import tsx scripts/benchmark-contention.ts
```

Netzwerkmessung aus dem Projektverzeichnis, ohne Anmeldung oder Nutzdatenänderung:

```sh
node scripts/performance/network-check.mjs https://DEINE-DOMAIN
```

Eine schnelle `app;dur` bei hoher `firstByteMs` grenzt die Wartezeit auf die
Auslieferung vor/nach dem Backend ein; eine hohe `app;dur` zeigt Wartezeit im
Backend. `/api/auth/me` antwortet ohne Cookie erwartungsgemäß mit 401.

## Aktivieren

Backend und Frontend zusammen neu bauen. Die zwei neuen Migrationen ergänzen
Indizes und ersetzen bestehende Indizes; sie löschen keine Nutzdaten. Der
Containerstart wendet die Migrationen wie bisher an. Der Neustart trennt laufende
Bots kurzzeitig; die vorhandene Auto-Start-Logik nimmt sie wieder auf.

```sh
docker compose up -d --build --force-recreate backend web
```
