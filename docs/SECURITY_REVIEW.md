# Sicherheitsprüfung der Website – V4.2.0

Stand: 08.10.2026. Geprüft wurden Website-Frontend, HTTP-/WebSocket-API,
Authentifizierung, Account-/Notizrechte, Uploads, Audit-Logs, Node-Abhängigkeiten
und die lokale Caddy-Konfiguration. Die folgenden Funde wurden behoben und mit
Regressionstests abgesichert.

## Gefundene und behobene Probleme

| Fund | Auswirkung vorher | Behebung |
| --- | --- | --- |
| Fremde Accounts im ersten Dashboard-Socket-Snapshot | Normale Nutzer konnten fremde Minecraft-Statusdaten einschließlich aktiver Microsoft-Device-Codes erhalten. | Initiale Daten und Live-Ereignisse nach aktuellen Zuweisungen filtern. |
| Veraltete Socket-Berechtigungen | Offene Verbindungen konnten trotz abgelaufener/widerrufener Session oder entzogener Rechte weiter Daten liefern bzw. Commands annehmen. | Session und Rechte vor jeder Aktion erneut prüfen; Logout/Session-Reset schließen bestehende Sockets sofort. |
| Ersteller konnte Zugriff wiederherstellen | Frühere Account-Ersteller konnten sich nach einem Rechteentzug wieder selbst zuweisen. | Auch Ersteller brauchen eine aktuelle Account-Zuweisung zur Freigabeverwaltung. |
| Fehlende Origin-/CSRF-Prüfung für Website-Sockets | Zusätzliche Absicherung gegen fremde Webseiten und unberechtigte Socket-Commands fehlte. | Origin-Allowlist, Session-CSRF für Socket-Commands, Eingabevalidierung; Logout ebenfalls mit CSRF. |
| Proxy-Geheimnisse im Audit-Log | Name-Sniper-Proxy-Einstellungen wurden zusätzlich unverschlüsselt protokolliert. | Rekursive Bereinigung neuer Einträge; Migration entfernt Proxy-Werte aus alten betroffenen Einträgen. |
| Unbegrenztes Vertrauen in Forwarding-Header | Bei direkt erreichbarem Backend konnten öffentliche Clients ihre IP für Login-Limits und Sperren fälschen. | Vertrauen auf konfigurierte Proxy-Netze begrenzt; Spoofing-Regressionstest besteht. |
| Unterschiedlicher Login-Rechenaufwand | Unbekannte Nutzernamen wurden ohne Passwortprüfung abgewiesen, was gültige Namen leichter erkennbar machte. | Argon2-Prüfung auch für unbekannte Nutzer; einheitliche Fehlermeldung. |
| Verwundbare Node-Abhängigkeiten | Der erste Scan meldete 14 betroffene Backend-Laufzeit-Pakete, darunter hohe/kritische Advisories; dies beweist keine Ausnutzbarkeit in der App. | Kompatible Updates und gezielte Overrides; abschließende Scans beider Lockfiles ohne bekannte Advisories. |

Zusätzlich: Nachrichtengröße, Command-Rate, Warteschlangen und Sendepuffer
begrenzt; abgewiesene Socket-Upgrades sauber geschlossen; private API-Antworten
nicht gecacht; CSP/Browser-Sicherheitsheader ergänzt; Umgebungsdatei-Varianten
aus Git und Docker-Build-Kontexten ausgeschlossen.
Origin-/Cache-Prüfungen verwenden die tatsächlich erkannte Route, damit
URL-kodierte Schreibweisen wie `/ws/%64ashboard` die Schutzmaßnahmen ebenfalls
durchlaufen; diese Varianten sind im Regressionstest enthalten.

## Zugangsdaten und Account-Trennung

In den geprüften öffentlichen HTTP-Antworten wurden keine Website-Passwörter,
Passwort-Hashes, Minecraft-Passwörter oder Microsoft-Refresh-Tokens gefunden.
Explizite Antwortfelder schließen diese Werte aus. Der WebSocket-Fund betraf
unter anderem Microsoft-Device-Codes: Auch diese sind sensibel. Eine
Untersuchung eines tatsächlichen Einbruchs wurde nicht durchgeführt.

Manipulierte Account-IDs, fremde Konsolen/Bilder, unzulässige Rechteänderungen
und Admin-Endpunkte werden serverseitig abgewiesen. Admins dürfen absichtlich
alle Minecraft-Accounts bedienen. Private Notizen haben eigene Freigaben, auch
gegenüber anderen Admins; Leserechte erlauben kein Schreiben. Die Nutzernamen
in Freigabe-Auswahllisten sind beabsichtigt sichtbar.

PNG-Uploads werden geprüft und neu kodiert; Notizen verwenden eine Struktur-/
Link-Allowlist. Die geprüften Anwendungspfade verwenden Prisma-Parameterbindung
und React-Text-Escaping.

## Nachweise

- **283 Backend-Tests in 22 Dateien bestanden unter Node 20.20.2**, einschließlich
  15 neuer Website-Sicherheitstests und bestehender Notiz-, Upload- und
  Minigame-Berechtigungstests.
- Backend-TypeScript-Build und Prisma-Generierung erfolgreich.
- Frontend-Produktionsbuild und ESLint erfolgreich; vier bereits bestehende
  Warnungen, keine Fehler.
- `npm audit` für Backend und Frontend: **0 bekannte Sicherheitslücken**, auch
  für Entwicklungsabhängigkeiten, zum Prüfzeitpunkt.
- Node-20-Smoke-Test: Archive-Download mit Hashprüfung/Entpacken, MSAL-Token-Cache
  und nativer Bedrock-Transport erfolgreich.
- Caddy-Konfiguration mit Caddy 2.11.7 validiert. Browser-Test der gebauten
  Website hinter lokalem Caddy: Login, Notiz-Editor, Dashboard-Sockets und
  V4.2.0-Badge funktionieren mit der CSP; keine Script-/CSP-Fehler.
- Lokale Anfragen nach `.env`, `.env.production`, `.git/config` und Datenbankpfaden
  liefern nur die statische SPA, keine Geheimnis-/Datenbankdateien.
- Legacy-Audit-Bereinigung mit Testdatensatz nachgewiesen; Migration lokal
  angewendet. Auf dem Pi läuft sie beim üblichen `prisma migrate deploy`
  während des Backend-Starts.

## Grenzen und Anforderungen für den Pi

Der Raspberry Pi und die öffentliche Domain wurden nicht direkt geprüft.
HTTPS, Cloudflare-Regeln, Firewall, produktive Cookie-/Origin-Konfiguration,
Host-Zugriffe und ein ARM64-Docker-Build sind damit nicht verifiziert. Dies ist
eine Code- und lokale Laufzeitprüfung, kein unabhängiger Penetrationstest.
Rust-/Minecraft-Protokollstack und Betriebssystempakete wurden nicht vollständig
auf Sicherheitslücken untersucht. Ein leerer npm-Scan garantiert keine
Fehlerfreiheit.

Öffentlich müssen `PUBLIC_ORIGIN` und `CORS_ORIGINS` die tatsächliche
HTTPS-Adresse enthalten und `SESSION_COOKIE_SECURE=true` gelten. Port 4000
bleibt intern. `TRUSTED_PROXIES` enthält nur die erforderlichen Proxy-Netze.
Die Cloudflare/Caddy-Kette muss Client-IPs sicher weitergeben; sonst können
Limits/Sperren mehrere Besucher gemeinsam treffen. Die produktive Proxy-Kette
wurde hier nicht getestet.

Host-/Docker-Administratoren können Datenbank und Microsoft-Token-Cache lesen.
Alte Backups/exportierte Logs werden durch die Migration nicht rückwirkend
bereinigt. Waren diese unbefugt zugänglich, sollten die betroffenen
Proxy-Zugangsdaten erneuert werden.

Minecraft-Account-Bediener dürfen Verbindungsziele ändern. Das ermöglicht
ausgehende TCP-Verbindungen auch zu internen Hosts. Bei nicht vertrauenswürdigen
Bedienern sind Account-Rechte allein daher keine Netzwerkisolation; dafür sind
separate Egress-Regeln erforderlich.

Referenzen:
[OWASP WebSocket Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html)
und [Caddy Reverse Proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#headers).
