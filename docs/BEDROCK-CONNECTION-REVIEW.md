# Bedrock-Verbindungsprüfung – 9. Oktober 2026

## Umfang

Verglichen wurden die heutigen Änderungen (`86fc8ec`, letzter Git-Stand vom
8. Oktober, bis `60646ac`) und der vollständige Verbindungsweg: Account-Daten,
Supervisor, Subprozess, Microsoft-Session, UDP-Discovery, RakNet, Join,
Crouch/AutoSell sowie Website-Sicherheitsregeln. Die neuen Graphen, Avatare,
WebSocket-Ereignisse und Datenbankmigrationen wurden auf Wechselwirkungen mit
diesem Weg geprüft. Der tatsächlich gestern auf dem Raspberry eingesetzte
Commit ist nicht bekannt; Git-Zeitpunkte sind keine Deployment-Nachweise.

## Bestätigter Fehler und Korrektur

Beim Beenden von Minecraft- und Name-Sniper-Prozessen wurde `child.killed`
als Bestätigung des Prozessendes verwendet. Node setzt dieses Flag bereits,
wenn ein Signal erfolgreich gesendet wurde. Ignoriert ein Prozess `SIGTERM`
oder hängt er im nativen Transport fest, wurde die nachfolgende
`SIGKILL`-Eskalation deshalb übersprungen. Ein alter Prozess konnte weiterlaufen,
während der Supervisor einen neuen startete.

Die gemeinsame Funktion `backend/src/utils/terminateSubprocess.ts` prüft jetzt
das tatsächliche Prozessende über `exit`/`close`, `exitCode` und `signalCode`.
Nach 500 ms Grace-Period folgt `SIGTERM`, nach weiteren 1500 ms nötigenfalls
`SIGKILL`. Bei bestätigtem Prozessende werden Timer und Listener entfernt.
Tests stellen außerdem sicher, dass ausschließlich der alte Prozess und nicht
dessen Ersatz signalisiert wird. Ein echter Testprozess, der `SIGTERM`
absichtlich ignoriert, wird erfolgreich mit `SIGKILL` beendet.

Dieser Fehler bestand bereits vor den heutigen Änderungen. Die Verkürzung
des Reconnect-Abstands auf 15 Sekunden kann bei solchen hängenden Prozessen
deren Ansammlung beschleunigen. Ob das auf dem Raspberry tatsächlich passiert
ist oder ein Schutzsystem von HugoSMP ausgelöst hat, wurde nicht nachgewiesen.
Der ausdrücklich gewünschte Reconnect-Abstand bleibt bei 15 Sekunden.

## Weitere Prüfergebnisse

- **Website-Sicherheit:** IP-Sperren, Login-Limits, CSRF, CORS und Origin-Prüfung
  wirken auf eingehende HTTP-/WebSocket-Anfragen. Sie konfigurieren keine
  Firewall und verändern weder UDP-Sockets noch globale DNS-/Netzwerkeinstellungen.
  Die betreffenden Sicherheitseinstellungen wurden heute nicht geändert.
- **Zugangsdaten:** Das Entfernen alter gespeicherter Minecraft-Passwörter
  löscht weder den pro Account getrennten Microsoft-Token-Cache noch Accounts.
  Die Website-Verschlüsselung für Name-Sniper-Proxies wird im Bedrock-Verbindungsweg
  nicht verwendet. Die gemeldeten Sessions authentifizieren bereits erfolgreich.
- **Abhängigkeiten und Docker:** Heute wurden weder die Produktionsabhängigkeiten
  beziehungsweise Lockfiles noch die Dockerfiles oder Compose-Netzwerke geändert.
  `bedrock-protocol` bleibt auf 3.58.2; auch der native RakNet-Backendwechsel
  ist keine heutige Änderung.
- **Crouch:** Die heutigen Änderungen betreffen Sneak-Rückmeldungen,
  Release/Press-Resynchronisation und das moderne Input-Flag-Format. Der
  Tick-Pfad sendet bei ausstehendem Initial-Join keine Spielpakete, auch nicht
  bei aktivem AutoSell, ausstehenden Commands oder einem Crouch-Check. Das ist
  zusätzlich mit dem echten Paket-Codec über drei simulierte Minuten getestet.
  Der regelmäßige 50-ms-Input-Tick existierte schon gestern.
- **Verbindungsaufbau:** Heute wurden konkrete Protokollauswahl statt falscher
  Auto-Fallback-Version, Festhalten am konfigurierten Port, getrennte
  Fortschritts-Timeouts und UDP-Discovery ohne nativen Ping-Peer eingeführt.
  Die zuerst gemeldete Störung seit 13:40 liegt vor den Git-Commits zum
  Port-/Timeout-Fix (14:47) und zum Versions-/Discovery-Fix (16:09).
- **Neue UI-Funktionen:** Hover-Graphen und Avatare rufen Website-Endpunkte auf.
  Sie starten oder stoppen keinen Minecraft-Bot automatisch. Avatar-Downloads
  haben eine feste Ziel-Domain, Timeout und Größenlimit; Graphabfragen prüfen
  Account-Zugriff und sind in Zeitbereich und Ergebnisgröße begrenzt.

## Netzwerkbefunde und offene Ursache

Der unabhängige Diagnosetest nutzt nur Node-Standardbibliotheken, keinen
Microsoft-Login und keinen Crouch-Code. Sowohl im bestehenden Backend-Container
als auch mit einem frischen Node-Image und Host-Networking antwortet
`HugoSMP.net:19132` (`40.223.14.205`) auf die Statusabfrage mit Protokoll 2193,
aber auf die vier ersten Handshake-Proben kommt kein gültiges
`OpenConnectionReply1`. Bei MTU 576 wird stattdessen Paket-ID `0x84` beobachtet.
Ein normaler Windows-Bedrock-Client im selben Internet scheitert ebenfalls mit
`InitialConnection-13`, Transport `RakNet:2193`.

Damit ist ein Fehler ausschließlich im laufenden Website-Container oder
Crouch-Pfad keine ausreichende Erklärung. Server-/Proxy-Probleme,
Netzwerkfilter, eine IP-bezogene Sperre und eine gemeinsame Protokollproblematik
sind noch nicht eindeutig voneinander getrennt. Der Prozessabbruch-Fix ist
kein Nachweis, dass der aktuelle RakNet-Timeout damit behoben ist. Ein Vergleich
des Originalclients über mobile Daten und gegebenenfalls ein anderer
Bedrock-Server bleibt sinnvoll; für eine bestätigte Serversperre wären
serverseitige Logs nötig.

## Validierung

- Backend-Build unter Node 20 erfolgreich.
- Vollständige Backend-Suite nach der Prozess-Korrektur: 383 Tests bestanden.
- Danach ergänzte fünf Regressionstests sowie die betroffenen vorhandenen
  Tests: 78 Tests bestanden. Insgesamt 388 unterschiedliche Backend-Tests
  erfolgreich ausgeführt.
- Rust-Suite mit der gepinnten Nightly vom 11. August: 47 Tests bestanden.
- Frontend-TypeScript-Prüfung und Produktionsbuild erfolgreich.
- `npm audit --omit=dev` meldet aktuell für Backend und Frontend jeweils
  null bekannte Schwachstellen. Dies ist keine Garantie für Fehlerfreiheit.

## Raspberry aktualisieren

```sh
cd /opt/afk-service
git pull --ff-only
docker compose build backend
docker compose up -d --force-recreate backend
```

Das Neuerstellen des Backend-Containers beendet auch eventuell noch vorhandene
alte Bot-Prozesse. Die Minecraft-Accounts und Token-Caches liegen weiter im
persistenten Docker-Volume. Ein erfolgreicher Live-Join nach dem Update wurde
noch nicht bestätigt.
