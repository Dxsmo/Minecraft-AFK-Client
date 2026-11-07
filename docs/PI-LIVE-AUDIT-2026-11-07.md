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

- Backend kompiliert; bestehende Backend-Tests geprüft.
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

Ein begrenzter Testlauf ist keine Zusage gegen spätere Spielserver-,
Authentifizierungs- oder Netzwerkausfälle.
