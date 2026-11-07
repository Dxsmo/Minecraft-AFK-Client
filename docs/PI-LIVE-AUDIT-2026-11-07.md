# Produktive Pi-Diagnose vom 7. November 2026

Controls-Version 1.7.1; SoulFire bleibt auf dem checksum-gepinnten Release 2.10.6.
Die Untersuchung erfolgte über das bereits geöffnete RealVNC-Terminal. Private
Account- und Dienst-Logs, Anmeldedaten und lokale Verbindungsinformationen
gehören nicht ins Repository.

## Vor dem Update gemessen

Der Pi verwendete noch `d213b8e`, nicht die zuletzt veröffentlichte
AutoSell-/Disconnect-Korrektur `865c482`.

- 7,9 GiB Host-RAM, nur 618 MiB verfügbar, 1,3 GiB Swap belegt.
- SoulFire: etwa 6,1 GiB RSS und 398 % CPU auf vier Kernen.
- Java-Heap: 5.166.710 KiB von 5.373.952 KiB belegt. Auch ein Histogramm
  nach vollständiger Speicherbereinigung zeigt praktisch dieselbe Belegung.
- 739.456 dauerhaft erreichbare `BedrockEmotePlayback`-Callbacks,
  725.325 `IllegalStateException`-Objekte und 492.415 HTTP-Fehlerobjekte.
- Wiederholte RPC-Timeouts bei mehreren Accounts; Container wurden trotzdem
  als gesund gemeldet. Ein erreichbarer Health-Endpunkt beweist keine
  funktionierenden Spielticks.
- Beim vorherigen Backend-Start: SQLite `P1008` bei Status-/Autostart-Schreibvorgängen
  und schließlich beim Laden der IP-Sperren; danach Prozessneustart.
- Keine aktuelle Unterspannungs-/Temperaturdrosselung (`throttled=0x0`),
  kein vom Docker-Status gemeldeter OOM-Kill.

## Änderungen

Die eingebettete Bedrock-Erweiterung hält für die Emote-Auswahl einen globalen
Account. Bots wechseln ihn beim Ticken wiederholt und laden dabei den
Garderoben-/Emote-Katalog erneut. Der asynchrone Abschluss ruft
`Minecraft.getInstance().execute(...)` ohne den ursprünglichen Bot-Kontext auf.
Die Rückrufe bleiben dadurch im nicht getickten Basisclient liegen und halten
auch HTTP-Antworten und Fehler erreichbar. Das erklärt die gemessene Belegung;
eine bloße Vergrößerung des Heaps würde diese Warteschlange nicht begrenzen.

`HeadlessEmoteMixin` unterbindet diesen Katalog-Refresh im Bot-Kontext. Die
interaktive Emote-Auswahl ist keine Funktion der AFK-Weboberfläche.
Anmeldung, Skins, Spielprotokoll, normales Ticken und die native
Account-Automatisierung werden nicht umgebaut.

Der Backend-Client verwendet für SQLite standardmäßig eine Verbindung mit
30 Sekunden Busy-/Pool-Timeout; explizite URL-Parameter bleiben erhalten.
WAL wird vor dem Start der Bots aktiviert. Die Bedeutung von `socket_timeout`
als SQLite-Busy-Timeout dokumentiert die
[Prisma-Engine](https://prisma.github.io/prisma-engines/doc/quaint/single/struct.Quaint.html).
Die IP-Sperren werden vor dem Autostart geladen, und das Wiederaufnehmen eines
bereits aktivierten Accounts schreibt seine unveränderte Autostart-Absicht
nicht erneut. Der Backend-Healthcheck erlaubt langsamen Erststarts 180 Sekunden;
erfolgreiche Prüfungen melden den Dienst weiterhin sofort bereit.

## Prüfung vor dem Ausrollen

- Backend kompiliert; alle 522 Tests in 57 Dateien bestanden.
- Neuer SQLite-Test mit eigenem externen Schreibprozess: Leser bleiben unter
  WAL verfügbar, eine sechs Sekunden gehaltene Schreibsperre wird abgewartet,
  danach bleiben alle 48 konkurrierend angeforderten Updates erhalten.
- Native Erweiterung gegen das gepinnte Release kompiliert und in einer
  getrennten Linux-/Java-25-SoulFire-Instanz gestartet.
- Zwei echte Clients gegen einen lokalen Testserver: jeweils 10.000
  Item-Entities, 36 nachgefüllte Stacks, 120 ms Serverantwortverzögerung,
  Inventarsperre und anschließende Verkaufsfortsetzung. Bei eingestellten
  zwei Sekunden: gemessene Verkaufsabstände 2006–2047 ms, 520 bestätigte
  Transfers, höchstens 16 unbestätigte Transfers, separater Account-Stopp
  ohne Unterbrechung des anderen Clients.

Der gezielte Gegenversuch verwendet ausschließlich eine synthetische,
uninitialisierte Authentifizierungsidentität: Es werden keine echten Konten
oder Microsoft-Anmeldedaten benötigt und keine erfolgreichen Katalogzugriffe
vorausgesetzt. 1.000 Refresh-Aufrufe aus einem echten Bot-Kontext hinterlassen
ohne Korrektur 999 Kataloganforderungen und 999 Rückrufe im Basisclient;
mit Korrektur sind beide Werte null.
[Negativkontrolle](performance/pi-live-audit-2026-11-07/emote-negative-control.json),
[Korrektur](performance/pi-live-audit-2026-11-07/emote-fixed.json).

Reproduzierbar mit `soulfire/test/build-emote-probe.py` und
`backend/scripts/smoke-emote-memory.mjs` in einer **frischen, getrennten**
SoulFire-Testinstanz. `--without-fix` baut die Negativkontrolle;
`EXPECT_EMOTE_LEAK=1` prüft deren erwarteten Fehler. Die Test-JAR enthält einen
zusätzlichen Diagnose-Einstiegspunkt und gehört niemals auf den produktiven Pi.

## Produktives Ausrollen und anschließende Kontrolle

Der funktionale Stand `f0c48a5` wurde auf dem Pi mit vorhandenen Docker-Caches
gebaut und installiert. Vorher wurden die bisherigen Images markiert sowie
Backend-Daten, SoulFire-Zustand und die bestehende `.env` privat gesichert.
Ein Rückweg auf die vorherigen Images wurde vorbereitet, aber nicht benötigt.

Für den gemessenen 8-GiB-Pi wurde der Java-Heap auf höchstens 4 GiB begrenzt;
rotierende GC-Logs ermöglichen spätere Kontrollen. Danach: WAL aktiv,
Busy-Timeout 30.000 ms, Website HTTP 200, Backend und SoulFire gesund und ohne
zusätzlichen Containerneustart. Alle elf zuvor aktivierten Accounts wurden
wieder aufgenommen; die übrigen 20 blieben gestoppt. Die Prüfung erfasste alle
31 Accounts und 531.735 aufbewahrte Logzeilen.

Um 14:30 Uhr waren alle elf Accounts online. Die jeweiligen Spielzustands-RPCs
antworteten in 8–122 ms. Bei `sirogane1124` und `TQQ_MIKU` wurden in den letzten
drei Minuten 32 bzw. 24 Auszahlungen bestätigt. Aktivierte Verkäufer mit leerem
Inventar werden nicht als Verkaufsfehler gewertet.

Nach dem Start wurden 3,4–4,1 GiB verfügbarer Host-Speicher statt vorher
618 MiB gemessen. Ein späteres Histogramm enthielt nur einzelne statische
Emote-Lambdas, keine anwachsende Rückrufschlange. Der Heap lag bei der zweiten
Stichprobe bei etwa 1,1 GiB statt zuvor etwa 5 GiB. Das ist ein Vergleich mit
Neustart; die zusätzliche Negativkontrolle belegt separat die Codekorrektur.

Die CPU bleibt unter elf aktiven Clients zeitweise nahe vier ausgelasteten
Kernen. Das kurze JFR-Profil zeigt vor allem Paket-/Protokollverarbeitung,
Minecraft-Spielzustand und Bedrock-Lichtberechnung. Diese verbleibende Last
wird nicht als behoben ausgegeben. Zu Beginn wies der Spielserver mehrere
gleichzeitige Anmeldungen zurück; die vorhandene Wiederverbindung nahm diese
Accounts nach der Serverwartezeit wieder auf.

## Zusätzlich belegter Verkaufsstopp

Beim Account `weqrtsad` war die native Automatik aktiviert und ihre Lease
gültig; das volle Spielerinventar wurde trotzdem nicht verkauft. Der laufende
Zustand zeigte ein offenes Verkaufsmenü ohne native Menüzuordnung, während
keine Anfrage mehr als ausstehend galt. Ein einmaliges Schließen behob nur
den aktuellen Zustand; nach dem nächsten verspäteten Menü trat er erneut auf.

Der Backend-Controller hatte die Servermeldung über ein gesperrtes Inventar
zusätzlich in `sell-manual-until` geschrieben. Diese Einstellung ist aber für
echte Benutzerbefehle reserviert: Trifft ein bereits aufgegebenes natives
Verkaufsmenü während dieses Fensters ein, wird es absichtlich nicht automatisch
geschlossen. Danach bleibt es als fremdes Menü stehen. Die native Erweiterung
behandelt die Servermeldung bereits direkt im Spielthread mit eigener
endlicher Fehlerpause. Die doppelte Backend-Pause entfällt; echte manuelle
Befehle behalten ihren Schutz.

Der Integrationstest verzögert die erste Menüantwort um vier Sekunden und
sendet nach 3,6 Sekunden 365 Inventarsperr-Meldungen. Mit dem vorherigen Backend
bleiben alle Transfers aus und der Test läuft in sein Zeitlimit. Mit der
Korrektur schließt der Client die verspätete Antwort, verkauft selbständig
weiter und bestätigt 196 Transfers. Nach der Fehlerpause liegen die
Verkaufsabstände wieder bei 2000–2042 ms; der andere Account bleibt verbunden.
[Negativkontrolle](performance/pi-live-audit-2026-11-07/late-menu-negative-control.json),
[Korrektur](performance/pi-live-audit-2026-11-07/late-menu-fixed.json).

Ein begrenzter Testlauf ist keine Zusage gegen spätere Spielserver-,
Authentifizierungs- oder Netzwerkausfälle.
