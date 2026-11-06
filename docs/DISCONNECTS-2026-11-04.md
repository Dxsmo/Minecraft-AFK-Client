# Gleichzeitige Account-Disconnects

Der gemeldete Fehler `connect ECONNREFUSED 172.19.0.4:38765` betrifft den
gemeinsamen SoulFire-RPC-Dienst. Er ist kein Minecraft-Kickgrund und belegt,
dass zu diesem Zeitpunkt keine RPC-Verbindung zu dieser Adresse möglich war.
Der Ausschnitt beginnt bereits bei fehlgeschlagenen Wiederverbindungsversuchen;
der ursprüngliche Auslöser fehlt. Ein JVM-Absturz, OOM-Kill, geplanter Neustart
oder eine andere Unterbrechung lässt sich damit noch nicht unterscheiden.
Deaktiviertes AutoSell umgeht den gemeinsamen Dienst nicht.

## Behobener zusätzlicher Disconnect-Pfad

Die Wiederholung des Ereignisstreams allein reichte nicht: Nach mehr als
45 Sekunden ohne Spielzustands-Heartbeat konnte der Online-Watchdog weiterhin
den Minecraft-Bot stoppen, auch wenn nur die RPC-Verbindung ausgefallen war.

Fehlgeschlagene unabhängige Statusabfragen melden jetzt eine unerreichbare
Steuerverbindung. Erkannte Transportfehler, RPC-Zeitüberschreitungen und
Serverfehler mit `UNKNOWN`, `INTERNAL` oder `RESOURCE_EXHAUSTED`
setzen den Watchdog vorübergehend aus. Jede Ausnahme gilt 15 Sekunden und muss
durch neue fehlgeschlagene Abfragen erneuert werden. Bleibt der Controller
selbst hängen, läuft die Ausnahme aus. Die Website zeigt währenddessen den
zuletzt bestätigten Accountstatus und eine Warnung; der aktuelle Spielzustand
ist bis zur Wiederherstellung der Steuerverbindung unbekannt.

Nach Rückkehr des Dienstes wird die bestehende Verbindung geprüft. Ein vorher
verbundener, inzwischen gestoppter oder nicht mehr vorhandener Bot beendet die
Session ausdrücklich und verwendet den bestehenden Reconnect-Ablauf. Bestätigte
Minecraft-Disconnects und Berechtigungsfehler werden weiterhin behandelt.

Diese Änderung verhindert den zusätzlichen, vom Watchdog ausgelösten Logout.
Sie kann bei einem tatsächlich beendeten SoulFire-Prozess keine bestehenden
Minecraft-Sockets erhalten. Der genaue Auslöser der unten beschriebenen
Datenbank-Timeouts und des Prozessneustarts bleibt offen. Es wurden keine
Heaplimits auf Verdacht verändert.

## Nachgereichte Produktionslogs

Die gezielten Logs zeigen vor dem Neustart `SQLTransientConnectionException`
aus `HikariPool-1`: Anfragen auf eine Datenbankverbindung liefen nach etwa
64 Sekunden in einen Timeout. `GetBotInfo` und `SetBotsDesiredState` erreichten
Gesamtlaufzeiten von über 110 Sekunden. SoulFire lieferte dabei unter anderem
gRPC `UNKNOWN` ohne Fehlerbeschreibung zurück. Solche fehlgeschlagenen
Statusabfragen melden jetzt ebenfalls eine gestörte Steuerverbindung, statt
den Watchdog mangels Heartbeat einen Logout auslösen zu lassen.

Am 04.11.2026 startete der Prozess um 07:37:58 Uhr deutscher Zeit erneut;
die RPC-Bereitschaft ist erst um 07:39:25 Uhr protokolliert. Das erklärt die
zwischenzeitlichen `ECONNREFUSED`-Antworten. Wer oder was den Prozess neu
startete, geht aus diesem Ausschnitt nicht hervor.

Die nachgereichte Ausgabe von `uptime -s` bestätigt einen **Host-Neustart um
07:37:11 Uhr**. Dieser konkrete Ausfall war somit nicht auf einen einzelnen
Minecraft-Account oder nur den SoulFire-Prozess beschränkt. Die Ursache des
Host-Neustarts ist noch unbekannt. Die aktuelle Momentaufnahme zeigt 1,2 GiB
verfügbaren RAM und etwa 1 GiB belegten Swap bei 7,9 GiB RAM. Das beweist weder
einen damaligen OOM-Kill noch laufendes Swap-Thrashing. `0B / 0B` in Docker
Stats liefert hier keine verwertbare Speichermessung für die einzelnen Dienste.

Die vorherige Kernel-Abfrage mit `journalctl -k` beschränkte sich standardmäßig
auf den aktuellen Boot. Ihre leere Ausgabe schließt daher einen Fehler vor dem
Host-Neustart nicht aus. Für die weitere Diagnose werden die letzten Einträge
und Kernel-Meldungen des vorherigen Boots (`-b -1`) sowie `--list-boots`
benötigt. Siehe [journalctl-Dokumentation](https://www.freedesktop.org/software/systemd/man/latest/journalctl.html).

Der [geprüfte Quellstand 2.10.6](https://github.com/soulfiremc-com/SoulFire/blob/2.10.6/mod/src/main/java/com/soulfiremc/server/database/DatabaseManager.java)
verwendet für SQLite eine gemeinsame Pool-Verbindung. Unsere AutoSell-Freigabe
schreibt alle fünf Sekunden über `updateBotConfigEntry`; dieser
[RPC persistiert die komplette Instanzkonfiguration](https://github.com/soulfiremc-com/SoulFire/blob/2.10.6/mod/src/main/java/com/soulfiremc/server/grpc/BotServiceImpl.java).
Diese Last wird untersucht, ist aber als Auslöser der langen Wartezeiten nicht
nachgewiesen. Der Pool-Timeout allein unterscheidet keine langsamen Datenträger,
JVM-/Host-Pausen oder blockierenden Datenbankoperationen. Auch der separate
`invalid_grant`-Fehler nach dem Start erklärt keinen gemeinsamen Prozessneustart.

## Daten vom betroffenen Host

Direkt nach einem Ausfall im Projektverzeichnis ausführen:

```bash
bash scripts/diagnose-disconnects.sh 2h > /tmp/afk-disconnects.txt
```

Alternativ einen absoluten Beginn mit Zeitzone übergeben, beispielsweise
`2026-11-04T07:30:00+01:00`. Das Skript liest Containerzustand, Neustartzähler,
Speicherlimits, cgroup-OOM-Zähler, Docker-Ereignisse und höchstens 500 Logzeilen.
Es startet, stoppt und konfiguriert keine Dienste und gibt keine Container-
Umgebungsvariablen oder Account-Caches aus. In Logs enthaltene Anmeldecodes vor
Weitergabe entfernen. Bei großer Logmenge den Zeitraum enger wählen.

`State.OOMKilled` und cgroup-Zähler allein sind keine vollständige Historie:
frühere Neustarts, ein neuer Container oder ein Docker-Daemon-Neustart können
Informationen verlieren. Auf Linux zusätzlich den Host-Startzeitpunkt (`uptime -s`)
prüfen und bei einem Host-Neustart ausdrücklich die Logs des vorherigen Boots
auswerten: `journalctl -b -1 -k`. `journalctl --list-boots` zeigt, welche Boots
noch gespeichert sind. Ohne gespeicherte Logs des vorherigen Boots ist dessen
Ursache rückwirkend eventuell nicht mehr feststellbar.
Absturz und normalen Stop anhand der Ereignisse und Logs unterscheiden; bei
normalem Stop auch geplante Updates/Backups prüfen. `backup-stack.sh` stoppt
für eine konsistente Sicherung ausdrücklich SoulFire und Backend.

## Prüfung und Einspielen

Regressionstests simulieren mehr als eine Minute RPC-Ausfall mit und ohne
AutoSell, zwei gleichzeitig betroffene Accounts, Wiederherstellung ohne
Neuanmeldung, abgelaufene Watchdog-Ausnahmen, echte Disconnects und einen
nach dem Ausfall gestoppten/fehlenden Bot. Das ersetzt keinen mehrstündigen
Test auf dem betroffenen Produktionshost.

Die Laufzeitänderung benötigt einen Backend-Neubau. Das bestehende Update-
Skript baut den Stack und spielt die Änderungen ein:

```bash
bash scripts/update.sh
```

Das Einspielen startet die geänderten Dienste neu und unterbricht dabei laufende
Accounts einmalig. Die Datenvolumes bleiben erhalten.
